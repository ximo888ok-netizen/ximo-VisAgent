// 自绘 UI 图标区域探测单测
import { describe, expect, it } from 'vitest';
import {
  resizeGray,
  gradientMagnitude,
  binarize,
  dilate,
  labelConnected,
  filterIconRegions,
  detectIconRegions,
  type GrayImage,
} from '../src/icon-detect';
import { iconBoxesToSom } from '../src/grounding-fallback';

/** 构造纯灰度图：指定尺寸 + 全部填充同一灰度值 */
function solidGray(w: number, h: number, val: number): GrayImage {
  return { gray: new Uint8Array(w * h).fill(val), w, h };
}

/** 在灰度图上画一个矩形块（指定区域填指定灰度值） */
function drawRect(img: GrayImage, x: number, y: number, rw: number, rh: number, val: number): void {
  for (let py = y; py < Math.min(img.h, y + rh); py++) {
    for (let px = x; px < Math.min(img.w, x + rw); px++) {
      img.gray[py * img.w + px] = val;
    }
  }
}

/** 构造带图标的模拟截图：浅色背景 + 深色方块图标 */
function mockScreenWithIcons(): GrayImage {
  // 1920x1080 → 缩到 480 宽后 48px 原图 = 12px 缩略
  const img = solidGray(1920, 1080, 240); // 浅灰背景
  // 3 个图标：左上、中间、右下（各 48x48px 原图，灰度 60 = 深色）
  drawRect(img, 100, 50, 48, 48, 60);
  drawRect(img, 500, 300, 64, 64, 50);
  drawRect(img, 1000, 700, 32, 32, 70);
  return img;
}

describe('resizeGray', () => {
  it('缩小到指定宽度并保持等比', () => {
    const img = solidGray(1920, 1080, 128);
    const small = resizeGray(img, 480);
    expect(small.w).toBe(480);
    expect(small.h).toBe(270); // 1080 * 480/1920 = 270
  });

  it('宽度 ≤ 目标时不缩放（拷贝）', () => {
    const img = solidGray(200, 100, 128);
    const out = resizeGray(img, 400);
    expect(out.w).toBe(200);
    expect(out.h).toBe(100);
  });
});

describe('gradientMagnitude', () => {
  it('纯色图梯度全 0', () => {
    const img = solidGray(10, 10, 128);
    const g = gradientMagnitude(img);
    expect(g.every((v) => v === 0)).toBe(true);
  });

  it('有边缘的图梯度非零', () => {
    const img = solidGray(10, 10, 0);
    drawRect(img, 5, 0, 5, 10, 255); // 右半 255
    const g = gradientMagnitude(img);
    // 至少边界处有非零梯度
    expect(g.some((v) => v > 0)).toBe(true);
  });
});

describe('binarize', () => {
  it('高于阈值 → 1，低于 → 0', () => {
    const g = new Uint8Array([0, 10, 29, 30, 31, 50, 255]);
    const b = binarize(g, 30);
    expect(Array.from(b)).toEqual([0, 0, 0, 0, 1, 1, 1]);
  });
});

