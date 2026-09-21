// #ref 寻址执行层：ui_index 工具（建/刷/检索索引）+ ui_click/ui_locate 的 ref 分支 + 观测包装。
// 优先级（与 window-index.ts 同一约定）：有新鲜索引时索引优先——ref 点击执行前必过
// resolveRefs 重解析；ground-cache 坐标表只在 UIA（侧车）不可用时兜底。
// 安全语义零削弱：ref 解析出的中心与目测坐标走完全相同的点击链（守卫/穿透/点击后校验照旧）；
// 解析失败绝不拿旧坐标硬点，直接报错引导 ui_index{refresh:true}。ui_index 本体 L0 只读。
import type { ToolExecutor, ToolResult } from '@ximo-visagent/agent-core';
import { flattenTree } from './ui-locate';
import { clickElementWithModifiers, ensureTargetForeground } from './click-focus';
import { captureBaseline, postClickVerify } from './click-verify';
import { verifyResultData } from './executor-result';
import { getWindowIndex, DEFAULT_SUMMARY_LIMIT } from './window-index';
import { foregroundDelta, foregroundTitle, type RefToolCtx } from './grounding-fallback';
import { fmtCoord } from './coord-normalize';

/** '#7' / 7 / '7' → 7；非法 → undefined（模型两种写法都收） */
export function parseRefArg(raw: unknown): number | undefined {
  const s = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : raw;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const REF_DEAD_HINT = '请 ui_index{refresh:true} 刷新索引后重选编号；禁止拿旧坐标硬点';

/** ui_index（常驻 L0 只读）：无参=报告已索引窗口；window=为指定窗口建/刷；filter=索引内检索 */
export async function uiIndexTool(args: Record<string, unknown>): Promise<ToolResult> {
  const store = getWindowIndex();
  const target = String(args.window ?? '').trim();
  const filter = String(args.filter ?? '').trim();
  const limit = Math.max(1, Math.min(80, Number(args.limit ?? DEFAULT_SUMMARY_LIMIT) || DEFAULT_SUMMARY_LIMIT));
  if (filter) {
    if (!store.indexed) return { ok: false, summary: '', error: `索引为空，无法检索「${filter}」。先 ui_index{window:"标题或pid"} 建索引` };
    const hits = store.filterEntries(filter, limit);
    if (hits.length === 0) return { ok: false, summary: '', error: `索引内无「${filter}」相关元素。ui_index{refresh:true} 刷新，或 ui_index{window:…} 换目标窗口` };
    const multi = new Set(hits.map((h) => h.hwnd)).size > 1;
    const lines = hits.map((h) => store.formatLine(h.el, multi ? h.winTitle : undefined));
    return { ok: true, summary: `索引检索「${filter}」命中 ${hits.length}${hits.length >= limit ? '（截断，可加大 limit 或换词）' : ''}：\n${lines.join('\n')}｜${store.statsLine()}`, data: { refs: hits.map((h) => h.el.ref) } };
  }
  if (target) {
    const t = await store.resolveWindowQuery(target);
    if (t.pid === undefined && t.hwnd === undefined) {
      return { ok: false, summary: '', error: `未找到窗口「${target}」。可见窗口: ${(t.candidates ?? []).join(' | ') || '无'}` };
    }
    const res = await store.buildFor({ pid: t.pid, hwnd: t.hwnd });
    if (!res.ok) return { ok: false, summary: '', error: `为「${target}」建索引失败（${res.reason}）：UIA 不可用，回退目测坐标/ui_locate` };
    const label = t.title ?? `pid ${t.pid}`;
    const body = store.formatSummary(limit) ?? '';
    return { ok: true, summary: `已索引「${label}」：${res.windows} 窗口 / ${res.elements} 元素（${res.added}+/${res.removed}-，${res.ms ?? 0}ms${res.truncated ? '，已截断' : ''}）${res.signatureChanged ? '' : '；结构签名未变'}\n${body}`, data: { elements: res.elements, truncated: res.truncated } };
  }
  if (args.refresh === true) {
    const res = await store.build();
    if (!res.ok) return { ok: false, summary: '', error: `刷新索引失败（${res.reason}）：UIA 不可用，回退目测坐标` };
    return { ok: true, summary: `索引已刷新：${res.windows} 窗口 / ${res.elements} 元素（${res.added}+/${res.removed}-，${res.ms ?? 0}ms）｜${store.statsLine()}` };
  }
  const rows = store.describeWindows();
  if (rows.length === 0) return { ok: true, summary: '尚无窗口索引：默认自动为前台窗口建（每步信号驱动）；也可 ui_index{window:"标题子串或pid"} 指定' };
  const lines = rows.map((r) => `「${r.title.slice(0, 24)}」${r.elements} 元素 · ${r.ageSteps} 步前`);
  return { ok: true, summary: `已索引窗口 ${rows.length} 个：\n${lines.join('\n')}｜${store.statsLine()}` };
}

/** ui_click(ref:#N)：重解析成功后点"当前"中心；失败按 REF_DEAD_HINT 引导（不得硬点旧坐标）。
 *  元素 id 路径（ui_locate 直查的 #id）行为与旧 uiClick 完全一致（每次重取树按 id 找）。 */
export async function uiClickTool(ctx: RefToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = parseRefArg(args.ref);
  const id = ref !== undefined ? undefined : Number(args.elementId);
  if (ref === undefined && (id === undefined || !Number.isFinite(id))) {
    return { ok: false, summary: '', error: 'ui_click 需要 ref（索引 #编号，如 7 或 "#7"）或 elementId（来自 ui_locate）' };
  }
  const key = ref !== undefined ? `r${ref}` : `e${id}`;
  const store = getWindowIndex();
  const clicks = (ctx.clickCounts.get(key) ?? 0) + 1;
  ctx.clickCounts.set(key, clicks);
  if (clicks > 3) {
    return { ok: false, summary: '', error: `目标 #${ref ?? id} 已点击 ${clicks - 1} 次仍无效果，已熔断。换方案：检查目标是否被窗口遮挡、activate_window 激活目标窗口、或改用键盘/其他工具` };
  }
  let cx: number;
  let cy: number;
  let label: string;
  let winNote: string;
  try {
    if (ref !== undefined) {
      const out = await store.resolveForClick(ref);
      if (!out.ok || !out.center) {
        // 失效已在索引内登记重建信号（禁用除外）：只告知，绝不落到旧坐标点击
        return { ok: false, summary: '', error: `#${ref} 失效：${out.why ?? '元素已不可解析'}。${REF_DEAD_HINT}` };
      }
      cx = out.center.x;
      cy = out.center.y;
      label = out.el?.name || out.el?.controlType || `#${ref}`;
      winNote = out.winTitle ? ` [${out.winTitle.slice(0, 14)}]` : '';
      store.noteRefClick();
    } else {
      // 元素 id 路径：每次点击都重取树（id 是 RuntimeId 哈希，界面变了会显式报「已不存在」防点错）
      const tree = await ctx.uiTree();
      const hit = flattenTree(tree.tree).find((m) => m.id === id);
      if (!hit) return { ok: false, summary: '', error: `元素 #${id} 已不存在（界面有变化），请重新 ui_locate` };
      cx = hit.center.x;
      cy = hit.center.y;
      label = hit.name;
      winNote = ` [${hit.window.slice(0, 14)}]`;
    }
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    const times = Number(args.times ?? 1);
    const fgBefore = times >= 2 ? await foregroundTitle() : null;
    // 与旧 uiClick 同链：前台/遮挡保证 → 基线 → 真实点击 → 双击前台反馈 → 点击后校验 → 守卫记账
    const focus = await ensureTargetForeground(cx, cy);
    const baseline = await captureBaseline(cx, cy);
    await clickElementWithModifiers(cx, cy, button, times, args.modifiers);
    ctx.overlay({ type: 'click', x: cx, y: cy });
    let summary = `真实点击 "${label}" 当前中心 @${fmtCoord(cx, cy)}${winNote}${ref !== undefined ? ` #ref${ref}` : ''}`;
    if (times >= 2) summary += await foregroundDelta(fgBefore);
    if (focus.note) summary += focus.note;
    const verify = baseline ? await postClickVerify(baseline) : null;
    if (verify) {
      summary += verify.note;
      if (verify.changed) {
        ctx.guard.noteEffective();
        ctx.clickCounts.delete(key);
      }
    }
    return { ok: true, summary, ...(verify ? { data: verifyResultData(verify) } : {}) };
  } catch (err) {
    return { ok: false, summary: '', error: `UIA 不可用(${(err as Error).message})，请回退为看图点击` };
  }
}

/** ui_locate(ref:#N)：把索引编号解析成"当前"坐标（不点击；click:true 时复用 ui_click 链）。
 *  返回 data.ref 让模型后续步骤直接复用。 */
export async function locateByRef(ctx: RefToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = parseRefArg(args.ref);
  if (ref === undefined) return { ok: false, summary: '', error: 'ui_locate 的 ref 需要正整数编号（如 7 或 "#7"，来自窗口索引/ui_index）' };
  const out = await getWindowIndex().resolveForClick(ref);
  if (!out.ok || !out.center) {
    return { ok: false, summary: '', error: `#${ref} 失效：${out.why ?? '元素已不可解析'}。${REF_DEAD_HINT}` };
  }
  if (args.click === true) return uiClickTool(ctx, args);
  const box = out.rect ?? { x: out.center.x, y: out.center.y, w: 1, h: 1 };
  return {
    ok: true,
    summary: `#${ref} "${out.el?.name || out.el?.controlType}" 当前中心${fmtCoord(out.center.x, out.center.y)}（路径 ${out.el?.path ?? ''}，索引仍新鲜）。复用请 ui_click(ref:${ref})`,
    data: { matches: [{ name: out.el?.name ?? '', ...box }], ref },
  };
}

/** 观测包装（desktop 组装根挂在执行器栈最外层）：写动作/画面变化信号喂给索引 + 点击占比统计 */
export function wrapExecutorWithIndex(executor: ToolExecutor): ToolExecutor {
  return {
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      getWindowIndex().noteAction(name, args);
      return executor.execute(name, args);
    },
  };
}
