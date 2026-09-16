// 悬停反馈的纯 diff 逻辑：停留前后两次 UIA 快照对比出「悬停期间新出现的节点」
// 局限（mouse-hover 会把局限如实写进 summary）：
//  - 快照来自 flattenTree：只有「有名/可交互 + 有矩形 + 在屏内」的节点入表，无名自绘 tooltip 会漏报；
//  - 停留结束后才取后快照：一闪而过的节点（停留期间出现又消失）看不到；
//  - 节点按 id（RuntimeId 哈希）比对：tooltip 常复用同一宿主句柄换新内容，id 不变时计不进新增。

export interface HoverNodeSnapshot {
  id: number;
  name: string;
  type: string;
}

export interface HoverDiff {
  newCount: number;
  /** 新增节点展示名（截断上限内），无名节点显示类型 */
  names: string[];
}

/** 进 summary 的新节点名上限：反馈是给模型看一眼的，不是全量清单 */
const MAX_REPORT_NAMES = 6;

/** before/after 任一为 null（UIA 不可用）→ null：调用方按「无法回报」措辞 */
export function diffNewNodes(
  before: HoverNodeSnapshot[] | null,
  after: HoverNodeSnapshot[] | null,
): HoverDiff | null {
  if (!before || !after) return null;
  const known = new Set(before.map((n) => n.id));
  const added = after.filter((n) => !known.has(n.id));
  return {
    newCount: added.length,
    names: added.slice(0, MAX_REPORT_NAMES).map((n) => n.name || n.type),
  };
}
