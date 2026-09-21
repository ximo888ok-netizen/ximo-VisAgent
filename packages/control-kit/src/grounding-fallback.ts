// 执行器辅助（从 executor.ts 拆出，executor 达行数上限后的落点）：
// 前台窗口查询 + 视觉定位降级链（SoM 编号选择 → 自由 grounding + zoom 精修 → OCR 兜底）
// + 视觉结果直点。纯搬迁不改语义；执行链引用 RefToolCtx（点击侧共用）。
import type { SomCandidate, ToolResult } from '@ximo-visagent/agent-core';
import { readImageSize } from '@ximo-visagent/llm-providers';
import type { UiTreeResult } from '@ximo-visagent/shared-types';
import { getHost, type HostCapabilities } from './host';
import type { ClickGuard } from './click-guard';
import { STABLE_MAX_WAIT_MS, waitForStableFrame } from './stable-frame';
import { collectCandidates, filterForegroundCandidates, somMismatchNote, zoomedBoxToScreen } from './ui-locate';
import { ocrLookupTool, ocrRecognizeAll, type OcrHit } from './ocr-lookup';
import { detectIconRegions, ICON_DETECT_MAX, type IconBox } from './icon-detect';
import { fmtCoord } from './coord-normalize';
import type { ExecutorDeps } from './executor';

/** 开应用/双击后等"见效"的退回固定等待（无稳定观测能力时），与 executor 同值 */
const OPEN_EFFECT_WAIT_MS = 400;

/** SoM 候选上限与 label 截断 */
const SOM_CANDIDATE_LIMIT = 200;
const SOM_LABEL_MAX = 24;

/** 执行器注入的上下文：点击链与降级链共用（executor.ts 里构造，保持 this 状态不外泄） */
export interface RefToolCtx {
  deps: ExecutorDeps;
  uiTree(): Promise<UiTreeResult>;
  mouseClick(args: Record<string, unknown>): Promise<ToolResult>;
  guard: ClickGuard;
  clickCounts: Map<string, number>;
  overlay(ev: { type: 'click' | 'drag' | 'type' | 'scroll'; x?: number; y?: number; toX?: number; toY?: number }): void;
  host(): HostCapabilities;
}

/** 前台窗口标题（取不到 = null；不抛错） */
export async function foregroundTitle(): Promise<string | null> {
  try {
    const info = await getHost().getForegroundInfo();
    return info?.title ?? null;
  } catch {
    return null;
  }
}

/** 双击后的前台窗口变化反馈（无变化 = 可能被遮挡或没打开，模型不必盲试）：
 *  窗口已切换则提前结束等待；未切换时等到画面收敛再下"未变化"结论（上限 2.5s 有界） */
export async function foregroundDelta(before: string | null): Promise<string> {
  const st = await waitForStableFrame({
    maxWaitMs: STABLE_MAX_WAIT_MS,
    earlyExit: async () => {
      const now = await foregroundTitle();
      return now !== null && now !== before;
    },
  });
  if (st.rounds === 0) await sleep(OPEN_EFFECT_WAIT_MS); // 无稳定观测能力 → 旧的固定等待
  const after = await foregroundTitle();
  if (after && after !== before) return `；前台窗口已切换: ${after}`;
  return `；前台窗口未变化 (${after ?? '未知'})——目标可能被遮挡或未打开，勿原地重试`;
}

