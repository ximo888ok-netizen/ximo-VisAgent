// 鼠标轨迹单测：确定性、终点精确、弧线幅度封顶（去随机后必须可复现）
import { describe, expect, it } from 'vitest';
import { generatePath } from '../src/cursor-path';

describe('generatePath', () => {
  it('同参数两次调用结果完全一致（无随机数）', () => {
    const a = generatePath(100, 100, 900, 700);
    const b = generatePath(100, 100, 900, 700);
    expect(a).toEqual(b);
  });

  it('终点精确落在目标点', () => {
    const pts = generatePath(0, 0, 1920, 1080);
    expect(pts[pts.length - 1]).toEqual({ x: 1920, y: 1080 });
  });

  it('短距离（<3px）只发一个点，不做弧线', () => {
    expect(generatePath(10, 10, 11, 11)).toEqual([{ x: 11, y: 11 }]);
  });

  it('长距离弧线偏移封顶（不再横扫半个屏幕）', () => {
    const pts = generatePath(0, 500, 1900, 500);
    const maxDev = Math.max(...pts.map((p) => Math.abs(p.y - 500)));
    expect(maxDev).toBeLessThanOrEqual(45); // 弧线 40 + 抖动 1.5 + 取整
  });

  it('点数随距离增长但有上下限', () => {
    expect(generatePath(0, 0, 100, 0).length).toBeGreaterThanOrEqual(15);
    expect(generatePath(0, 0, 5000, 0).length).toBeLessThanOrEqual(61); // numPoints+1
  });
});
