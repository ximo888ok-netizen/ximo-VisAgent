// 感知网格绘制单测：网格线位置 / 标尺标签盒 / 混合透明度（纯 BGRA 位图，无 electron 依赖）
import { describe, expect, it } from 'vitest';
import { drawGridPixels } from '../src/main/perception-grid';

function makeBuf(w: number, h: number): Uint8Array {
  // 全灰底（B=G=R=128）
  return new Uint8Array(w * h * 4).fill(128);
}

function px(buf: Uint8Array, w: number, x: number, y: number): [number, number, number] {
  const i = (y * w + x) * 4;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
}

describe('drawGridPixels（感知帧坐标网格）', () => {
  it('在 100px 间隔画网格线（黄色混合 → G/R 抬高、B 压低），非网格线位置不变', () => {
    const buf = makeBuf(300, 300);
    drawGridPixels(buf, 300, 300);
    const [b1, g1] = px(buf, 300, 100, 150);
    expect(g1).toBeGreaterThan(128); // 混入黄色
    expect(b1).toBeLessThan(128);
    const [b2, g2] = px(buf, 300, 50, 150);
    expect(g2).toBe(128);
    expect(b2).toBe(128);
    const [, g3] = px(buf, 300, 200, 150); // 500 主线不存在于 300 宽内，200 为普通线
    expect(g3).toBeGreaterThan(128);
  });

  it('顶边标尺标签：黑底盒（像素压黑）出现在 (104,4) 附近', () => {
    const buf = makeBuf(400, 300);
    drawGridPixels(buf, 400, 300);
    // "100" 标签盒起点 ≈ (104,4)，盒内非笔画列（x=盒起点+1）为黑底 B=G=R=0
    const [b, g, r] = px(buf, 400, 105, 8);
    expect(b).toBe(0);
    expect(g).toBe(0);
    expect(r).toBe(0);
  });

  it('左侧标尺标签出现在 y=100 刻度旁', () => {
    const buf = makeBuf(300, 400);
    drawGridPixels(buf, 300, 400);
    const [b, g, r] = px(buf, 300, 5, 108);
    expect(b).toBe(0);
    expect(g).toBe(0);
    expect(r).toBe(0);
  });

  it('不越界：小尺寸图（60x60，无网格线无标签）不抛错不改像素', () => {
    const buf = makeBuf(60, 60);
    expect(() => drawGridPixels(buf, 60, 60)).not.toThrow();
    expect(px(buf, 60, 30, 30)).toEqual([128, 128, 128]);
  });
});
