// 几何 / 坐标类型（全链路统一物理像素）
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MonitorInfo {
  index: number;
  rect: Rect; // 物理像素
  scale: number; // 逻辑像素缩放系数
  isPrimary: boolean;
}