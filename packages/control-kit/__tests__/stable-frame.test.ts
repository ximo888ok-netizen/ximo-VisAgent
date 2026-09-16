// 稳定帧判定纯逻辑门禁（P1）：连续两轮一致 / 帧间变化率阈值 / 最少轮数防抖 /
// 超时返回 stable=false（有界 2.5s）/ 过渡样本不进结论窗口。
// 假 host 注入帧序列 + sleepFn 注入（零真实耗时、轮数确定）。
import { describe, expect, it } from 'vitest';
import { setHost, type HostCapabilities } from '../src/host';
import { STABLE_MAX_WAIT_MS, byteDiffRatio, waitForStableFrame } from '../src/stable-frame';

const noSleep = async (): Promise<void> => {};
const RECT = { x: 0, y: 0, w: 100, h: 100 };

function stubHost(overrides: Partial<HostCapabilities> = {}): void {
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

describe('waitForStableFrame 帧轮询判稳', () => {
  it('宿主未初始化（无观测能力）→ rounds=0 立即返回，调用方走旧兜底', async () => {
    const st = await waitForStableFrame({ rect: RECT, sleepFn: noSleep });
    expect(st).toEqual({ stable: false, waitedMs: 0, rounds: 0, samples: [] });
  });

  it('连续两轮帧间一致（字节相同）→ stable=true，2 轮即收口', async () => {
    stubHost(); // captureRegion 恒返回同一帧
    const st = await waitForStableFrame({ rect: RECT, sleepFn: noSleep });
    expect(st.stable).toBe(true);
    expect(st.rounds).toBe(2);
  });

  it('pHash 后端（分块指纹）：帧字节不同但指纹一致即稳，每轮仅一次截图', async () => {
    let captures = 0;
    stubHost({
      captureRegion: async () => Buffer.from(`f${++captures}`),
      frameSignature: async (jpeg) => (jpeg.toString().startsWith('f') ? 'SIG' : null),
    });
    const st = await waitForStableFrame({ rect: RECT, sleepFn: noSleep });
    expect(st.stable).toBe(true);
    expect(captures).toBe(3); // 首帧 + 2 轮
  });

  it('防抖：恰好两帧相同不算稳，其后帧又开始抖动 → 不判稳', async () => {
    let n = 0;
    stubHost({
      // 帧序列 a,a,x,a,x,…（字节差 >8 才算差异点）：头两帧相同，之后交替 → 永远凑不满"连续两轮一致"
      captureRegion: async () => Buffer.from(++n <= 2 ? 'a' : n % 2 === 1 ? 'x' : 'a'),
    });
    const st = await waitForStableFrame({ rect: RECT, maxWaitMs: 400, sleepFn: noSleep });
    expect(st.stable).toBe(false);
    expect(st.rounds).toBe(5); // 400/80：不提前误判，到上限收口
  });

  it('帧间变化率阈值：1/64≈1.6% 差异默认不算稳，threshold 放宽后算稳', async () => {
    let n = 0;
    stubHost({
      // 每帧在采样点 0 上交替（1KB 帧、步长 16 → 差异率恒 1/64）
      captureRegion: async () => {
        const buf = Buffer.alloc(1024, 7);
        if (n++ % 2 === 0) buf[0] = 99;
        return buf;
      },
    });
    const strict = await waitForStableFrame({ rect: RECT, maxWaitMs: 240, sleepFn: noSleep });
    expect(strict.stable).toBe(false);
    const loose = await waitForStableFrame({ rect: RECT, maxWaitMs: 240, threshold: 0.02, sleepFn: noSleep });
    expect(loose.stable).toBe(true);
    expect(loose.rounds).toBe(2);
  });

  it('超时上限：2.5s 处收口返回 stable=false，轮数不超过 maxWaitMs/pollGap（有界延迟）', async () => {
    let n = 0;
    stubHost({ captureRegion: async () => Buffer.from(n++ % 2 === 0 ? 'aaaa' : 'xxxx') }); // 帧帧不同
    const st = await waitForStableFrame({ rect: RECT, pollGapMs: 100, maxWaitMs: STABLE_MAX_WAIT_MS, sleepFn: noSleep });
    expect(st.stable).toBe(false);
    expect(st.rounds).toBe(25); // 2500/100：慢界面最多多等 2.5s，写进注释的有界保证
  });

  it('earlyExit：外部事件（前台窗口已切换）命中 → 立即停止等待', async () => {
    stubHost();
    let polls = 0;
    const st = await waitForStableFrame({ rect: RECT, sleepFn: noSleep, earlyExit: () => ++polls >= 1 });
    expect(st.stable).toBe(false);
    expect(st.rounds).toBe(1);
  });
});

describe('waitForStableFrame 分块 diff 侧采样（collectRound）', () => {
  it('帧1≠帧2=帧3 型过渡：结论样本只含稳定帧，过渡轮数据被清掉', async () => {
    type Round = { seq: number };
    const seq: Round[] = [{ seq: 1 }, { seq: 2 }, { seq: 2 }, { seq: 2 }];
    let i = 0;
    const st = await waitForStableFrame<Round>({
      sleepFn: noSleep,
      collectRound: async () => {
        const s = seq[Math.min(i, seq.length - 1)]!;
        i++;
        return s;
      },
    });
    expect(st.stable).toBe(true);
    expect(st.samples.map((s) => s.seq)).toEqual([2, 2, 2]); // 过渡帧 seq=1 不进结论
  });

  it('采样断裂（某轮返回 null）→ 立即结束 stable=false，调用方退回单次比对', async () => {
    const st = await waitForStableFrame({ collectRound: async () => null, sleepFn: noSleep });
    expect(st.stable).toBe(false);
    expect(st.rounds).toBe(1);
    expect(st.samples).toEqual([]);
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
