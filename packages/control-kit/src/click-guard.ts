// 点击守卫（自 executor.ts 拆出，纯逻辑无 IO，便于单测）：
//   1) 同位置连点熔断：24px 栅格归并，连续超过阈值直接拒绝执行
//   2) 熔断时给出该点附近的 UIA 元素候选（而不是替模型点别的元素）
//   3) 直点坐标命中近期 ui_locate 元素时提示改用 ui_click（UIA 中心无目测误差）

/** ui_locate 返回的元素（截图坐标系） */
export interface LocatedElement {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 同位置熔断阈值：24px 栅格归并坐标，连续超过此值直接拒绝执行 */
const GRID = 24;
const MAX_SAME_GRID_CLICKS = 3;
/** 登记的最近定位结果上限 */
const MAX_LOCATED = 8;
/** 熔断建议里最多列几个附近元素 */
const NEAREST_LIMIT = 3;

export class ClickGuard {
  private gridCounts = new Map<string, number>();
  private located: LocatedElement[] = [];

  /** ui_locate 成功后登记，供"直点提示"与"熔断建议"使用 */
  remember(elements: LocatedElement[]): void {
    this.located = elements.slice(0, MAX_LOCATED);
  }

  /** 点击前检查：返回非空 = 熔断，直接拒绝执行（附附近元素候选） */
  check(x: number, y: number): string | null {
    const key = `${Math.round(x / GRID)}_${Math.round(y / GRID)}`;
    const count = (this.gridCounts.get(key) ?? 0) + 1;
    this.gridCounts.set(key, count);
    if (count <= MAX_SAME_GRID_CLICKS) return null;
    this.gridCounts.set(key, 0);
    const near = this.nearest(x, y);
    const advice = near.length > 0
      ? `该点附近的 UIA 元素: ${near.map((m) => `#${m.id} "${m.name}"`).join('、')}——用 ui_click(#id) 点击`
      : '先用 ui_locate 定位控件名，或换坐标（至少偏移 50px）、改键盘快捷键';
    return `坐标 (${Math.round(x)},${Math.round(y)}) 附近已连续点击 ${count - 1} 次未生效，已熔断。${advice}。若目标已达成或无法继续，调 task_done。`;
  }

  /** 点击被视觉验证为生效 → 清零熔断计数（正常重复交互不该被误熔断） */
  noteEffective(): void {
    this.gridCounts.clear();
  }

  /** 该点落在近期 ui_locate 命中的元素内时，提示改用 ui_click */
  hintAt(x: number, y: number): string | null {
    const hit = this.located.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
    if (!hit) return null;
    return `；提示：该坐标属于 UIA 元素 #${hit.id} "${hit.name}"，下次请用 ui_click(${hit.id}) 精确点击`;
  }

  /** 距 (x,y) 最近的已登记元素（按中心距离升序，最多 NEAREST_LIMIT 个） */
  private nearest(x: number, y: number): LocatedElement[] {
    return [...this.located]
      .map((m) => ({ m, d: Math.hypot(m.x + m.w / 2 - x, m.y + m.h / 2 - y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAREST_LIMIT)
      .map((e) => e.m);
  }
}
