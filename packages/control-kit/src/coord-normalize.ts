// 相对 0-1000 坐标系换算：模型输出 0-1000 范围的归一化坐标，
// 此模块在执行器入口换算回截图像素坐标，后续 screenshotToPhysical 链路不变。
//
// 设计参考：UI-TARS-desktop 的 0-1000 relative coordinate system。
// ximo 适配：不替换物理像素坐标系，而是在模型输出端加一层归一化包装。
//
// 模式切换：AGENT_COORD_MODE=normalized 启用 0-1000 模式（默认 pixel 物理像素模式）。
// 启用后：
//   1. perception-grid 画 0-1000 网格（替代 100px 网格）
//   2. 感知文本告知模型"坐标 0-1000"
//   3. 执行器入口把 0-1000 → 截图像素
//   4. screenshotToPhysical 链路不变

/** 坐标系模式 */
export type CoordMode = 'pixel' | 'normalized';

/** 归一化坐标范围上限 */
export const NORMALIZED_MAX = 1000;

let _mode: CoordMode = process.env.AGENT_COORD_MODE === 'normalized' ? 'normalized' : 'pixel';

/** 最近一帧截图尺寸（HostPerception.snapshot 每帧更新，执行器入口读用） */
let _lastImageW = 0;
let _lastImageH = 0;

/** 更新最近截图尺寸（宿主每帧截图后调用） */
export function updateLastImageSize(w: number, h: number): void {
  _lastImageW = w;
  _lastImageH = h;
}

/** 获取最近截图尺寸 */
export function getLastImageSize(): { w: number; h: number } {
  return { w: _lastImageW, h: _lastImageH };
}

/** 获取当前坐标系模式 */
export function getCoordMode(): CoordMode {
  return _mode;
}

/** 是否启用归一化坐标 */
export function isNormalized(): boolean {
  return _mode === 'normalized';
}

/** 设置坐标系模式（运行时切换，供配置热更新用） */
export function setCoordMode(mode: CoordMode): void {
  _mode = mode;
}

/**
 * 归一化坐标 (0-1000) → 截图像素坐标
 * @param val 模型输出的 0-1000 坐标
 * @param dim 截图宽度或高度（像素）
 * @returns 截图像素坐标
 */
export function normalizedToPixel(val: number, dim: number): number {
  return Math.round((val / NORMALIZED_MAX) * dim);
}

/**
 * 截图像素坐标 → 归一化坐标 (0-1000)
 * @param px 截图像素坐标
 * @param dim 截图宽度或高度
 * @returns 0-1000 归一化坐标
 */
export function pixelToNormalized(px: number, dim: number): number {
  return dim > 0 ? Math.round((px / dim) * NORMALIZED_MAX) : 0;
}

/**
 * 批量换算动作参数中的坐标：如果是归一化模式且参数含 x/y 坐标，
 * 用截图尺寸换算回像素。就地修改 args 并返回。
 *
 * 处理的工具和坐标字段：
 *   - mouse_click / mouse_hover / mouse_move / mouse_hold / mouse_scroll: x, y
 *   - mouse_drag / mouse_drag_hold: from.{x,y}, to.{x,y}
 *   - look_close: x, y, w, h
 *   - screen_ocr: x, y, w, h
 *
 * @param toolName 工具名
 * @param args 工具参数（就地修改）
 * @param imgW 截图宽度（像素）
 * @param imgH 截图高度（像素）
 */
export function denormalizeActionArgs(
  toolName: string,
  args: Record<string, unknown>,
  imgW: number,
  imgH: number,
): void {
  if (!isNormalized()) return;
  if (imgW <= 0 || imgH <= 0) return;

  // 单坐标工具：x, y
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    args.x = normalizedToPixel(args.x, imgW);
    args.y = normalizedToPixel(args.y, imgH);
  }
  // 区域尺寸工具：w, h（也需归一化→像素）
  if (typeof args.w === 'number' && typeof args.h === 'number') {
    args.w = normalizedToPixel(args.w, imgW);
    args.h = normalizedToPixel(args.h, imgH);
  }
  // 拖拽工具：from.{x,y}, to.{x,y}
  if (args.from && typeof args.from === 'object') {
    const f = args.from as { x?: number; y?: number };
    if (typeof f.x === 'number' && typeof f.y === 'number') {
      f.x = normalizedToPixel(f.x, imgW);
      f.y = normalizedToPixel(f.y, imgH);
    }
  }
  if (args.to && typeof args.to === 'object') {
    const t = args.to as { x?: number; y?: number };
    if (typeof t.x === 'number' && typeof t.y === 'number') {
      t.x = normalizedToPixel(t.x, imgW);
      t.y = normalizedToPixel(t.y, imgH);
    }
  }
}

/**
 * 格式化坐标给模型看：归一化模式下把截图像素坐标转回 0-1000 再格式化。
 * 用于 summary 等反馈给模型的文本。
 */
export function fmtCoord(x: number, y: number): string {
  if (!isNormalized()) return `(${Math.round(x)},${Math.round(y)})`;
  const { w, h } = getLastImageSize();
  if (w <= 0 || h <= 0) return `(${Math.round(x)},${Math.round(y)})`;
  return `(${pixelToNormalized(x, w)},${pixelToNormalized(y, h)})`;
}