/** grounding 降级：拿干净截图（无网格）→ SoM 编号选择（首选）→ 自由 bbox（兜底）→ OCR 文字定位（最终兜底） */
export async function groundingLookup(ctx: RefToolCtx, query: string): Promise<ToolResult | null> {
  if (!ctx.deps.grounding && !ctx.deps.somLookup) return ocrFallback(ctx.host(), query);
  const host = ctx.host();
  try {
    const screenshot = host.captureCleanScreen ? await host.captureCleanScreen() : await host.captureScreen();
    // 首选 SoM：坐标来自 OCR/UIA 框（像素级可信），模型只选编号，不回归坐标
    if (ctx.deps.somLookup) {
      const candidates = await somCandidates(ctx, screenshot);
      const hit = await ctx.deps.somLookup(screenshot, query, candidates).catch(() => null);
      if (hit) {
        const cx = hit.x + Math.round(hit.w / 2);
        const cy = hit.y + Math.round(hit.h / 2);
        return {
          ok: true,
          summary: `SoM 视觉选择: "${hit.name}" 中心${fmtCoord(cx, cy)}（${candidates.length} 个候选中选中）。目标无 UIA 元素 id，请直接 mouse_click 中心坐标（双击 times=2）${somMismatchNote(query, hit.name)}`,
          data: { matches: [hit] },
        };
      }
    }
    // 兜底：自由 grounding（模型直接报 bbox，无候选场景如纯图标）→ zoom 二次精修
    if (ctx.deps.grounding) {
      const matches = await ctx.deps.grounding(screenshot, query);
      if (matches && matches.length > 0) {
        const coarse = matches[0]!;
        const refined = await zoomRefine(ctx, coarse, query);
        const m = refined ?? coarse;
        const detail = `"${m.name}" 中心${fmtCoord(m.x + m.w / 2, m.y + m.h / 2)} 尺寸 ${Math.round(m.w)}x${Math.round(m.h)}${refined ? '（zoom 精修）' : ''}`;
        return {
          ok: true,
          summary: `grounding 视觉定位: ${detail}。目标无 UIA 元素 id，请直接 mouse_click 中心坐标（双击 times=2）`,
          data: { matches: [m] },
        };
      }
    }
    const ocrResult = await ocrFallback(host, query);
    if (ocrResult) return ocrResult;
    return null;
  } catch (err) {
    console.warn('[executor] grounding 降级失败:', (err as Error).message);
    return null;
  }
}

/** 自由 grounding 粗框的二次精修：局部放大再定位一次，误差从全屏尺度收敛到局部尺度 */
async function zoomRefine(
  ctx: RefToolCtx,
  m: { name: string; x: number; y: number; w: number; h: number; spread?: number },
  query: string,
): Promise<{ name: string; x: number; y: number; w: number; h: number } | null> {
  const host = ctx.host();
  if (typeof host.captureZoom !== 'function' || !ctx.deps.grounding) return null;
  // 粗框扩边 2.2x（最小 160x120）：粗框常偏紧或偏移，防目标贴边
  let cw = Math.max(160, Math.round(m.w * 2.2));
  let ch = Math.max(120, Math.round(m.h * 2.2));
  // 投票散布大（模型定位不稳定）：复核范围必须盖住散布，否则放大图里根本没有目标
  if (m.spread && m.spread > 0) {
    cw = Math.max(cw, Math.round(m.spread * 2.2));
    ch = Math.max(ch, Math.round(m.spread * 2.2));
  }
  try {
    const { jpeg, origin, zoom } = await host.captureZoom(m.x + m.w / 2 - cw / 2, m.y + m.h / 2 - ch / 2, cw, ch);
    const hits = await ctx.deps.grounding(jpeg, query);
    if (!hits || hits.length === 0) return null;
    const r = zoomedBoxToScreen(hits[0]!, origin, zoom);
    console.log(`[executor] zoom 精修: 粗框中心(${Math.round(m.x + m.w / 2)},${Math.round(m.y + m.h / 2)}) → 精修中心(${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)})`);
    return { name: hits[0]!.name, x: r.x, y: r.y, w: r.w, h: r.h };
  } catch (err) {
    console.warn('[executor] zoom 精修失败，回退粗框:', (err as Error).message);
    return null;
  }
}

async function ocrFallback(host: HostCapabilities, query: string): Promise<ToolResult | null> {
  try {
    const screenshot = host.captureCleanScreen ? await host.captureCleanScreen() : await host.captureScreen();
    return ocrLookupTool(screenshot, query);
  } catch (err) {
    console.warn('[executor] OCR 兜底失败:', (err as Error).message);
    return null;
  }
}

/** SoM 候选收集：三来源合并——UIA 控件（首选）→ OCR 文字框（自绘界面补盲）→ 图标探测（纯图标补盲）。
 *  UIA 和 OCR 都找不到自绘 UI 的纯图标按钮（无 Name、无文字），图标探测用 Sobel 梯度 +
 *  连通区域找出视觉独立的区块作为第三来源，让 SoM 在任何界面都有候选可供编号选择。 */
