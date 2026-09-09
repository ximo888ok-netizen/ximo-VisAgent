// 感知帧坐标网格：发给模型的截图叠加 100px 网格 + 顶/左标尺（Set-of-Mark 式 grounding）
// 纯像素绘制（内嵌 5x7 点阵数字字体），零图像库依赖。只作用于感知帧；
// captureNative（放大/审批证据）保持干净，否则网格线会污染定位精度。
// AGENT_NO_GRID=1 关闭（A/B 诊断用）。
import { nativeImage, type NativeImage } from 'electron';

/** 5x7 点阵数字字体（每行 5bit，MSB=左） */
const DIGIT_FONT: Record<string, number[]> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

const FONT_W = 5;
const FONT_H = 7;

/** BGRA 像素写入（黄色，半透明混合） */
function blendPixel(bgra: Uint8Array, w: number, x: number, y: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 4;
  bgra[i] = Math.round(bgra[i]! * (1 - alpha) + 0 * alpha); // B
  bgra[i + 1] = Math.round(bgra[i + 1]! * (1 - alpha) + 255 * alpha); // G
  bgra[i + 2] = Math.round(bgra[i + 2]! * (1 - alpha) + 255 * alpha); // R
  bgra[i + 3] = 255;
}

function drawVLine(bgra: Uint8Array, w: number, h: number, x: number, alpha: number, thickness = 1): void {
  for (let y = 0; y < h; y++) {
    for (let t = 0; t < thickness; t++) blendPixel(bgra, w, x + t, y, alpha);
  }
}

function drawHLine(bgra: Uint8Array, w: number, y: number, alpha: number, thickness = 1): void {
  for (let x = 0; x < w; x++) {
    for (let t = 0; t < thickness; t++) blendPixel(bgra, w, x, y + t, alpha);
  }
}

/** 黑底 + 黄色点阵数字标签（scale 为字体放大倍数；SoM 编号标注复用，见 som-mark.ts） */
export function drawLabel(bgra: Uint8Array, w: number, h: number, text: string, x: number, y: number, scale: number): void {
  const gw = FONT_W * scale;
  const gh = FONT_H * scale;
  const boxW = text.length * (gw + scale) + scale;
  const boxH = gh + 2 * scale;
  // 黑底盒（提高任意底色上的可读性）
  for (let dy = 0; dy < boxH; dy++) {
    for (let dx = 0; dx < boxW; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      bgra[i] = 0;
      bgra[i + 1] = 0;
      bgra[i + 2] = 0;
      bgra[i + 3] = 255;
    }
  }
  let cx = x + scale;
  for (const ch of text) {
    const glyph = DIGIT_FONT[ch];
    if (!glyph) { cx += gw + scale; continue; }
    for (let gy = 0; gy < FONT_H; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < FONT_W; gx++) {
        if (((bits >> (FONT_W - 1 - gx)) & 1) === 0) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            blendPixel(bgra, w, cx + gx * scale + sx, y + scale + gy * scale + sy, 1);
          }
        }
      }
    }
    cx += gw + scale;
  }
}

/**
 * 在 BGRA 位图上绘制坐标网格：100px 细网格线 + 500px 主线，
 * 顶边标注 x 刻度、左边标注 y 刻度（截图坐标系，与模型输出坐标一致）。
 */
export function drawGridPixels(bgra: Uint8Array, w: number, h: number, pitch = 100, scale = 2): void {
  for (let x = pitch; x < w; x += pitch) {
    const major = x % (pitch * 5) === 0;
    drawVLine(bgra, w, h, x, major ? 0.55 : 0.3, major ? 2 : 1);
  }
  for (let y = pitch; y < h; y += pitch) {
    const major = y % (pitch * 5) === 0;
    drawHLine(bgra, w, y, major ? 0.55 : 0.3, major ? 2 : 1);
  }
  // 标尺标签：顶边 x（跳过最右侧避免溢出）、左边 y（跳过最底部避免溢出）
  for (let x = pitch; x <= w - 60; x += pitch) drawLabel(bgra, w, h, String(x), x + 4, 4, scale);
  for (let y = pitch; y <= h - 24; y += pitch) drawLabel(bgra, w, h, String(y), 4, y + 4, scale);
}

/** 感知帧包装：叠加坐标网格后重编码 JPEG（AGENT_NO_GRID=1 时直通） */
export function withCoordinateGrid(img: NativeImage, quality = 95): Buffer {
  if (process.env.AGENT_NO_GRID === '1') return img.toJPEG(quality);
  const size = img.getSize();
  if (size.width <= 0 || size.height <= 0) return img.toJPEG(quality);
  const bgra = img.toBitmap();
  if (!bgra || bgra.length < size.width * size.height * 4) return img.toJPEG(quality);
  drawGridPixels(bgra, size.width, size.height);
  return nativeImage.createFromBitmap(bgra, { width: size.width, height: size.height }).toJPEG(quality);
}
