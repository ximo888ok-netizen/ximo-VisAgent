// UIA 辅助定位纯逻辑：树展平 + 按名搜索 + 物理坐标→截图坐标换算
// 无 IO（sidecar 拉取与点击在 executor），保证纯 Node 单测可加载（A3）
import type { UiNode } from '@ximo-visagent/shared-types';
import { getScreenScale } from './screen-scale';

export interface UiMatch {
  id: number;
  name: string;
  type: string;
  /** 所在顶层窗口标题（顶层窗口自身或 isWindow 节点的名字） */
  window: string;
  /** 截图坐标系（与 mouse_click 同一坐标系） */
  x: number;
  y: number;
  w: number;
  h: number;
  center: { x: number; y: number };
}

function physRectToShot(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const s = getScreenScale();
  return { x: x / s.x, y: y / s.y, w: w / s.x, h: h / s.y };
}

/** 可点击控件类型（无名也收进 SoM 候选；Custom 排除——自绘软件里过多且无语义） */
const CLICKABLE_TYPES = new Set([
  'Button', 'SplitButton', 'MenuItem', 'TabItem', 'ListItem', 'CheckBox',
  'RadioButton', 'Hyperlink', 'TreeItem', 'DataItem', 'HeaderItem',
]);

/** 控件类型短名：sidecar 输出 "ControlType.Button"，单测树用 "Button"，统一去前缀 */
export function shortType(type: string): string {
  return type.startsWith('ControlType.') ? type.slice('ControlType.'.length) : type;
}

/** 解析菜单路径为各级名称：按 > 分隔，去掉助记键括号 "(F)" 与省略号 "…"，trim、去空。
 *  "文件(F)>另存为(A)..." → ["文件","另存为"]（menu_select 逐级按名定位用）。 */