async function somCandidates(ctx: RefToolCtx, screenshot: Buffer): Promise<SomCandidate[]> {
  const uia: SomCandidate[] = [];
  try {
    const tree = await ctx.uiTree();
    const fg = await foregroundTitle();
    const pool = filterForegroundCandidates(collectCandidates(tree.tree, SOM_CANDIDATE_LIMIT), fg);
    for (const m of pool) {
      uia.push({ index: uia.length + 1, label: m.name.slice(0, SOM_LABEL_MAX), x: m.x, y: m.y, w: m.w, h: m.h });
      if (uia.length >= SOM_CANDIDATE_LIMIT) break;
    }
  } catch { /* UIA 不可用 → 全靠 OCR/图标探测补盲候选 */ }
  // B1：UIA 候选稀薄（微信/Electron/Chromium 内页无无障碍树）时补 OCR 文字框 + 图标探测，
  // 让 SoM「看图选编号」这类选择题在自绘界面也有可信候选，替代模型目测报坐标（50% 抖动的正解）。
  if (uia.length < 8) {
    const host = ctx.host();
    // 图标探测（纯图标按钮：无 UIA Name、无文字，只有视觉边界）
    if (host.decodeGray) {
      try {
        const gray = host.decodeGray(screenshot);
        if (gray) {
          const icons = detectIconRegions(gray);
          if (icons.length > 0) {
            const iconSom = iconBoxesToSom(icons);
            const merged1 = mergeSomCandidates(uia, iconSom);
            if (merged1.length >= 8) return merged1;
            // 图标 + OCR 合并
            try {
              const dims = readImageSize(screenshot);
              const hits = dims ? await ocrRecognizeAll(screenshot, dims) : null;
              if (hits && hits.length > 0) return mergeSomCandidates(merged1, ocrHitsToSom(hits));
            } catch { /* OCR 不可用 */ }
            return merged1;
          }
        }
      } catch { /* 图标探测失败 → 退回 UIA + OCR */ }
    }
    // OCR 补盲
    try {
      const dims = readImageSize(screenshot);
      const hits = dims ? await ocrRecognizeAll(screenshot, dims) : null;
      if (hits && hits.length > 0) return mergeSomCandidates(uia, ocrHitsToSom(hits));
    } catch { /* OCR 不可用 → 退回 UIA-only 候选 */ }
  }
  return uia;
}

/** B2：图标区域 → SoM 候选（纯映射，可单测；label 用坐标占位——无文字标签时模型按位置选编号） */
export function iconBoxesToSom(boxes: IconBox[]): SomCandidate[] {
  const out: SomCandidate[] = [];
  for (const b of boxes) {
    out.push({
      index: 0,
      label: `图标(${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)})`,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    });
  }
  return out.slice(0, ICON_DETECT_MAX);
}

/** B1：OCR 文字框 → SoM 候选（纯映射，可单测；空文本丢弃、label 截断） */
export function ocrHitsToSom(hits: OcrHit[]): SomCandidate[] {
  const out: SomCandidate[] = [];
  for (const h of hits) {
    const label = (h.text ?? '').trim().slice(0, SOM_LABEL_MAX);
    if (!label) continue;
    out.push({ index: 0, label, x: h.x, y: h.y, w: h.w, h: h.h });
  }
  return out;
}

/** B1：合并候选——UIA（更可信）在前，OCR 补盲在后；OCR 项中心距任一已保留项 <40px 视为重复丢弃；重排 index、封顶 cap（纯函数可单测） */
export function mergeSomCandidates(uia: SomCandidate[], ocr: SomCandidate[], cap = SOM_CANDIDATE_LIMIT): SomCandidate[] {
  const out = [...uia];
  for (const c of ocr) {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    if (!out.some((k) => Math.hypot(k.x + k.w / 2 - cx, k.y + k.h / 2 - cy) < 40)) out.push(c);
  }
  return out.slice(0, cap).map((c, i) => ({ ...c, index: i + 1 }));
}

/** B1：视觉定位结果（无 UIA id）的找到即点——按中心坐标直点，沿用 mouseClick 的守卫/穿透/验证链 */
export async function clickAfterLocate(ctx: RefToolCtx, g: ToolResult, args: Record<string, unknown>): Promise<ToolResult> {
  const hit = (g.data?.matches as Array<{ x: number; y: number; w: number; h: number }> | undefined)?.[0];
  if (!hit) return g;
  const cx = Math.round(hit.x + hit.w / 2);
  const cy = Math.round(hit.y + hit.h / 2);
  const clicked = await ctx.mouseClick({ x: cx, y: cy, button: args.button ?? 'left', times: Number(args.times ?? 1), modifiers: args.modifiers });
  const located = (g.summary ?? '').slice(0, 120);
  return clicked.ok
    ? { ok: true, summary: `${located}；已点击中心 ${fmtCoord(cx, cy)} → ${clicked.summary}` }
    : { ...clicked, error: `${located}；点击失败: ${clicked.error}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
