// SoM（Set-of-Mark）视觉标注：在 grounding 截图上画候选框 + 编号标签。
// 真 SoM 的关键是"编号画在图上"——模型直接看图选编号，无需心算坐标对应关系。
// 红色矩形框 + 黑底黄字编号（复用 perception-grid 的点阵字体），纯像素绘制，零图像库依赖。
// 只作用于发给 SoM 模型的图；UIA 拿到的候选框坐标不受影响。
import { nativeImage } from 'electron';
import type { SomCandidate } from '@ximo-visagent/agent-core';
import { drawLabel } from './perception-grid';

/** 标签放大倍数（5x7 字体 × 2 = 10x14，1920 宽截图上模型可读） */
const LABEL_SCALE = 2;
/** 标签盒高度（gh + 上下 padding） */
const LABEL_BOX_H = 7 * LABEL_SCALE + 2 * LABEL_SCALE;

/** BGRA 写红像素（越界忽略） */
function setRed(bgra: Uint8Array, w: number, h: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  bgra[i] = 0;
  bgra[i + 1] = 0;
  bgra[i + 2] = 255;
  bgra[i + 3] = 255;
}

/** 画 2px 红色矩形边框（不填充，保持目标可见；越界部分自动裁剪） */
function drawRect(bgra: Uint8Array, w: number, h: number, x: number, y: number, rw: number, rh: number): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(w - 1, Math.round(x + rw) - 1);
  const y1 = Math.min(h - 1, Math.round(y + rh) - 1);
  if (x1 <= x0 || y1 <= y0) return;
  for (let px = x0; px <= x1; px++) {
    setRed(bgra, w, h, px, y0);
    setRed(bgra, w, h, px, Math.min(y1, y0 + 1));
    setRed(bgra, w, h, px, y1);
    setRed(bgra, w, h, px, Math.max(y0, y1 - 1));
  }
  for (let py = y0; py <= y1; py++) {
    setRed(bgra, w, h, x0, py);
    setRed(bgra, w, h, Math.min(x1, x0 + 1), py);
    setRed(bgra, w, h, x1, py);
    setRed(bgra, w, h, Math.max(x0, x1 - 1), py);
  }
}

/** 在 BGRA 位图上为每个候选画红框 + 编号标签（编号与候选列表一一对应） */
export function drawSomMarksPixels(bgra: Uint8Array, w: number, h: number, candidates: SomCandidate[]): void {
  for (const c of candidates) {
    drawRect(bgra, w, h, c.x, c.y, c.w, c.h);
    // 编号标签放框左上角上方；框贴屏幕顶时放框内顶部
    const lx = Math.round(c.x);
    const ly = Math.round(c.y) - LABEL_BOX_H - 2 >= 0 ? Math.round(c.y) - LABEL_BOX_H - 2 : Math.round(c.y) + 2;
    drawLabel(bgra, w, h, String(c.index), lx, ly, LABEL_SCALE);
  }
}

/** 包装：解码 JPEG → 画 SoM 标注 → 重编码（候选为空或解码失败时原样返回） */
export function withSomMarks(jpeg: Buffer, candidates: SomCandidate[]): Buffer {
  if (candidates.length === 0) return jpeg;
  try {
    const img = nativeImage.createFromBuffer(jpeg);
    const size = img.getSize();
    if (size.width <= 0 || size.height <= 0) return jpeg;
    const bgra = img.toBitmap();
    if (!bgra || bgra.length < size.width * size.height * 4) return jpeg;
    drawSomMarksPixels(bgra, size.width, size.height, candidates);
    return nativeImage.createFromBitmap(bgra, { width: size.width, height: size.height }).toJPEG(95);
  } catch {
    return jpeg; // 标注失败不阻塞定位链（退化为纯文本候选列表）
  }
}
