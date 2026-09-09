import { describe, expect, it } from 'vitest';
import { MindiffChangeDetector, hammingDistance, pHash64 } from '../src/screen';
import { indexTree } from '../src/locator';
import { monitorForPoint, logicalToPx, pxToLogical } from '../src/dpi';
import type { UiTreeResult } from '@ximo-visagent/shared-types';

function makeImage(blocks: { x: number; y: number; w: number; h: number; v: number }[]): Uint8Array {
  const size = 256;
  const buf = new Uint8Array(size * size * 4).fill(0);
  for (const b of blocks) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = (y * size + x) * 4;
        buf[i] = b.v; buf[i + 1] = b.v; buf[i + 2] = b.v; buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

describe('变化检测', () => {
  it('首帧必发，相同帧不发', () => {
    const d = new MindiffChangeDetector(8, 0);
    const img = makeImage([{ x: 0, y: 0, w: 128, h: 128, v: 255 }]);
    expect(d.isChanged(img, 256, 256)).toBe(true); // 首帧
    expect(d.isChanged(img, 256, 256)).toBe(false); // 相同
  });

  it('明显变化触发', () => {
    const d = new MindiffChangeDetector(8, 0);
    const a = makeImage([{ x: 0, y: 0, w: 128, h: 128, v: 255 }]);
    const b = makeImage([{ x: 128, y: 0, w: 128, h: 128, v: 255 }]); // 白块位置右移
    d.isChanged(a, 256, 256);
    expect(d.isChanged(b, 256, 256)).toBe(true);
  });

  it('汉明距离正确', () => {
    expect(hammingDistance('1010', '1010')).toBe(0);
    expect(hammingDistance('1010', '1001')).toBe(2);
  });

  it('pHash 生成 64bit 固定长度', () => {
    const size = 256;
    const buf = new Uint8Array(size * size * 4).fill(128);
    const h = pHash64(buf, size, size);
    expect(h.length).toBe(64); // 8x8 = 64bit
  });
});

describe('locator 元素索引', () => {
  it('展平树并按 id 解析 center', () => {
    const tree: UiTreeResult = {
      ok: true,
      total: 3,
      cache: 2,
      tree: {
        id: 1,
        type: 'Window',
        x: 0, y: 0, w: 100, h: 100,
        children: [
          { id: 2, type: 'Button', name: 'ok', x: 10, y: 10, w: 20, h: 20 },
        ],
      },
    };
    const map = indexTree(tree);
    expect(map.size).toBe(2);
    const btn = map.get(2);
    expect(btn?.center).toEqual({ x: 20, y: 20 });
    expect(map.get(999)).toBeUndefined();
  });
});

describe('DPI 换算', () => {
  it('逻辑/物理像素互转', () => {
    const p = logicalToPx({ x: 480, y: 270 }, 2);
    expect(p).toEqual({ x: 960, y: 540 });
    expect(pxToLogical(p, 2)).toEqual({ x: 480, y: 270 });
  });

  it('monitorForPoint 命中多显示器', () => {
    const monitors = [
      { index: 0, rect: { left: 0, top: 0, width: 1920, height: 1080 }, scale: 1.5, isPrimary: true },
      { index: 1, rect: { left: 1920, top: 0, width: 1920, height: 1080 }, scale: 1, isPrimary: false },
    ];
    expect(monitorForPoint(monitors, { x: 100, y: 100 })?.index).toBe(0);
    expect(monitorForPoint(monitors, { x: 3000, y: 500 })?.index).toBe(1);
  });
});