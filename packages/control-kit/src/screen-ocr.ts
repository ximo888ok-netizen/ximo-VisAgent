// screen_ocr、wait_for 和 look_close 工具实现（从 executor.ts 拆出，遵守 400 行上限）
import type { ToolResult } from '@ximo-visagent/agent-core';
import { readImageSize } from '@ximo-visagent/llm-providers';
import { getHost } from './host';
import { ocrRecognizeAll } from './ocr-lookup';

/** screen_ocr：读取屏幕指定区域的全部文字（不做关键词过滤） */
export async function screenOcr(args: Record<string, unknown>): Promise<ToolResult> {
  const host = getHost();
  try {
    const hasRegion = args.x != null && args.y != null && args.w != null && args.h != null;
    const screenshot = hasRegion && typeof host.captureRegion === 'function'
      ? await host.captureRegion(Number(args.x), Number(args.y), Number(args.w), Number(args.h))
      : await (host.captureCleanScreen?.() ?? host.captureScreen());
    const dims = readImageSize(screenshot) ?? { width: 1920, height: 1080 };
    const hits = await ocrRecognizeAll(screenshot, dims);
    if (!hits || hits.length === 0) {
      return { ok: true, summary: 'OCR 未识别到文字（区域可能为空白/图片/非文字内容）' };
    }
    const lines = hits.map((h) => `"${h.text}" (${h.x},${h.y})`);
    const summary = `识别到 ${hits.length} 行文字: ${lines.slice(0, 20).join('; ')}${hits.length > 20 ? '...' : ''}`;
    return { ok: true, summary, data: { lines: hits.map((h) => ({ text: h.text, x: h.x, y: h.y, w: h.w, h: h.h })) } };
  } catch (err) {
    return { ok: false, summary: '', error: `screen_ocr 失败: ${(err as Error).message}` };
  }
}

/** wait_for：等待条件满足（text_appear / window_title / screen_stable / idle） */
export async function waitFor(args: Record<string, unknown>): Promise<ToolResult> {
  const condition = String(args.condition ?? 'idle');
  const timeoutMs = Number(args.timeoutMs ?? 10_000);
  const host = getHost();
  const start = Date.now();
  const POLL_INTERVAL = 500;
  const STABLE_ROUNDS = 3;

  if (condition === 'idle') {
    await sleep(timeoutMs);
    return { ok: true, summary: `固定等待 ${timeoutMs}ms` };
  }

  if (condition === 'window_title') {
    const target = String(args.title ?? '').toLowerCase();
    if (!target) return { ok: false, summary: '', error: 'wait_for window_title 需要 title 参数' };
    while (Date.now() - start < timeoutMs) {
      const info = await host.getForegroundInfo().catch(() => null);
      if (info && info.title.toLowerCase().includes(target)) {
        return { ok: true, summary: `窗口标题匹配: "${info.title}"（${Date.now() - start}ms）` };
      }
      await sleep(POLL_INTERVAL);
    }
    const info = await host.getForegroundInfo().catch(() => null);
    return { ok: false, summary: `超时（${timeoutMs}ms）当前窗口: ${info?.title ?? '未知'}`, error: `wait_for window_title 超时，未匹配到含"${args.title}"的窗口标题` };
  }

  if (condition === 'text_appear') {
    const target = String(args.text ?? '').toLowerCase();
    if (!target) return { ok: false, summary: '', error: 'wait_for text_appear 需要 text 参数' };
    while (Date.now() - start < timeoutMs) {
      const screenshot = await host.captureScreen().catch(() => null);
      if (screenshot) {
        const dims = readImageSize(screenshot) ?? { width: 1920, height: 1080 };
        const hits = await ocrRecognizeAll(screenshot, dims).catch(() => null);
        if (hits && hits.some((h) => h.text.toLowerCase().includes(target))) {
          return { ok: true, summary: `文字"${args.text}"已出现（${Date.now() - start}ms）` };
        }
      }
      await sleep(POLL_INTERVAL);
    }
    return { ok: false, summary: `超时（${timeoutMs}ms）文字"${args.text}"未出现`, error: 'wait_for text_appear 超时' };
  }

  if (condition === 'screen_stable') {
    let lastSig: string | null = null;
    let stableCount = 0;
    while (Date.now() - start < timeoutMs) {
      const screenshot = await host.captureScreen().catch(() => null);
      if (screenshot) {
        const sig = quickBufHash(screenshot);
        if (sig === lastSig) {
          stableCount++;
          if (stableCount >= STABLE_ROUNDS) {
            return { ok: true, summary: `画面已稳定（连续 ${STABLE_ROUNDS} 次无变化，${Date.now() - start}ms）` };
          }
        } else {
          stableCount = 0;
          lastSig = sig;
        }
      }
      await sleep(POLL_INTERVAL);
    }
    return { ok: false, summary: `超时（${timeoutMs}ms）画面持续变化中`, error: 'wait_for screen_stable 超时' };
  }

  return { ok: false, summary: '', error: `wait_for 未知条件: ${condition}` };
}

/** look_close：放大区域截图（返回 base64 图片给 executor） */
export async function lookClose(args: Record<string, unknown>): Promise<ToolResult> {
  const x = Number(args.x);
  const y = Number(args.y);
  const w = Number(args.w);
  const h = Number(args.h);
  if (![x, y, w, h].every(Number.isFinite)) return { ok: false, summary: '', error: 'look_close 需要 x/y/w/h（截图坐标）' };
  const host = getHost();
  if (typeof host.captureZoom !== 'function') return { ok: false, summary: '', error: '宿主不支持区域放大，请回退看图点击' };
  try {
    const cw = Math.max(80, Math.min(800, w));
    const ch = Math.max(80, Math.min(800, h));
    const { jpeg, zoom } = await host.captureZoom(x, y, cw, ch);
    return {
      ok: true,
      summary: `区域 (${Math.round(x)},${Math.round(y)}) ${Math.round(cw)}x${Math.round(ch)} 已放大 ${zoom.toFixed(1)}x（见附图）。看图估计坐标后 mouse_click`,
      image: jpeg.toString('base64'),
    };
  } catch (err) {
    return { ok: false, summary: '', error: `look_close 失败: ${(err as Error).message}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 快速 Buffer 哈希（FNV-1a 32bit），用于 wait_for screen_stable 判断画面是否变化 */
function quickBufHash(buf: Buffer): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i += 7) {
    h = Math.imul(h ^ buf[i]!, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${buf.length}`;
}
