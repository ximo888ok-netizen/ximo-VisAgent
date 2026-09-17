// 触手执行器：把 agent-core 的 Tools 映射到真实设备控制。
// 分工：本文件只做参数校验与直点/键鼠/窗口路由；#ref 寻址点击与视觉降级链在
// ui-index-tool.ts / grounding-fallback.ts（行数上限拆分，语义与拆分前一致）。
import type { SomCandidate, ToolExecutor, ToolResult } from '@ximo-visagent/agent-core';
import { getHost } from './host';
import { getUiaClient } from './uia-client';
import { flattenTree, formatLocateDetail, searchMatches, parseMenuPath } from './ui-locate';
import { captureBaseline, postClickVerify } from './click-verify';
import { inputVerifyData, unknownToolError, verifyResultData } from './executor-result';
import { ClickGuard } from './click-guard';
import { clickWithSelfPassthrough, ensureTargetForeground } from './click-focus';
import { mouseHoverTool } from './mouse-hover';
import { uiScrollTo } from './uia-scroll';
import { screenOcr, waitFor, lookClose } from './screen-ocr';
import { mouseDrag, mouseHold, mouseDragHold, mouseScroll, mouseMoveTo, getCursorPos } from './win32';
import { keyboardPress, keyboardType } from './win32-keyboard';
import { verifyTypedInput, verifyKeyEffect, readFocusedSnapshot, diffFocusVerdict } from './keyboard-verify';
import { STABLE_MAX_WAIT_MS, waitForStableFrame } from './stable-frame';
import { activateWindow, listWindows } from './win32-window';
import { clickAfterLocate, foregroundDelta, foregroundTitle, groundingLookup, type RefToolCtx } from './grounding-fallback';
import { locateByRef, uiClickTool, uiIndexTool } from './ui-index-tool';
import { getWindowIndex } from './window-index';
/** 开应用/双击后等"见效"：稳定帧轮询取代固定等待——快路径 ~160-240ms（不劣于旧 400ms），
 *  上限 2.5s 有界（慢界面不误报未变化）；宿主无稳定观测能力时退回旧的固定 400ms。 */
const OPEN_EFFECT_WAIT_MS = 400;
/** menu_select 点开父级菜单后、定位下一级子项前的等待（子菜单渲染需时间） */
const MENU_SELECT_SETTLE_MS = 350;

/** 视觉定位钩子：UIA 找不到目标时由宿主注入（SoM 编号选择 / DeepSeek grounding，见 agent-core/grounding.ts） */
export interface ExecutorDeps {
  grounding?: (screenshot: Buffer, query: string) => Promise<{ name: string; x: number; y: number; w: number; h: number; spread?: number }[] | null>;
  somLookup?: (screenshot: Buffer, query: string, candidates: SomCandidate[]) => Promise<{ name: string; x: number; y: number; w: number; h: number } | null>;
}

export class ComputerToolExecutor implements ToolExecutor {
  /** 同目标连点计数（实例 = 每任务新建，状态不跨任务）；键 = 'e<elementId>' / 'r<ref>' */
  private uiClickCounts = new Map<string, number>();
  /** 点击守卫：同位置熔断 + UIA 命中提示 + 熔断候选建议（见 click-guard.ts） */
  private guard = new ClickGuard();

  constructor(private deps: ExecutorDeps = {}) {}

  /** 任务边界清理（desktop 组装根在任务终态调用）：清空守卫登记的候选元素/重复查询统计与连点计数，
   *  上一任务的视觉残留不参与下一任务的提示、熔断建议与候选提示（执行器可能被 activeComputer 复用）。 */
  resetVisualState(): void {
    this.guard.forget();
    this.uiClickCounts.clear();
  }

  /** A1：loop 判某目测坐标连续无变化（switch 档）时调用——委托点击守卫在本任务内拉黑该点附近，
   *  此后落在其近旁的点击被 guard.check 拒执，逼模型换 ui_click/键盘（不清 noteEffective 可解，需显式换路径） */
  invalidateCoord(x: number, y: number): void {
    this.guard.invalidate(x, y);
  }

