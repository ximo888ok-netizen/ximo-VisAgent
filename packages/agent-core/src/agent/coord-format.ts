// agent-core 侧坐标格式化：归一化模式（0-1000）下把截图像素坐标转回 0-1000 给模型看。
// 不依赖 control-kit（agent-core 不引用 control-kit），用本模块维护的截图尺寸。
// 与 control-kit/coord-normalize.ts 的 fmtCoord 对应，各管各的依赖层。

/** 归一化坐标模式开关（0-1000 坐标系） */
const COORD_NORMALIZED = process.env.AGENT_COORD_MODE === 'normalized';
const NORM_MAX = 1000;

/** 最近截图尺寸（loop 每帧更新，供 fmtCoordAgent 格式化坐标用） */
let _lastImgW = 0;
let _lastImgH = 0;

/** loop 每帧截图后调用，更新截图尺寸 */
export function updateAgentImageSize(w: number, h: number): void {
  _lastImgW = w;
  _lastImgH = h;
}

/** 是否启用归一化坐标 */
export function isCoordNormalized(): boolean {
  return COORD_NORMALIZED;
}

/**
 * 格式化坐标给模型看：归一化模式下把截图像素坐标转回 0-1000 再格式化。
 * 用于 agent-core 侧的 summary / 感知文本等反馈给模型的文本。
 */
export function fmtCoordAgent(x: number, y: number): string {
  if (!COORD_NORMALIZED) return `(${Math.round(x)},${Math.round(y)})`;
  if (_lastImgW <= 0 || _lastImgH <= 0) return `(${Math.round(x)},${Math.round(y)})`;
  const nx = Math.round((x / _lastImgW) * NORM_MAX);
  const ny = Math.round((y / _lastImgH) * NORM_MAX);
  return `(${nx},${ny})`;
}
