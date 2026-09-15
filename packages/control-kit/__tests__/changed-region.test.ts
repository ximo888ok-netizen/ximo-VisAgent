// 变化区域定向读纯逻辑单测：diff 块列表 → 合并 bbox → 局部小变化判定 → 屏幕坐标映射
import { describe, expect, it } from 'vitest';
import {
  areaRatio,
  bboxToScreen,
  isLocalSmallChange,
  mergeChangedBlocks,
  type Box,
} from '../src/changed-region';

const block = (x: number, y: number, size = 32): Box => ({ x, y, w: size, h: size });

describe('mergeChangedBlocks', () => {
  it('多轮稳定命中的块取并集 bbox', () => {
    const samples = [
      [block(64, 64), block(96, 64)],
      [block(64, 64), block(96, 64)],
      [block(64, 64), block(96, 64)],
    ];
    expect(mergeChangedBlocks(samples, { minHits: 2 })).toEqual({ x: 64, y: 64, w: 64, h: 32 });
  });

  it('瞬态噪声块（只命中 1 轮）被过滤，不参与并集', () => {
    const samples = [
      [block(0, 0), block(64, 64)],
      [block(64, 64)],
      [block(64, 64), block(200, 200)],
    ];
    expect(mergeChangedBlocks(samples, { minHits: 2 })).toEqual({ x: 64, y: 64, w: 32, h: 32 });
  });

  it('每轮命中块都不同（无稳定变化）→ null', () => {
    const samples = [[block(0, 0)], [block(64, 64)], [block(128, 128)]];
    expect(mergeChangedBlocks(samples, { minHits: 2 })).toBeNull();
  });

  it('同一轮内重复命中只计 1 次', () => {
    const samples = [[block(0, 0), block(0, 0)], [block(64, 64)], [block(64, 64)]];
    expect(mergeChangedBlocks(samples, { minHits: 2 })).toEqual({ x: 64, y: 64, w: 32, h: 32 });
  });

  it('并集边长小于 minSide → 视为噪声返回 null', () => {
    const tiny = block(10, 10, 8);
    const samples = [[tiny], [tiny], [tiny]];
    expect(mergeChangedBlocks(samples, { minHits: 1, minSide: 12 })).toBeNull();
  });

  it('单轮采样传 minHits=1 即退化为直接并集', () => {
    const samples = [[block(0, 96), block(32, 96)]];
    expect(mergeChangedBlocks(samples, { minHits: 1 })).toEqual({ x: 0, y: 96, w: 64, h: 32 });
  });
});

describe('面积占比与坐标映射', () => {
  const region: Box = { x: 0, y: 0, w: 300, h: 300 };

  it('areaRatio = bbox 面积 / 区域面积', () => {
    expect(areaRatio({ x: 0, y: 0, w: 150, h: 150 }, region)).toBeCloseTo(0.25);
  });

  it('区域尺寸非法 → 占比按 1 处理（铺满，不算局部）', () => {
    expect(areaRatio(block(0, 0, 10), { x: 0, y: 0, w: 0, h: 0 })).toBe(1);
  });

  it('isLocalSmallChange 按阈值判定', () => {
    expect(isLocalSmallChange({ x: 0, y: 0, w: 100, h: 100 }, region, 0.5)).toBe(true); // 11.1%
    expect(isLocalSmallChange({ x: 0, y: 0, w: 300, h: 300 }, region, 0.5)).toBe(false); // 100%
  });

  it('bboxToScreen：区域局部坐标 + 区域原点 = 屏幕坐标', () => {
    expect(bboxToScreen(block(64, 96), { x: 850, y: 650, w: 300, h: 300 })).toEqual({
      x: 914,
      y: 746,
      w: 32,
      h: 32,
    });
  });
});