describe('dilate', () => {
  it('全背景 → 全 0', () => {
    const w = 5, h = 5;
    const binary = new Uint8Array(w * h);
    const out = dilate(binary, w, h, 3);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('单像素 → 3 轮膨胀成 7x7 区域', () => {
    const w = 20, h = 20;
    const binary = new Uint8Array(w * h);
    binary[10 * w + 10] = 1; // 中心单像素
    const out = dilate(binary, w, h, 3);
    // 3 轮 4-连通膨胀 → 上下左右各扩 3 像素
    // 中心 (10,10) + 上下左右 3 像素 → 7px 宽 十字形（4-连通膨胀）
    // 中心行 (10,7)-(10,13) = 7 像素
    // 4-连通膨胀 3 轮 → 曼哈顿距离 ≤3 的菱形：1+2*1*(1+2+3)+2*4*0 = 25 像素
    let count = 0;
    for (let i = 0; i < w * h; i++) if (out[i] === 1) count++;
    expect(count).toBe(25);
    expect(out[10 * w + 10]).toBe(1); // 中心仍为 1
    expect(out[10 * w + 13]).toBe(1); // 右扩 3
    expect(out[10 * w + 14]).toBe(0); // 右扩 4 = 0
    expect(out[7 * w + 10]).toBe(1);  // 上扩 3
  });

  it('边缘框框 → 膨胀合并成实心块', () => {
    const w = 10, h = 10;
    const binary = new Uint8Array(w * h);
    // 画一个 4x4 空心框框（只在边缘）
    for (let x = 2; x <= 5; x++) {
      binary[2 * w + x] = 1; // 上边
      binary[5 * w + x] = 1; // 下边
    }
    for (let y = 2; y <= 5; y++) {
      binary[y * w + 2] = 1; // 左边
      binary[y * w + 5] = 1; // 右边
    }
    const out = dilate(binary, w, h, 2);
    // 膨胀后内部应该被填充
    expect(out[3 * w + 3]).toBe(1); // 内部
    expect(out[4 * w + 4]).toBe(1); // 内部
  });
});

describe('labelConnected', () => {
  it('全背景 → 空数组', () => {
    const binary = new Uint8Array(10 * 10); // 全 0
    const regions = labelConnected(binary, 10, 10);
    expect(regions).toEqual([]);
  });

  it('单个连通块 → 1 个区域', () => {
    const w = 5, h = 5;
    const binary = new Uint8Array(w * h);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) binary[y * w + x] = 1;
    const regions = labelConnected(binary, w, h);
    expect(regions.length).toBe(1);
    expect(regions[0]!.pixelCount).toBe(9);
    expect(regions[0]!.x).toBe(1);
    expect(regions[0]!.y).toBe(1);
    expect(regions[0]!.w).toBe(3);
    expect(regions[0]!.h).toBe(3);
  });

  it('两个不相连的块 → 2 个区域', () => {
    const w = 10, h = 5;
    const binary = new Uint8Array(w * h);
    binary[0 * w + 0] = 1; binary[0 * w + 1] = 1; // 左上
    binary[4 * w + 8] = 1; binary[4 * w + 9] = 1; // 右下
    const regions = labelConnected(binary, w, h);
    expect(regions.length).toBe(2);
  });

  it('对角连通（4-连通不连通）→ 2 个区域', () => {
    const w = 3, h = 3;
    const binary = new Uint8Array(w * h);
    binary[0] = 1; binary[4] = 1; // 对角线，4-连通不连通
    const regions = labelConnected(binary, w, h);
    expect(regions.length).toBe(2);
  });
});

describe('filterIconRegions', () => {
  it('过滤掉太小和太大的区域', () => {
    // scaleFromBinary=4（480 宽 → 1920 宽）
    const regions = [
      { id: 0, pixelCount: 5, x: 0, y: 0, w: 2, h: 2 },   // 太小（面积<50）
      { id: 1, pixelCount: 100, x: 10, y: 10, w: 10, h: 10 }, // 40x40 原图 → 合理
      { id: 2, pixelCount: 5000, x: 0, y: 0, w: 100, h: 100 }, // 太大（面积>3000）
    ];
    const out = filterIconRegions(regions, 4);
    expect(out.length).toBe(1);
    expect(out[0]!.w).toBe(40);
  });

  it('过滤掉长条形（长宽比 > 3）', () => {
    const regions = [
      { id: 0, pixelCount: 100, x: 0, y: 0, w: 50, h: 2 }, // 200x8 原图 = 长条
    ];
    const out = filterIconRegions(regions, 4);
    expect(out.length).toBe(0);
  });
});

describe('detectIconRegions（完整管线）', () => {
  it('纯色截图 → 无图标候选', () => {
    const img = solidGray(1920, 1080, 200);
    const boxes = detectIconRegions(img);
    expect(boxes).toEqual([]);
  });

  it('带图标的模拟截图 → 检测到图标区域', () => {
    const img = mockScreenWithIcons();
    const boxes = detectIconRegions(img);
    expect(boxes.length).toBeGreaterThan(0);
    // 检测到的区域短边应在 [12, 120] 范围内
    for (const b of boxes) {
      expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(12);
      expect(Math.max(b.w, b.h)).toBeLessThanOrEqual(120);
    }
  });

  it('检测到的区域映射回原图坐标系', () => {
    const img = mockScreenWithIcons();
    const boxes = detectIconRegions(img);
    // 原图 1920 宽 → 缩到 480 → scaleFromBinary = 4
    // 原图 100,50 处的 48x48 图标 → 缩略图约 (25, 12) 处 12x12
    // 检测到的区域应覆盖原图约 (100, 50) 附近
    const near100 = boxes.find((b) => Math.abs(b.x - 100) < 60 && Math.abs(b.y - 50) < 60);
    expect(near100).toBeDefined();
  });
});

describe('iconBoxesToSom（图标区域 → SoM 候选映射）', () => {
  it('图标区域 → SomCandidate，label 含中心坐标', () => {
    const boxes = [
      { x: 100, y: 50, w: 48, h: 48 },
      { x: 500, y: 300, w: 64, h: 64 },
    ];
    const som = iconBoxesToSom(boxes);
    expect(som.length).toBe(2);
    expect(som[0]!.label).toContain('124'); // 中心 x = 100+24 = 124
    expect(som[0]!.label).toContain('74');  // 中心 y = 50+24 = 74
    expect(som[0]!.x).toBe(100);
    expect(som[0]!.w).toBe(48);
    expect(som[0]!.index).toBe(0); // index 由 mergeSomCandidates 重排
  });

  it('空输入 → 空输出', () => {
    expect(iconBoxesToSom([])).toEqual([]);
  });

  it('超过上限截断', () => {
    const boxes = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: 0, w: 20, h: 20 }));
    const som = iconBoxesToSom(boxes);
    expect(som.length).toBeLessThanOrEqual(60);
  });
});
