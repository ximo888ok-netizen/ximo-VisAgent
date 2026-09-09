// 鼠标轨迹生成：三阶贝塞尔曲线 + 确定性微抖动（纯函数，便于单测）
/** 弧线最大偏移（px）：旧实现按 dist*15% 偏移，长距离一次横扫半个屏幕，
 *  会扫过菜单栏/悬浮面板触发 hover 态。封顶后仍非直线，但不再横穿其他控件。 */
const MAX_CURVE_OFFSET = 40;
/** 微抖动幅度（px）：正弦扰动代替随机数——同参数轨迹可复现，失败可归因 */
const JITTER_AMPLITUDE = 1.5;

/** 确定性伪随机 [0,1)：同坐标恒定，用于选弧线方向与第二控制点偏移 */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b);
  h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * 生成从 (x1,y1) 到 (x2,y2) 的鼠标轨迹点。
 * 点数根据距离动态调整，短距离少点、长距离多点；终点恒为精确目标。
 */
export function generatePath(x1: number, y1: number, x2: number, y2: number): Array<{ x: number; y: number }> {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 3) return [{ x: x2, y: y2 }];
  // 点数：距离越远点越多，但限制在 15~60
  const numPoints = Math.max(15, Math.min(60, Math.floor(dist / 8)));
  // 贝塞尔控制点：偏离直线，制造弧线
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  // 垂直方向偏移：方向与幅度都由终点坐标决定（确定性），幅度封顶
  const offset = Math.min(MAX_CURVE_OFFSET, Math.max(6, dist * 0.08)) * (hash2(x2, y2) > 0.5 ? 1 : -1);
  const angle = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
  const cp1x = midX + Math.cos(angle) * offset;
  const cp1y = midY + Math.sin(angle) * offset;
  // 第二个控制点：靠近终点，偏移由起点坐标决定（确定性）
  const wobble = (hash2(x1, y1) - 0.5) * 8;
  const cp2x = x2 - (x2 - x1) * 0.25 + wobble;
  const cp2y = y2 - (y2 - y1) * 0.25 + wobble;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    // 三阶贝塞尔
    const mt = 1 - t;
    const bx = mt * mt * mt * x1 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x2;
    const by = mt * mt * mt * y1 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y2;
    // 中段微抖动（起止两端不抖，保证落点干净）
    const jitter = t < 0.1 || t > 0.9 ? 0 : Math.sin(t * Math.PI * 3) * JITTER_AMPLITUDE;
    pts.push({ x: Math.round(bx + jitter), y: Math.round(by + jitter) });
  }
  // 确保终点精确
  pts[pts.length - 1] = { x: x2, y: y2 };
  return pts;
}
