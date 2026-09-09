// 点击验证单测：同区域前后帧比对（旧实现拿整屏 vs 区域裁剪比较，恒报"生效"）
import { describe, expect, it } from 'vitest';
import { setHost, type HostCapabilities } from '../src/host';
import { byteDiffRatio, captureBaseline, postClickVerify } from '../src/click-verify';

/** 装一个只实现截图/差异能力的宿主 */
function stubHost(overrides: Partial<HostCapabilities>): void {
  const base: HostCapabilities = {
    captureScreen: async () => Buffer.from('shot'),
    captureRegion: async () => Buffer.from('region'),
    readClipboard: async () => '',
    writeClipboard: async () => {},
    getForegroundInfo: async () => ({ title: '', className: '' }),
    openApp: async () => {},
  };
  setHost({ ...base, ...overrides });
}

describe('captureBaseline', () => {
  it('以点击点为中心取 300x300，贴边时原点 clamp 到 0', async () => {
    let seen: number[] = [];
    stubHost({
      captureRegion: async (x, y, w, h) => {
        seen = [x, y, w, h];
        return Buffer.from('before');
      },
    });
    const b = await captureBaseline(1000, 800);
    expect(seen).toEqual([850, 650, 300, 300]);
    expect(b?.rect).toEqual({ x: 850, y: 650, w: 300, h: 300 });

    await captureBaseline(40, 30);
    expect(seen).toEqual([0, 0, 300, 300]);
  });

  it('宿主无 captureRegion 能力 → 返回 null（跳过验证而不是报假结论）', async () => {
    stubHost({ captureRegion: undefined });
    expect(await captureBaseline(100, 100)).toBeNull();
  });
});

describe('postClickVerify', () => {
  it('区域确有变化 → 判定生效（changed=true）', async () => {
    stubHost({ regionDiff: async () => 0.42 });
    const out = await postClickVerify({ rect: { x: 0, y: 0, w: 300, h: 300 }, jpeg: Buffer.from('a') });
    expect(out?.changed).toBe(true);
    expect(out?.note).toContain('点击生效');
    expect(out?.note).toContain('42.0%');
  });

  it('区域无变化 → 判定未生效并给出换方案建议', async () => {
    stubHost({ regionDiff: async () => 0 });
    const out = await postClickVerify({ rect: { x: 0, y: 0, w: 300, h: 300 }, jpeg: Buffer.from('a') });
    expect(out?.changed).toBe(false);
    expect(out?.note).toContain('可能未生效');
    expect(out?.note).toContain('ui_locate');
  });

  it('宿主解码失败（尺寸不一致等）→ null，不给模型假信号', async () => {
    stubHost({ regionDiff: async () => null });
    expect(await postClickVerify({ rect: { x: 0, y: 0, w: 300, h: 300 }, jpeg: Buffer.from('a') })).toBeNull();
  });

  it('无 regionDiff 能力时回退同区域字节抽样', async () => {
    let calls = 0;
    stubHost({
      regionDiff: undefined,
      captureRegion: async () => {
        calls++;
        return Buffer.from(calls === 1 ? 'same-bytes' : 'same-bytes');
      },
    });
    const out = await postClickVerify({ rect: { x: 0, y: 0, w: 300, h: 300 }, jpeg: Buffer.from('same-bytes') });
    expect(out?.changed).toBe(false);
  });
});

describe('byteDiffRatio', () => {
  it('字节完全相同 → 0', () => {
    expect(byteDiffRatio(Buffer.from('abc'), Buffer.from('abc'))).toBe(0);
  });

  it('空 buffer 不抛异常', () => {
    expect(byteDiffRatio(Buffer.alloc(0), Buffer.from('x'))).toBe(0);
  });
});