  /** 传给拆分模块的上下文：状态仍归 executor 实例，模块不持有 executor 引用 */
  private refCtx(): RefToolCtx {
    return {
      deps: this.deps,
      uiTree: () => this.uiTree(),
      mouseClick: (a) => this.mouseClick(a),
      guard: this.guard,
      clickCounts: this.uiClickCounts,
      overlay: (e) => this.overlay(e),
      host: () => getHost(),
    };
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'mouse_click': return await this.mouseClick(args);
        case 'mouse_drag': return await this.mouseDrag(args);
        case 'mouse_hold': return await this.mouseHold(args);
        case 'mouse_drag_hold': return await this.mouseDragHold(args);
        case 'mouse_scroll': return await this.mouseScroll(args);
        case 'mouse_move': return await this.mouseMove(args);
        case 'mouse_hover': return await mouseHoverTool(args);
        case 'menu_select': return await this.menuSelect(args);
        case 'ui_scroll_to': return await uiScrollTo(args);
        case 'keyboard_type': return await this.keyboardType(args);
        case 'keyboard_press': return await this.keyboardPress(args);
        case 'open_app': return await this.openApp(args);
        case 'activate_window': return await this.activateWindow(args);
        case 'get_clipboard': return await this.getClipboard();
        case 'set_clipboard': return await this.setClipboard(args);
        case 'ui_index': return await uiIndexTool(args);
        case 'ui_locate': return await this.uiLocate(args);
        case 'ui_click': return await uiClickTool(this.refCtx(), args);
        case 'look_close': return await lookClose(args);
        case 'wait': return await this.wait(args);
        case 'screen_ocr': return await screenOcr(args);
        case 'wait_for': return await waitFor(args);
        default:
          // 拼错工具名时给出候选，让模型能自我纠正；否则它凭记忆重复输出同一个错名，
          // 每步都拿不到输入注入，任务空转到 maxSteps 而鼠标始终未移动。
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
    const straight = args.straight === true;
    let x = Number(args.x);
    let y = Number(args.y);
    // 不带坐标 = 在当前光标处原地点击（移动与点击拆开：先 mouse_move 到位，再 mouse_click()）
    if (args.x == null && args.y == null) {
      const cur = getCursorPos();
      x = cur.x;
      y = cur.y;
    } else if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        summary: '',
        error: `mouse_click 坐标非法（x=${String(args.x)}, y=${String(args.y)}）。x/y 给数字（从截图网格插值），或都省略以在当前光标处点击`,
      };
    }
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    const times = Number(args.times ?? 1);
    const blocked = this.guard.check(x, y);
    if (blocked) return { ok: false, summary: '', error: blocked };
    const fgBefore = times >= 2 ? await foregroundTitle() : null;
    // 前台/遮挡保证：目标窗口不在前台先激活；被自家窗口遮挡则临时穿透（见 click-focus.ts）
    const focus = await ensureTargetForeground(x, y);
    // 点击前抓同区域基线，点击后比对：这是模型判断"点没点中"的唯一可信信号
    const baseline = await captureBaseline(x, y);

    await clickWithSelfPassthrough(x, y, button, times, focus.selfOccluded, args.modifiers, straight);
    this.overlay({ type: 'click', x, y });
    const actionName = times === 2 ? '双击' : times > 2 ? `${times}击` : '点击';
    let summary = `真实光标${actionName} @(${Math.round(x)},${Math.round(y)}) (${button})`;
    if (times >= 2) summary += await foregroundDelta(fgBefore);
    if (focus.note) summary += focus.note;
    const verify = baseline ? await postClickVerify(baseline) : null;
    if (verify) {
      summary += verify.note;
      // 验证生效 → 清零熔断计数，避免正常重复交互被误熔断
      if (verify.changed) this.guard.noteEffective();
    }
    const hint = this.guard.hintAt(x, y);
    if (hint) summary += hint;

    return { ok: true, summary, ...(verify ? { data: verifyResultData(verify) } : {}) };
  }

  private async mouseDrag(args: Record<string, unknown>): Promise<ToolResult> {
    const from = args.from as { x: number; y: number };
    const to = args.to as { x: number; y: number };
    const fx = Number(from?.x), fy = Number(from?.y), tx = Number(to?.x), ty = Number(to?.y);
    if (![fx, fy, tx, ty].every(Number.isFinite)) {
      return { ok: false, summary: '', error: 'mouse_drag 需要 from/to 坐标（数字），如 {"from":{"x":100,"y":200},"to":{"x":300,"y":400}}' };
    }
    const baseline = await captureBaseline(fx, fy);
    await mouseDrag({ x: fx, y: fy }, { x: tx, y: ty });
    this.overlay({ type: 'drag', x: fx, y: fy, toX: tx, toY: ty });
    const verify = baseline ? await postClickVerify(baseline) : null;
    return { ok: true, summary: `拖动 (${fx},${fy})→(${tx},${ty})${verify?.note ?? ''}` };
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
    // 数组/字符串坐标会被静默转成 NaN 传进 win32（实测点出 @(NaN,NaN)），这里显式拒绝
    if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y)) || !Number.isFinite(delta)) {
      return {
        ok: false,
        summary: '',
        error: `mouse_scroll 参数非法（delta=${String(args.delta)}, x=${String(args.x)}, y=${String(args.y)}）。delta 为格数、x/y 为坐标，必须是数字`,
      };
    }
    await mouseScroll(delta, x, y);
    return { ok: true, summary: `滚轮 ${delta > 0 ? '向上' : '向下'} ${Math.abs(delta)} 格${x !== undefined ? ` @(${Math.round(x)},${Math.round(y ?? 0)})` : ''}` };
  }

  /** 纯移动光标到坐标（不点击、不停留）：悬停触发 tooltip/高亮、把指针移到位准备下一步、
   *  在已展开的菜单内逐步移动（不点击可避免收起）等人类高频操作。要停留用 mouse_hover，要点用 mouse_click。 */
  private async mouseMove(args: Record<string, unknown>): Promise<ToolResult> {
    const x = Number(args.x);
    const y = Number(args.y);
    if (args.x == null || args.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        summary: '',
        error: `mouse_move 坐标非法（x=${String(args.x)}, y=${String(args.y)}）。x/y 必须是数字，如 {"x": 497, "y": 528}`,
      };
    }
    await mouseMoveTo(x, y, args.straight === true);
    return { ok: true, summary: `光标移动到 (${Math.round(x)},${Math.round(y)})（未点击${args.straight === true ? '，直线' : ''}）` };
  }

  /** 单动作菜单导航：path="文件>另存为" → 逐级"定位→点→等子菜单渲染"，全程一个动作，
   *  消除"这回合开菜单、下回合鼠标点菜单项"时弹出菜单已收起的竞态。 */
  private async menuSelect(args: Record<string, unknown>): Promise<ToolResult> {
    const segs = parseMenuPath(String(args.path ?? ''));
    if (segs.length === 0) {
      return { ok: false, summary: '', error: 'menu_select 需要 path，如 "文件>另存为"（多级用 > 分隔，括号助记键自动忽略）' };
    }
    const trail: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      let tree;
      try {
        tree = await this.uiTree();
      } catch (err) {
        return { ok: false, summary: '', error: `menu_select：UIA 树不可用（${(err as Error).message}），无法定位「${seg}」；回退 keyboard_press combos=["Alt","Down","Enter"] 方向键导航` };
      }
      const matches = searchMatches(flattenTree(tree.tree), seg, 5);
      if (matches.length === 0) {
        return { ok: false, summary: '', error: `menu_select：没找到菜单项「${seg}」（已点到：${trail.join(' > ') || '无'}）。上级菜单可能未展开或名称不符——用更精确的名称，或回退 keyboard_press(combos=["Alt","Down","Enter"]) 方向键导航` };
      }
      const m = matches[0]!;
      const cx = Math.round(m.center.x);
      const cy = Math.round(m.center.y);
      const clicked = await this.mouseClick({ x: cx, y: cy, straight: true });
      if (!clicked.ok) return { ok: false, summary: '', error: `menu_select：点击「${seg}」@(${cx},${cy}) 失败：${clicked.error ?? clicked.summary}` };
      trail.push(`${seg}@(${cx},${cy})`);
      if (i < segs.length - 1) await sleep(MENU_SELECT_SETTLE_MS);
    }
    return { ok: true, summary: `菜单导航 ${segs.join('>')}：逐级点击 ${trail.join(' → ')}（单动作内完成）` };
  }

  private async keyboardType(args: Record<string, unknown>): Promise<ToolResult> {
    const text = String(args.text ?? '');
    const intervalMs = typeof args.intervalMs === 'number' && Number.isFinite(args.intervalMs) ? args.intervalMs : undefined;
    await keyboardType(text, intervalMs);
    // 三态回读结论（仅告警不阻塞）：note 进 summary，结构化结论进 data 供上层断言/观察使用
    const verified = await verifyTypedInput(text);
    const data = verified ? { inputVerify: inputVerifyData(verified) } : undefined;
    return { ok: true, summary: `已输入 ${text.length} 字符${verified?.note ?? ''}`, ...(data ? { data } : {}) };
  }

  private async keyboardPress(args: Record<string, unknown>): Promise<ToolResult> {
    const seq = Array.isArray(args.combos) ? (args.combos as unknown[]).map((x) => String(x)).filter((x) => x.trim()) : [];
    if (seq.length > 0) {
      // 有序按键序列（如 ["Alt+F","A"] 打开"文件"菜单再选"另存为"）：一次发完，消除跨回合弹出菜单收起
      const before = await readFocusedSnapshot();
      for (let i = 0; i < seq.length; i++) {
        keyboardPress(seq[i]!);
        if (i < seq.length - 1) await sleep(150);
      }
      await sleep(200);
      const verdict = diffFocusVerdict(before, await readFocusedSnapshot());
      const tail = verdict === 'no-effect' ? '；界面未变化（序列可能未生效：换助记键，或先 keyboard_press("Alt") 点亮菜单栏再方向键+回车）' : '';
      return { ok: true, summary: `按键序列 ${seq.join(' → ')}${tail}` };
    }
    const combo = String(args.combo ?? '');
    if (!combo) return { ok: false, summary: '', error: 'keyboard_press 需要 combo（单个组合键）或 combos（有序序列，如 ["Alt+F","A"] 走菜单）' };
    const note = await verifyKeyEffect({ combo, action: () => keyboardPress(combo) });
    return { ok: true, summary: `已按键 ${combo}${note}` };
  }

  private async openApp(args: Record<string, unknown>): Promise<ToolResult> {
    await getHost().openApp(String(args.nameOrPath));
    // 启动是异步的：宿主已等窗口并尝试激活，这里等画面收敛后回报真实前台窗口（快路径 <400ms，
    // 慢界面最多多到 2.5s 上限；无稳定观测能力时退回旧的固定 400ms），模型不必盲点
    const st = await waitForStableFrame({ maxWaitMs: STABLE_MAX_WAIT_MS });
    if (st.rounds === 0) await sleep(OPEN_EFFECT_WAIT_MS);
    const fg = await foregroundTitle();
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
  /** 拉起 sidecar（幂等）并取当前 UIA 树；已降级（重启预算耗尽）时短路，让调用方立即走视觉定位 */
  private async uiTree() {
    const client = getUiaClient();
    if (client.degraded) throw new Error('UIA 不可用（sidecar 重启预算耗尽），降级视觉定位');
    if (!client.healthy) await client.start();
    return client.getUiTree({ maxDepth: 10, maxNodes: 1500 });
  }

  private async uiLocate(args: Record<string, unknown>): Promise<ToolResult> {
    // #ref 寻址（来自窗口索引）：优先于按名查询——重解析当前 rect 后返回可复用坐标与 ref
    if (args.ref !== undefined) return locateByRef(this.refCtx(), args);
    const query = String(args.query ?? '').trim();
    if (!query) return { ok: false, summary: '', error: 'ui_locate 需要 query（控件/图标名称的子串，如 "Qoder"、"保存"）或 ref（索引 #编号）' };
    // B1 找到即点：locate+click 合一（省一整个迭代），仅首个候选；守卫/穿透/验证沿用既有链
    const click = args.click === true;
    try {
      const tree = await this.uiTree();
      const all = flattenTree(tree.tree);
      const matches = searchMatches(all, query, Number(args.limit ?? 8));
      if (matches.length === 0) {
        // UIA 未命中 → grounding 降级链（DeepSeek 视觉定位，坐标由代码反归一化）
        const g = await groundingLookup(this.refCtx(), query);
        if (g) return click ? clickAfterLocate(this.refCtx(), g, args) : g;
        return { ok: false, summary: '', error: `未找到名称含「${query}」的元素（扫描 ${all.length} 个节点）。换更短的关键词，或回退为看图点击` };
      }
      const detail = formatLocateDetail(matches);
      // 登记给点击守卫：模型若拿坐标直点，会被提示改用 ui_click（UIA 中心无目测误差）
      this.guard.remember(matches.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, w: m.w, h: m.h })));
      // 新鲜索引里有同名元素时附送可复用 #ref（后续步骤 ui_click(ref) 免重查）
      const idxRef = getWindowIndex().refForName(matches[0]!.name);
      const refNote = idxRef !== undefined ? `；索引内同名 #${idxRef} 可用 ui_click(ref:${idxRef})` : '';
      // 重复查询检测：同 query 短时间内返回同一结果时升级警告，打断"locate→click→locate"空转
      const repeat = this.guard.locateRepeatNote(query, `${matches[0]!.id}@${Math.round(matches[0]!.center.x)},${Math.round(matches[0]!.center.y)}`);
      if (click) {
        const clicked = await uiClickTool(this.refCtx(), { ...args, elementId: matches[0]!.id });
        const summary = `找到${matches.length}个: ${detail}；已点击首个 #${matches[0]!.id} "${matches[0]!.name}"${repeat ?? ''}`;
        return clicked.ok ? { ok: true, summary: `${summary} → ${clicked.summary}`, data: { matches } } : { ...clicked, error: `${summary}；点击失败: ${clicked.error}` };
      }
      return {
        ok: true,
        summary: `找到${matches.length}个: ${detail}。点击请用 ui_click(elementId)，或 ui_locate(click:true) 找到即点${refNote}${repeat ?? ''}`,
        data: { matches },
      };
    } catch (err) {
      // UIA 整体不可用时也走 grounding 兜底
      const g = await groundingLookup(this.refCtx(), query).catch(() => null);
      if (g) return click ? clickAfterLocate(this.refCtx(), g, args) : g;
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
