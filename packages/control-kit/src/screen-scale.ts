// 截图坐标系 ↔ 物理像素坐标系换算（win32 预算债，勿并回 win32.ts）
// 宿主每帧截图后 setScreenScale(物理宽/截图宽)：模型输出的是截图系坐标，
// SendInput 注入和 UIA rect 都是物理像素。两个坐标系的桥在此集中。
let _scaleX = 1;
let _scaleY = 1;

/** 宿主截图后调用，设置截图坐标→物理像素的缩放比例 */
export function setScreenScale(scaleX: number, scaleY: number): void {
  _scaleX = scaleX > 0 ? scaleX : 1;
  _scaleY = scaleY > 0 ? scaleY : 1;
}

export function getScreenScale(): { x: number; y: number } {
  return { x: _scaleX, y: _scaleY };
}

/** 截图坐标 → 物理像素（SendInput 归一化前必经） */
export function screenshotToPhysical(x: number, y: number): { x: number; y: number } {
  return { x: x * _scaleX, y: y * _scaleY };
}

/** 物理像素 → 截图坐标（UIA rect 反馈给模型前必经） */
export function physicalToScreenshot(x: number, y: number): { x: number; y: number } {
  return { x: x / _scaleX, y: y / _scaleY };
}
