// 点击验证单测：同区域前后帧比对（旧实现拿整屏 vs 区域裁剪比较，恒报"生效"）
// + 变化区域定向读（分块 diff → 稳定命中并集 bbox → 只对该区域 OCR，全部替身不碰真实 OCR/设备）
import { describe, expect, it } from 'vitest';
import { setHost, type HostCapabilities } from '../src/host';
import { byteDiffRatio, captureBaseline, postClickVerify } from '../src/click-verify';
import type { OcrHit } from '../src/ocr-lookup';

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

// ---------- 变化区域定向读 ----------

const BASELINE = { rect: { x: 850, y: 650, w: 300, h: 300 }, jpeg: Buffer.from('before') };
const blk = (x: number, y: number): { x: number; y: number; w: number; h: number } => ({ x, y, w: 32, h: 32 });
/** 三块拼出的稳定小区域：并集 (64,64) 起 96x32，面积占比 ~3.4%（局部小变化） */
const STABLE_BLOCKS = [blk(64, 64), blk(96, 64), blk(128, 64)];

/** 分块 diff 全轮命中同一组块的宿主 + 记录定向 OCR 的取帧矩形 */
function blocksHost(blocksPerSample = STABLE_BLOCKS, ratio = 0.2) {
  const captured: Array<{ x: number; y: number; w: number; h: number }> = [];
  stubHost({
    regionDiff: undefined,
    captureRegion: async (x, y, w, h) => {
      captured.push({ x, y, w, h });
      return Buffer.from('region');
    },
    regionDiffBlocks: async () => ({ ratio, blocks: blocksPerSample.map((b) => ({ ...b })) }),
  });
  return captured;
}

const recognizeHits = (text: string) => async (): Promise<OcrHit[] | null> => [{ text, x: 0, y: 0, w: 10, h: 10 }];

describe('postClickVerify 变化区域定向读', () => {
  it('稳定命中块 → 并集 bbox + 只对该区域 OCR（外扩后截屏坐标），文本拼进 note', async () => {
    const captured = blocksHost();
    const out = await postClickVerify(BASELINE, { recognize: recognizeHits('已保存到磁盘') });
    expect(out?.changed).toBe(true);
    expect(out?.regionBbox).toEqual({ x: 64, y: 64, w: 96, h: 32 });
    expect(out?.regionOcr).toBe('已保存到磁盘');
    expect(out?.note).toContain('变化区域 OCR: "已保存到磁盘"');
    // baseline 由测试直接给定，captureRegion 唯一一次调用 = 定向 OCR 取帧（bbox 外扩 6px 后加区域原点）
    expect(captured).toEqual([{ x: 908, y: 708, w: 108, h: 44 }]);
  });

  it('瞬态噪声块（每轮命中不同块，无稳定交集）→ 不产生变化区域，也不跑 OCR', async () => {
    let call = 0;
    const samples = [[blk(0, 0)], [blk(96, 96)], [blk(192, 0)]];
    stubHost({
      captureRegion: async () => Buffer.from('region'),
      regionDiffBlocks: async () => ({ ratio: 0.2, blocks: samples[call++ % samples.length]! }),
    });
    const out = await postClickVerify(BASELINE, { recognize: recognizeHits('不该被调用') });
    expect(out?.changed).toBe(true);
    expect(out?.regionBbox).toBeNull();
    expect(out?.regionOcr).toBeNull();
    expect(out?.note).not.toContain('变化区域 OCR');
  });

  it('OCR 不可用（识别返回 null）→ 退回整帧语义：保留 bbox，不加 OCR 行、不阻塞', async () => {
    blocksHost();
    const out = await postClickVerify(BASELINE, { recognize: async () => null });
    expect(out?.regionBbox).not.toBeNull();
    expect(out?.regionOcr).toBeNull();
    expect(out?.note).not.toContain('变化区域 OCR');
    expect(out?.note).toContain('点击生效');
  });

  it('变化区域过大（面积占比超阈值）→ 不做定向读，不发区域截图', async () => {
    const captured = blocksHost([blk(0, 0), blk(160, 0), blk(0, 160), blk(160, 160), blk(268, 268)]);
    captured.length = 0;
    const out = await postClickVerify(BASELINE, { recognize: recognizeHits('不该出现') });
    expect(out?.regionBbox).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    expect(out?.regionOcr).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it('宿主无 regionDiffBlocks 能力 → 保持旧整帧路径，结构化字段为 null', async () => {
    stubHost({ regionDiff: async () => 0.42, regionDiffBlocks: undefined });
    const out = await postClickVerify(BASELINE);
    expect(out?.changed).toBe(true);
    expect(out?.regionBbox).toBeNull();
    expect(out?.regionOcr).toBeNull();
  });
});