export function parseMenuPath(raw: string): string[] {
  return (raw ?? '')
    .split('>')
    .map((s) => s.replace(/\([^)]*\)/g, '').replace(/[.…]+$/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 深度优先展平「有名称 + 有矩形 + 不在屏外」的节点。
 *  window 归属：树根与其直接子节点（即顶层窗口）的名字，后续节点继承最近的窗口名。
 *  includeUnnamed=true 时额外收无名可交互控件（name 显示为 "(类型)"），
 *  供 SoM 编号选择用：自绘/Chromium 应用的可点击控件常无 Name，但有矩形即可点。 */
export function flattenTree(root: UiNode | undefined, limit = 2000, includeUnnamed = false): UiMatch[] {
  if (!root) return [];
  const out: UiMatch[] = [];
  const visit = (n: UiNode, win: string, depth: number): void => {
    if (out.length >= limit) return;
    const winName = (depth <= 1 || n.isWindow) && n.name ? n.name : win;
    const hasRect = n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined;
    const st = shortType(n.type);
    const keep = hasRect && !n.offscreen && (n.name || (includeUnnamed && CLICKABLE_TYPES.has(st)));
    if (keep) {
      const r = physRectToShot(n.x!, n.y!, n.w!, n.h!);
      out.push({
        id: n.id,
        name: n.name || `(${st})`,
        type: n.type,
        window: winName,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      });
    }
    for (const c of n.children ?? []) visit(c, winName, depth + 1);
  };
  visit(root, '', 0);
  return out;
}

/** SoM 候选收集：有名 + 无名可交互控件（截断上限，视觉模型按编号选择） */
export function collectCandidates(root: UiNode | undefined, limit = 120): UiMatch[] {
  return flattenTree(root, limit, true);
}

/** SoM 候选限定前台窗口：候选来自全桌面 UIA 树，后台窗口元素画到截图上不可见，
 *  模型按编号选择时会选中屏幕上不存在的元素（实测连续 5 次选中同一后台窗口元素，点击全部落空）。
 *  前台窗口无候选时回退全量（宁可多候选，不可零候选）。 */
export function filterForegroundCandidates(all: UiMatch[], fgTitle: string | null): UiMatch[] {
  if (!fgTitle) return all;
  const b = fgTitle.trim().toLowerCase();
  if (!b) return all;
  const fg = all.filter((m) => sameWindow(m.window, b));
  return fg.length > 0 ? fg : all;
}

/** 窗口归属判定：UIA 顶层窗口名与 Win32 前台标题可能存在前后缀差异，双向包含判定 */
function sameWindow(win: string, fgLower: string): boolean {
  const a = win.trim().toLowerCase();
  return a !== '' && (a === fgLower || a.includes(fgLower) || fgLower.includes(a));
}

/** 判定某窗口名是否属于前台窗口标题（供每步元素清单裁剪用；清单只要前台，不做全量回退） */
export function windowMatches(win: string, fgTitle: string): boolean {
  return sameWindow(win, fgTitle.trim().toLowerCase());
}

/** 放大图定位框映射回截图坐标（origin/zoom 来自 host.captureZoom：截图坐标 = origin + 放大图像素 / zoom） */
export function zoomedBoxToScreen(
  box: { x: number; y: number; w: number; h: number },
  origin: { x: number; y: number },
  zoom: number,
): { x: number; y: number; w: number; h: number } {
  if (zoom <= 0) return box;
  return { x: origin.x + box.x / zoom, y: origin.y + box.y / zoom, w: box.w / zoom, h: box.h / zoom };
}

/** 名称子串匹配（大小写不敏感）：全等命中排最前，其余按面积降序（图标主体 > 文字碎屑） */
export function searchMatches(all: UiMatch[], query: string, limit = 8): UiMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter((m) => m.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        (b.name.toLowerCase() === q ? 1 : 0) - (a.name.toLowerCase() === q ? 1 : 0) ||
        b.w * b.h - a.w * a.h,
    )
    .slice(0, limit);
}

// ---------- 给模型的定位摘要：候选必须带坐标，否则模型拿到的只是名字（坐标在 data 里等于没有） ----------

/** 候选 ≤8（ui_locate 默认 limit）时每条都带坐标：一条 ~34 字符（≈25 token），8 条 ≈200 token，
 *  换来的是模型能按位置消歧 + 可直接引用中心点。候选更多说明目标高度歧义，坐标表越长歧义不降反升
 *  （模型该换更精确的词或按窗口消歧），故只给前 4 条坐标，其余留名字行控预算。 */
const COORD_ALL_LIMIT = 8;
const COORD_TOP_N = 4;

/** 单条候选摘要：#id "名称"(类型) @(中心x,中心y 宽x高) [窗口]；withCoords=false 时省略坐标段 */
export function formatLocateLine(m: UiMatch, withCoords: boolean): string {
  const coords = withCoords
    ? ` @(${Math.round(m.center.x)},${Math.round(m.center.y)} ${Math.round(m.w)}x${Math.round(m.h)})`
    : '';
  return `#${m.id} "${m.name}"(${m.type})${coords} [${m.window}]`;
}

/** 候选列表摘要（含 token 预算纪律，见 COORD_ALL_LIMIT 注释）：>8 个时前 4 带坐标 + 尾部提示 */
export function formatLocateDetail(matches: UiMatch[]): string {
  const coordLimit = matches.length <= COORD_ALL_LIMIT ? matches.length : COORD_TOP_N;
  const detail = matches.map((m, i) => formatLocateLine(m, i < coordLimit)).join('；');
  return matches.length <= COORD_ALL_LIMIT
    ? detail
    : `${detail}（候选较多：仅前 ${COORD_TOP_N} 条带坐标，请换更精确关键词或用窗口/位置消歧）`;
}

// ---------- 查询词与候选名相关性校验（防跨窗口/跨任务残留候选被盲点） ----------

/** 三态结论：match=有共同字符依据；unknown=无名占位候选（SoM 主场景，名字无判据）；mismatch=零字符交集 */
export function nameRelevance(query: string, name: string): 'match' | 'unknown' | 'mismatch' {
  if (name.startsWith('(')) return 'unknown';
  const q = query.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  if (!q || !n) return 'unknown';
  if (n.includes(q) || q.includes(n)) return 'match';
  const qc = new Set(q);
  for (const ch of n) if (qc.has(ch)) return 'match';
  return 'mismatch';
}

/** SoM 选中的候选名与查询词毫不相干时的警示语（'' = 无需标注）。
 *  取舍：标注而非直接过滤——SoM 服务的是无名图标场景（名字相关度天然低），且候选坐标来自
 *  UIA 像素级矩形，风险在"选错候选"而非"坐标错"；直接过滤会让图标定位整档失效。
 *  实测事故（查询「卸载」返回「番茄意面」「13.mp4」模型照点）由本警示 + 任务边界清理兜底。
 *  拼音首字母比对未纳入：查询与候选名同为界面原文，拼音只帮"用户拼音输入"场景，边际收益小。 */
export function somMismatchNote(query: string, name: string): string {
  return nameRelevance(query, name) === 'mismatch'
    ? `；⚠候选名"${name.slice(0, 16)}"与查询「${query}」毫不相干（疑似残留/错窗候选）：先对照截图核实再点，或换关键词`
    : '';
}
