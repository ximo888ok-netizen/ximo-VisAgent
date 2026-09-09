// 触手执行器：把 agent-core 的 Tools 映射到真实设备控制
import type { SomCandidate, ToolExecutor, ToolResult } from '@ximo-visagent/agent-core';
import { suggestToolName, TOOL_SCHEMA_MAP } from '@ximo-visagent/agent-core';
import { getHost } from './host';
import { getUiaClient } from './uia-client';
import { collectCandidates, flattenTree, searchMatches, zoomedBoxToScreen } from './ui-locate';
import { captureBaseline, postClickVerify } from './click-verify';
import { ClickGuard } from './click-guard';
import { clickWithSelfPassthrough, ensureTargetForeground } from './click-focus';
import { ocrLookupTool } from './ocr-lookup';
import { screenOcr, waitFor, lookClose } from './screen-ocr';
import {
  mouseClick,
  mouseDrag,
  mouseHold,
  mouseDragHold,
  mouseScroll,
} from './win32';
import { keyboardPress, keyboardType } from './win32-keyboard';
import { activateWindow, listWindows } from './win32-window';
/** 双击后等待前台窗口变化（覆盖冷启动 >300ms，防误报未变化） */
const OPEN_EFFECT_WAIT_MS = 400;

/** SoM 候选上限与 label 截断 */
const SOM_CANDIDATE_LIMIT = 200;
const SOM_LABEL_MAX = 24;

/** 视觉定位钩子：UIA 找不到目标时由宿主注入（SoM 编号选择 / DeepSeek grounding，见 agent-core/grounding.ts） */
export interface ExecutorDeps {
  grounding?: (screenshot: Buffer, query: string) => Promise<{ name: string; x: number; y: number; w: number; h: number }[] | null>;
  somLookup?: (screenshot: Buffer, query: string, candidates: SomCandidate[]) => Promise<{ name: string; x: number; y: number; w: number; h: number } | null>;
}

export class ComputerToolExecutor implements ToolExecutor {
  /** 同元素连点计数（实例 = 每任务新建，状态不跨任务） */
  private uiClickCounts = new Map<number, number>();
  /** 点击守卫：同位置熔断 + UIA 命中提示 + 熔断候选建议（见 click-guard.ts） */
  private guard = new ClickGuard();

