// 共享类型：全仓库统一使用的核心数据类型
export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };

// UIA 树节点（剪枝后，与截图同物理像素坐标系）
export interface UiNode {
  id: number;
  type: string;
  name?: string;
  automationId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  enabled?: boolean;
  offscreen?: boolean;
  isWindow?: boolean;
  children?: UiNode[];
}

// 窗口信息
export interface WindowInfo {
  hwnd: number;
  title: string;
  className: string;
  rect: Rect;
  visible: boolean;
  pid: number;
}

export interface MonitorInfo {
  index: number;
  rect: Rect;
  scale: number;
  isPrimary: boolean;
}