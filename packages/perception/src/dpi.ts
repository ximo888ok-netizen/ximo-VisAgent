// DPI / 坐标换算（全链路统一物理像素；逻辑像素仅 UI 显示层）
import type { MonitorInfo, Point, Rect } from '@ximo-visagent/shared-types';

/** 物理像素 → 逻辑像素 */
export function pxToLogical(p: Point, scale: number): Point {
  return { x: p.x / scale, y: p.y / scale };
}

/** 逻辑像素 → 物理像素 */
export function logicalToPx(p: Point, scale: number): Point {
  return { x: Math.round(p.x * scale), y: Math.round(p.y * scale) };
}

/** 根据坐标反查所在监视器（scale 用于显示换算） */
export function monitorForPoint(
  monitors: MonitorInfo[],
  p: Point,
): MonitorInfo | undefined {
  return monitors.find((m) => isInside(m.rect, p));
}

function isInside(r: Rect, p: Point): boolean {
  return p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height;
}

export { Rect, Point, MonitorInfo };