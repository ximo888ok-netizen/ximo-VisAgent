// UIA 元素树类型（与截图同物理像素坐标系）
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

export interface UiTreeResult {
  ok: boolean;
  total: number;
  cache: number;
  error?: string;
  tree?: UiNode;
}

export interface ElementRectResult {
  ok: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  error?: string;
}

// 树剪枝参数
export interface UiTreeOptions {
  maxDepth?: number; // 1-12，默认 6
  maxNodes?: number; // 50-2000，默认 800
}