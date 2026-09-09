// SoM 标注绘制单测：红框位置 / 编号标签盒 / 不填充内部 / 越界安全（纯 BGRA 位图，无 electron 依赖）
import { describe, expect, it } from 'vitest';
import { drawSomMarksPixels } from '../src/main/som-mark';

function makeBuf(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(128); // 全灰底 B=G=R=128
}

function px(buf: Uint8Array, w: number, x: number, y: number): [number, number, number] {
  const i = (y * w + x) * 4;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
}

describe('drawSomMarksPixels（SoM 画图标注）', () => {
  it('画红色边框（B=0 G=0 R=255），框内部不填充保持原样', () => {
    const buf = makeBuf(200, 200);
    drawSomMarksPixels(buf, 200, 200, [{ index: 1, label: '发送', x: 50, y: 50, w: 40, h: 30 }]);
    // 上边框（厚度 2）
    expect(px(buf, 200, 70, 50)).toEqual([0, 0, 255]);
    expect(px(buf, 200, 70, 51)).toEqual([0, 0, 255]);
    // 左边框
    expect(px(buf, 200, 50, 65)).toEqual([0, 0, 255]);
    // 框内部不变（只有边框线被画）
    expect(px(buf, 200, 70, 65)).toEqual([128, 128, 128]);
  });

  it('编号标签画在框上方：黑底盒出现在 (50, 50-20) 附近', () => {
    const buf = makeBuf(200, 200);
    drawSomMarksPixels(buf, 200, 200, [{ index: 1, label: '发送', x: 50, y: 50, w: 40, h: 30 }]);
    // "1" 标签盒起点 ≈ (50, 50-20=30)，盒内左上角为黑底（B=G=R=0）
    const [b, g, r] = px(buf, 200, 51, 31);
    expect(b).toBe(0);
    expect(g).toBe(0);
    expect(r).toBe(0);
  });

  it('框贴屏幕顶时标签放框内，不越界不抛错', () => {
    const buf = makeBuf(200, 200);
    expect(() =>
      drawSomMarksPixels(buf, 200, 200, [
        { index: 12, label: 'x', x: 0, y: 0, w: 60, h: 40 },
        { index: 13, label: 'y', x: 190, y: 190, w: 60, h: 60 },
      ]),
    ).not.toThrow();
    // 标签盒在框内顶部 (0+2, 0+2) 附近为黑底
    expect(px(buf, 200, 3, 3)[0]).toBe(0);
  });
});
