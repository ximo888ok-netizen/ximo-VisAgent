// 点击守卫（自 executor.ts 拆出，纯逻辑无 IO，便于单测）：
//   1) 同目标连点熔断：**±60px 近邻归并**（旧版 24px 栅格——实测遥测里 50% 是"±60px 重瞄"，
//      落进不同栅格就绕过熔断；改近邻归并后抖动计入同一点连击，第 4 次熔断）
//   2) 坐标失效拉黑：observe-policy 判「该坐标无效」(switch 档) 后，执行器调 invalidate() 拉黑，
//      此后落在失效半径内的点击直接拒执——把"已放弃路径"从文案提醒升级为参数级拉黑
//   3) 熔断/拉黑时给出该点附近的 UIA 元素候选（而不是替模型点别的元素）
//   4) 直点坐标命中近期 ui_locate 元素时提示改用 ui_click（UIA 中心无目测误差）

import { fmtCoord } from './coord-normalize';

/** ui_locate 返回的元素（截图坐标系） */
export interface LocatedElement {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 近邻归并半径（px）：对齐遥测阈值——两次点击中心距 < 此值算"冲同一个目标重瞄" */
const PROX_RADIUS = 60;
/** 同一目标连续无效点击阈值：超过此数直接拒绝执行（生效即清零，正常重复交互不误伤） */
const MAX_INEFFECTIVE_CLICKS = 3;
/** 登记的最近定位结果上限 */
const MAX_LOCATED = 8;
/** 熔断建议里最多列几个附近元素 */
const NEAREST_LIMIT = 3;
/** ui_locate 同词重复查询的判定窗口（实测病理：同一 query 被查询 27 次返回同一过期元素） */
const LOCATE_REPEAT_TTL_MS = 120_000;

/** 一个"目标点"的近邻连击轨迹（锚点为首次落点，命中半径内的后续点击累加计数） */
interface ClickRegion { x: number; y: number; count: number; }
/** 同一 query 的重复查询统计（sig = 首个命中元素签名，结果变化即视为新查询） */
interface LocateStat { count: number; lastAt: number; sig: string; }

export class ClickGuard {
  private regions: ClickRegion[] = [];
  private invalid: { x: number; y: number }[] = [];
  private located: LocatedElement[] = [];
  private locateStats = new Map<string, LocateStat>();

  /** ui_locate 成功后登记，供"直点提示"与"熔断建议"使用 */
  remember(elements: LocatedElement[]): void {
    this.located = elements.slice(0, MAX_LOCATED);
  }

  /** 任务边界清理：清空跨步登记的候选、连击轨迹、失效坐标与重复查询统计
   *  （上一任务的元素/前科不该再提示给下一任务） */
  forget(): void {
    this.located = [];
    this.regions = [];
    this.invalid = [];
    this.locateStats.clear();
  }

  /** ui_locate 重复查询检测：同 query 短时间内返回同一结果时给出升级警告（null = 首次/结果已变化）。
   *  sig 为本次首个命中元素签名（id@中心坐标）：界面真变了 sig 会变，计数自动重置，不误伤合法重查。 */
  locateRepeatNote(query: string, sig: string): string | null {
    const now = Date.now();
    const prev = this.locateStats.get(query);
    if (!prev || now - prev.lastAt > LOCATE_REPEAT_TTL_MS || prev.sig !== sig) {
      this.locateStats.set(query, { count: 1, lastAt: now, sig });
      return null;
    }
    prev.count += 1;
    prev.lastAt = now;
    if (prev.count < 3) {
      return `；注意：「${query}」短时间内已第 ${prev.count} 次查询，结果与上次相同`;
    }
    return `；⚠「${query}」已连续查询 ${prev.count} 次且结果未变——重复查询不会得到新结果。禁止再 ui_locate 该关键词：直接 ui_click 返回的 #id、看截图 mouse_click、或 task_done 说明卡点原因`;
  }

  /** 标记坐标失效（由执行器在 observe-policy 判 switch 档时调用）：半径内后续点击直接拒执。 */
  invalidate(x: number, y: number): void {
    this.invalid.push({ x, y });
    // 顺带清掉该目标的连击轨迹：拉黑是更强的信号，不再靠计数兜
    this.dropRegionNear(x, y);
  }

  /** 点击前检查：返回非空 = 拒绝执行（已熔断或已拉黑），附附近元素候选与替代路径 */
  check(x: number, y: number): string | null {
    const blockedBy = this.invalid.find((p) => this.dist(p.x, p.y, x, y) < PROX_RADIUS);
    if (blockedBy) {
      return `坐标 ${fmtCoord(x, y)} 已被判定为无效点（此前动作后目标区无变化，与 ${fmtCoord(blockedBy.x, blockedBy.y)} 同属一点），已拒绝点击。${this.nearestAdvice(x, y)}`;
    }
    const region = this.regions.find((r) => this.dist(r.x, r.y, x, y) < PROX_RADIUS)
      ?? (this.regions.push({ x, y, count: 0 }), this.regions[this.regions.length - 1]!);
    region.count += 1;
    if (region.count <= MAX_INEFFECTIVE_CLICKS) return null;
    // 熔断后移除该轨迹（软熔断：下一次重新给预算，不永久锁死坐标）
    this.regions = this.regions.filter((r) => r !== region);
    return `坐标 ${fmtCoord(x, y)} 附近已连续点击 ${region.count - 1} 次未生效，已熔断。${this.nearestAdvice(x, y)}。若目标已达成或无法继续，调 task_done。`;
  }

  /** 点击被视觉验证为生效 → 清零连击计数（正常重复交互不该被误熔断）。不清失效拉黑：拉黑来自"区域确认无变化"，需显式换路径才解 */
  noteEffective(): void {
    this.regions = [];
  }

  /** 该点落在近期 ui_locate 命中的元素内时，提示改用 ui_click */
  hintAt(x: number, y: number): string | null {
    const hit = this.located.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
    if (!hit) return null;
    return `；提示：该坐标属于 UIA 元素 #${hit.id} "${hit.name}"，下次请用 ui_click(${hit.id}) 精确点击`;
  }

  private nearestAdvice(x: number, y: number): string {
    const near = this.nearest(x, y);
    return near.length > 0
      ? `该点附近的 UIA 元素: ${near.map((m) => `#${m.id} "${m.name}"`).join('、')}——用 ui_click(#id) 点击`
      : '改用 ui_locate 精确定位控件后走 ui_click(#id)/清单中心坐标，或键盘快捷键；勿凭感觉偏移坐标（小图标偏移 50px 必点飞）';
  }

  private dist(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(ax - bx, ay - by);
  }

  private dropRegionNear(x: number, y: number): void {
    this.regions = this.regions.filter((r) => this.dist(r.x, r.y, x, y) >= PROX_RADIUS);
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