  constructor(private deps: ExecutorDeps = {}) {}
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'mouse_click': return await this.mouseClick(args);
        case 'mouse_drag': return await this.mouseDrag(args);
        case 'mouse_hold': return await this.mouseHold(args);
        case 'mouse_drag_hold': return await this.mouseDragHold(args);
        case 'mouse_scroll': return await this.mouseScroll(args);
        case 'keyboard_type': return await this.keyboardType(args);
        case 'keyboard_press': return await this.keyboardPress(args);
        case 'open_app': return await this.openApp(args);
        case 'activate_window': return await this.activateWindow(args);
        case 'get_clipboard': return await this.getClipboard();
        case 'set_clipboard': return await this.setClipboard(args);
        case 'ui_locate': return await this.uiLocate(args);
        case 'ui_click': return await this.uiClick(args);
        case 'look_close': return await lookClose(args);
        case 'wait': return await this.wait(args);
        case 'screen_ocr': return await screenOcr(args);
        case 'wait_for': return await waitFor(args);
        default:
          // 拼错工具名时给出候选，让模型能自我纠正；否则它凭记忆重复输出同一个错名，
          // 每步都拿不到输入注入，任务空转到 maxSteps 而鼠标始终不动。
          return {
            ok: false,
            summary: '',
            error: unknownToolError(name),
          };
      }
    } catch (err) {
      const e = err as Error;
      return { ok: false, summary: '', error: `${name}: ${e.message}` };
    }
  }

  // ---------- 视觉坐标（直点模式：模型给什么坐标就点什么，不纠正） ----------
  private async mouseClick(args: Record<string, unknown>): Promise<ToolResult> {
    const x = Number(args.x);
    const y = Number(args.y);
    if (args.x == null || args.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        summary: '',
        error: `mouse_click 坐标非法（x=${String(args.x)}, y=${String(args.y)}）。x/y 必须是数字，如 {"x": 497, "y": 528}；坐标从截图网格刻度线插值读取`,
      };
    }
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    const times = Number(args.times ?? 1);
    const blocked = this.guard.check(x, y);
    if (blocked) return { ok: false, summary: '', error: blocked };
    const fgBefore = times >= 2 ? await this.foregroundTitle() : null;
    // 前台/遮挡保证：目标窗口不在前台先激活；被自家窗口遮挡则临时穿透（见 click-focus.ts）
    const focus = await ensureTargetForeground(x, y);
    // 点击前抓同区域基线，点击后比对：这是模型判断"点没点中"的唯一可信信号
    const baseline = await captureBaseline(x, y);

    await clickWithSelfPassthrough(x, y, button, times, focus.selfOccluded);
    this.overlay({ type: 'click', x, y });
    const actionName = times === 2 ? '双击' : times > 2 ? `${times}击` : '点击';
    let summary = `真实光标${actionName} @(${Math.round(x)},${Math.round(y)}) (${button})`;
    if (times >= 2) summary += await this.foregroundDelta(fgBefore);
    if (focus.note) summary += focus.note;
    if (baseline) {
      const verify = await postClickVerify(baseline);
      if (verify) {
        summary += verify.note;
        // 验证生效 → 清零熔断计数，避免正常重复交互被误熔断
        if (verify.changed) this.guard.noteEffective();
      }
    }
    const hint = this.guard.hintAt(x, y);
    if (hint) summary += hint;

    return { ok: true, summary };
  }

  /** 双击后的前台窗口变化反馈（无变化 = 可能被遮挡或没打开，模型不必盲试） */
  private async foregroundDelta(before: string | null): Promise<string> {
    await new Promise((r) => setTimeout(r, OPEN_EFFECT_WAIT_MS));
    const after = await this.foregroundTitle();
    if (after && after !== before) return `；前台窗口已切换: ${after}`;
    return `；前台窗口未变化 (${after ?? '未知'})——目标可能被遮挡或未打开，勿原地重试`;
  }

  private async foregroundTitle(): Promise<string | null> {
    try {
      const info = await getHost().getForegroundInfo();
      return info?.title ?? null;
    } catch {
      return null;
    }
  }

  private async mouseDrag(args: Record<string, unknown>): Promise<ToolResult> {
    const from = args.from as { x: number; y: number };
    const to = args.to as { x: number; y: number };
    const fx = Number(from?.x), fy = Number(from?.y), tx = Number(to?.x), ty = Number(to?.y);
    if (![fx, fy, tx, ty].every(Number.isFinite)) {
      return { ok: false, summary: '', error: 'mouse_drag 需要 from/to 坐标（数字），如 {"from":{"x":100,"y":200},"to":{"x":300,"y":400}}' };
    }
    await mouseDrag({ x: fx, y: fy }, { x: tx, y: ty });
    this.overlay({ type: 'drag', x: fx, y: fy, toX: tx, toY: ty });
    return { ok: true, summary: `拖动 (${fx},${fy})→(${tx},${ty})` };
  }

  private async mouseHold(args: Record<string, unknown>): Promise<ToolResult> {
    const x = Number(args.x);
    const y = Number(args.y);
    if (args.x == null || args.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        summary: '',
        error: `mouse_hold 坐标非法（x=${String(args.x)}, y=${String(args.y)}）。x/y 必须是数字，如 {"x": 497, "y": 528}`,
      };
    }
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    const holdMs = Number(args.holdMs ?? 500);
    await mouseHold(x, y, button, holdMs);
    this.overlay({ type: 'click', x, y });
    return { ok: true, summary: `长按 @(${Math.round(x)},${Math.round(y)}) (${button}) ${holdMs}ms` };
  }

  private async mouseDragHold(args: Record<string, unknown>): Promise<ToolResult> {
    const from = args.from as { x: number; y: number };
    const to = args.to as { x: number; y: number };
    const fx = Number(from?.x), fy = Number(from?.y), tx = Number(to?.x), ty = Number(to?.y);
    if (![fx, fy, tx, ty].every(Number.isFinite)) {
      return { ok: false, summary: '', error: 'mouse_drag_hold 需要 from/to 坐标（数字），如 {"from":{"x":100,"y":200},"to":{"x":300,"y":400}}' };
    }
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    const holdMs = Number(args.holdMs ?? 300);
    await mouseDragHold({ x: fx, y: fy }, { x: tx, y: ty }, button, holdMs);
    this.overlay({ type: 'drag', x: fx, y: fy, toX: tx, toY: ty });
    return { ok: true, summary: `长按拖拽 (${fx},${fy})→(${tx},${ty}) (${button}) 保持${holdMs}ms` };
  }

  private async mouseScroll(args: Record<string, unknown>): Promise<ToolResult> {
    const delta = Number(args.delta ?? 0);
    const x = args.x !== undefined ? Number(args.x) : undefined;
    const y = args.y !== undefined ? Number(args.y) : undefined;
    await mouseScroll(delta, x, y);
    return { ok: true, summary: `滚轮 ${delta > 0 ? '向上' : '向下'} ${Math.abs(delta)} 格${x !== undefined ? ` @(${Math.round(x)},${Math.round(y ?? 0)})` : ''}` };
  }

  private async keyboardType(args: Record<string, unknown>): Promise<ToolResult> {
    await keyboardType(String(args.text ?? ''));
    return { ok: true, summary: `已输入 ${String(args.text ?? '').length} 字符` };
  }

  private async keyboardPress(args: Record<string, unknown>): Promise<ToolResult> {
    keyboardPress(String(args.combo));
    return { ok: true, summary: `已按键 ${args.combo}` };
  }

  private async openApp(args: Record<string, unknown>): Promise<ToolResult> {
    await getHost().openApp(String(args.nameOrPath));
    // 启动是异步的：宿主已等窗口并尝试激活，这里回报真实前台窗口，模型不必盲点
    await sleep(OPEN_EFFECT_WAIT_MS);
    const fg = await this.foregroundTitle();
    return { ok: true, summary: `启动 ${args.nameOrPath}${fg ? `；当前前台窗口: ${fg}` : '；未检测到前台窗口'}` };
  }

  private async activateWindow(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.hwnd) {
      activateWindow(Number(args.hwnd));
      return { ok: true, summary: `激活窗口 ${args.hwnd}` };
    }
    const title = String(args.title ?? '').toLowerCase();
    const windows = await listWindows();
    const hit = windows.find((w) => w.title.toLowerCase().includes(title));
    if (!hit) return { ok: false, summary: '', error: `未找到窗口: ${args.title}` };
    activateWindow(hit.hwnd);
    return { ok: true, summary: `激活窗口: ${hit.title}` };
  }

  private async getClipboard(): Promise<ToolResult> {
    const text = await getHost().readClipboard();
    return { ok: true, summary: `剪贴板: ${text.slice(0, 100)}`, data: { text } };
  }

  private async setClipboard(args: Record<string, unknown>): Promise<ToolResult> {
    await getHost().writeClipboard(String(args.text ?? ''));
    return { ok: true, summary: '已写入剪贴板' };
  }

  private async wait(args: Record<string, unknown>): Promise<ToolResult> {
    const ms = Number(args.ms ?? 0);
    await sleep(ms);
    return { ok: true, summary: `等待 ${ms}ms` };
  }

  // ---------- UIA 辅助定位（sidecar 只读树 → 按名找元素 → 按真实中心点击） ----------
  /** 拉起 sidecar（幂等）并取当前 UIA 树 */
  private async uiTree() {
    const client = getUiaClient();
    if (!client.healthy) await client.start();
    return client.getUiTree({ maxDepth: 10, maxNodes: 1500 });
  }

  private async uiLocate(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { ok: false, summary: '', error: 'ui_locate 需要 query（控件/图标名称的子串，如 "Qoder"、"保存"）' };
    try {
      const tree = await this.uiTree();
      const all = flattenTree(tree.tree);
      const matches = searchMatches(all, query, Number(args.limit ?? 8));
      if (matches.length === 0) {
        // UIA 未命中 → grounding 降级链（DeepSeek 视觉定位，坐标由代码反归一化）
        const g = await this.groundingLookup(query);
        if (g) return g;
        return { ok: false, summary: '', error: `未找到名称含「${query}」的元素（扫描 ${all.length} 个节点）。换更短的关键词，或回退为看图点击` };
      }
      const detail = matches
        .map((m) => `#${m.id} "${m.name}"(${m.type}) [${m.window}]`)
        .join('；');
      // 登记给点击守卫：模型若拿坐标直点，会被提示改用 ui_click（UIA 中心无目测误差）
      this.guard.remember(matches.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, w: m.w, h: m.h })));
      return {
        ok: true,
        summary: `找到${matches.length}个: ${detail}。点击请用 ui_click(elementId)——按 UIA 真实中心点击，无目测误差`,
        data: { matches },
      };
    } catch (err) {
      // UIA 整体不可用时也走 grounding 兜底
      const g = await this.groundingLookup(query).catch(() => null);
      if (g) return g;
      return { ok: false, summary: '', error: `UIA 不可用(${(err as Error).message})，请回退为看图点击` };
    }
  }

  /** grounding 降级：拿干净截图（无网格）→ SoM 编号选择（首选）→ 自由 bbox（兜底）→ OCR 文字定位（最终兜底） */
  private async groundingLookup(query: string): Promise<ToolResult | null> {
    if (!this.deps.grounding && !this.deps.somLookup) {
      // 无视觉定位依赖时直接走 OCR 兜底
      return this.ocrFallback(query);
    }
    const host = getHost();
    try {
      const screenshot = host.captureCleanScreen ? await host.captureCleanScreen() : await host.captureScreen();
      // 首选 SoM：坐标来自 OCR/UIA 框（像素级可信），模型只选编号，不回归坐标
      if (this.deps.somLookup) {
        const candidates = await this.somCandidates(screenshot);
        const hit = await this.deps.somLookup(screenshot, query, candidates).catch(() => null);
        if (hit) {
          const cx = hit.x + Math.round(hit.w / 2);
          const cy = hit.y + Math.round(hit.h / 2);
          return {
            ok: true,
            summary: `SoM 视觉选择: "${hit.name}" 中心(${cx},${cy})（${candidates.length} 个候选中选中）。目标无 UIA 元素 id，请直接 mouse_click 中心坐标（双击 times=2）`,
            data: { matches: [hit] },
          };
        }
      }
      // 兜底：自由 grounding（模型直接报 bbox，无候选场景如纯图标）→ zoom 二次精修
      if (this.deps.grounding) {
        const matches = await this.deps.grounding(screenshot, query);
        if (matches && matches.length > 0) {
          const coarse = matches[0]!;
          const refined = await this.zoomRefine(coarse, query);
          const m = refined ?? coarse;
          const detail = `"${m.name}" 中心(${Math.round(m.x + m.w / 2)},${Math.round(m.y + m.h / 2)}) 尺寸 ${Math.round(m.w)}x${Math.round(m.h)}${refined ? '（zoom 精修）' : ''}`;
          return {
            ok: true,
            summary: `grounding 视觉定位: ${detail}。目标无 UIA 元素 id，请直接 mouse_click 中心坐标（双击 times=2）`,
            data: { matches: [m] },
          };
        }
      }
      // 方向3：OCR 兜底——UIA/SoM/grounding 全部失败时，用 Windows OCR 识别文字位置
      const ocrResult = await ocrLookupTool(screenshot, query).catch(() => null);
      if (ocrResult) return ocrResult;
      return null;
    } catch (err) {
      console.warn('[executor] grounding 降级失败:', (err as Error).message);
      return null;
    }
  }

  /** 自由 grounding 粗框的二次精修：局部放大再定位一次，误差从全屏尺度收敛到局部尺度 */
  private async zoomRefine(
    m: { name: string; x: number; y: number; w: number; h: number },
    query: string,
  ): Promise<{ name: string; x: number; y: number; w: number; h: number } | null> {
    const host = getHost();
    if (typeof host.captureZoom !== 'function' || !this.deps.grounding) return null;
    // 粗框扩边 2.2x（最小 160x120）：粗框常偏紧或偏移，防目标贴边
    const cw = Math.max(160, Math.round(m.w * 2.2));
    const ch = Math.max(120, Math.round(m.h * 2.2));
    try {
      const { jpeg, origin, zoom } = await host.captureZoom(m.x + m.w / 2 - cw / 2, m.y + m.h / 2 - ch / 2, cw, ch);
      const hits = await this.deps.grounding(jpeg, query);
      if (!hits || hits.length === 0) return null;
      const r = zoomedBoxToScreen(hits[0]!, origin, zoom);
      console.log(`[executor] zoom 精修: 粗框中心(${Math.round(m.x + m.w / 2)},${Math.round(m.y + m.h / 2)}) → 精修中心(${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)})`);
      return { name: hits[0]!.name, x: r.x, y: r.y, w: r.w, h: r.h };
    } catch (err) {
      console.warn('[executor] zoom 精修失败，回退粗框:', (err as Error).message);
      return null;
    }
  }

  private async ocrFallback(query: string): Promise<ToolResult | null> {
    const host = getHost();
    try {
      const screenshot = host.captureCleanScreen ? await host.captureCleanScreen() : await host.captureScreen();
      return ocrLookupTool(screenshot, query);
    } catch (err) {
      console.warn('[executor] OCR 兜底失败:', (err as Error).message);
      return null;
    }
  }

  /** SoM 候选收集：UIA 控件，坐标在截图坐标系。 */
  private async somCandidates(_screenshot: Buffer): Promise<SomCandidate[]> {
    const out: SomCandidate[] = [];
    try {
      const tree = await this.uiTree();
      for (const m of collectCandidates(tree.tree, SOM_CANDIDATE_LIMIT)) {
        out.push({ index: out.length + 1, label: m.name.slice(0, SOM_LABEL_MAX), x: m.x, y: m.y, w: m.w, h: m.h });
        if (out.length >= SOM_CANDIDATE_LIMIT) break;
      }
    } catch { /* UIA 不可用，无候选 */ }
    return out;
  }

  private async uiClick(args: Record<string, unknown>): Promise<ToolResult> {
    const id = Number(args.elementId);
    if (!Number.isFinite(id)) return { ok: false, summary: '', error: 'ui_click 需要 elementId（来自 ui_locate 返回的 #id）' };
    // 同元素连点熔断：连续 ≥3 次确定性止损
    const clicks = (this.uiClickCounts.get(id) ?? 0) + 1;
    this.uiClickCounts.set(id, clicks);
    if (clicks > 3) {
      return { ok: false, summary: '', error: `元素 #${id} 已点击 ${clicks - 1} 次仍无效果，已熔断。换方案：检查目标是否被窗口遮挡、activate_window 激活目标窗口、或改用键盘/其他工具` };
    }
    try {
      // 每次点击都重取树：id 是 RuntimeId 哈希，元素活着就稳定；界面变了会显式报「已不存在」防点错
      const tree = await this.uiTree();
      const hit = flattenTree(tree.tree).find((m) => m.id === id);
      if (!hit) return { ok: false, summary: '', error: `元素 #${id} 已不存在（界面有变化），请重新 ui_locate` };
      const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
      const times = Number(args.times ?? 1);
      const fgBefore = times >= 2 ? await this.foregroundTitle() : null;
      // ui_click 的目标是模型按名字选中的控件，即使它属于自家窗口也应如实点击（不穿透）
      const focus = await ensureTargetForeground(hit.center.x, hit.center.y);
      const baseline = await captureBaseline(hit.center.x, hit.center.y);
      await mouseClick(hit.center.x, hit.center.y, button, times);
      this.overlay({ type: 'click', x: hit.center.x, y: hit.center.y });
      let summary = `真实点击元素 "${hit.name}" 中心 @(${Math.round(hit.center.x)},${Math.round(hit.center.y)}) [${hit.window}]`;
      if (times >= 2) summary += await this.foregroundDelta(fgBefore);
      if (focus.note) summary += focus.note;
      if (baseline) {
        const verify = await postClickVerify(baseline);
        if (verify) {
          summary += verify.note;
          if (verify.changed) {
            this.guard.noteEffective();
            this.uiClickCounts.delete(id);
          }
        }
      }
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, summary: '', error: `UIA 不可用(${(err as Error).message})，请回退为看图点击` };
    }
  }

  private overlay(ev: { type: 'click' | 'drag' | 'type' | 'scroll'; x?: number; y?: number; toX?: number; toY?: number }): void {
    try {
      getHost().emitOverlay?.({ ...ev, ts: Date.now() });
    } catch { /* host 未初始化（单测）时忽略 */ }
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 未知工具的错误文案：带编辑距离候选，无候选时列出全部可用工具 */
function unknownToolError(name: string): string {
  const hint = suggestToolName(name);
  return hint
    ? `未知工具: ${name}。你可能想调用 "${hint}"，请改用正确工具名重试`
    : `未知工具: ${name}。可用工具: ${Object.keys(TOOL_SCHEMA_MAP).join(', ')}`;
}
