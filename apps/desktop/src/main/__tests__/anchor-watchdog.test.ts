/**
 * anchor-watchdog.test.ts — A-M3 前台看门狗
 *
 * A. anchor-watchdog.ts 纯逻辑三分支（离开 / 回归 / 进程退出）+ Q8 已确认参数边界：
 *    N=120s（119.9s 不暂停 / 120.1s 暂停）、回前台 5s 内自动续跑、未见过存活不误签收口、
 *    暂停时长累计（计时冻结的补偿量）。
 * B. anchor-watchdog-host.ts 装配层：注入探针/时钟/播报与假 loop，验证副作用只由信号驱动
 *    （pause/resume/cancel 各恰好一次）、无锚任务返回 null（零回归）、采样失败绝不暂停。
 * C. foreground-proc.ts 的纯函数部分（进程族基名推导）；pid→exe 真机判定属 selftest 门。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchorWatchdog, DEFAULT_IDLE_MS, DEFAULT_RESUME_WINDOW_MS } from '../anchor-watchdog';
import { familyBasenamesOf } from '../foreground-proc';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean { return false; }
    show(): void { /* 测试环境无桌面 */ }
  },
}));
vi.mock('../windows/island', () => ({ publishStep: vi.fn() }));

const T0 = 1_000_000;

/** 造一条采样：默认「在族内 + 族存活」 */
function sample(over: Partial<{ now: number; inFamily: boolean; alive: boolean }> = {}) {
  return {
    now: over.now ?? T0,
    foregroundInFamily: over.inFamily ?? true,
    familyAlive: over.alive ?? true,
  };
}

describe('A. 状态机：离开 → 暂停（N=120s）', () => {
  it('离开 119.9s 仍 RUNNING，120.1s 才 PAUSE（已确认参数 N=120s）', () => {
    const short = new AnchorWatchdog({ now: () => T0 });
    expect(short.tick(sample({ now: T0, inFamily: false })).signal).toBe('NONE');
    const at119_900 = short.tick(sample({ now: T0 + 119_900, inFamily: false }));
    expect(at119_900.signal).toBe('NONE');
    expect(at119_900.state).toBe('RUNNING');
    expect(at119_900.awayMs).toBe(119_900);

    const at120_100 = short.tick(sample({ now: T0 + 120_100, inFamily: false }));
    expect(at120_100.signal).toBe('PAUSE');
    expect(at120_100.state).toBe('PAUSED');
    expect(at120_100.reason).toBe('away-timeout');
    expect(short.idleMs).toBe(DEFAULT_IDLE_MS);
  });

  it('族内在前台（含 #32770/父链命中的 ✓ 判定结果）不累计离开时长', () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    wd.tick(sample({ now: T0, inFamily: false }));
    wd.tick(sample({ now: T0 + 100_000, inFamily: false }));
    const back = wd.tick(sample({ now: T0 + 105_000, inFamily: true }));
    expect(back.awayMs).toBe(0);
    expect(wd.tick(sample({ now: T0 + 300_000, inFamily: false })).signal).toBe('NONE');
  });

  it('idleMs 可注入（配置 60s 档）', () => {
    const wd = new AnchorWatchdog({ idleMs: 60_000, now: () => T0 });
    wd.tick(sample({ now: T0, inFamily: false }));
    expect(wd.tick(sample({ now: T0 + 60_000, inFamily: false })).signal).toBe('PAUSE');
  });
});

describe('A. 状态机：回前台自动续跑（5s 内）', () => {
  const paused = () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    wd.tick(sample({ now: T0, inFamily: false }));
    wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS, inFamily: false }));
    expect(wd.state).toBe('PAUSED');
    return wd;
  };

  it('回到族内的第一个滴答即 RESUME，且时延必落在 resumeWindowMs=5s 内（滴答 1s）', () => {
    const wd = paused();
    let resumedAt = -1;
    for (let t = T0 + DEFAULT_IDLE_MS + 1000; t <= T0 + DEFAULT_IDLE_MS + DEFAULT_RESUME_WINDOW_MS + 4000; t += 1000) {
      if (wd.tick(sample({ now: t, inFamily: true })).signal === 'RESUME') { resumedAt = t; break; }
    }
    expect(resumedAt).toBeGreaterThan(-1);
    expect(resumedAt - (T0 + DEFAULT_IDLE_MS)).toBeLessThanOrEqual(DEFAULT_RESUME_WINDOW_MS);
    expect(wd.state).toBe('RUNNING');
  });

  it('暂停段累计进 pausedMs（任务计时冻结的补偿量），恢复后重新起算', () => {
    const wd = paused();
    const resume = wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS + 30_000, inFamily: true }));
    expect(resume.pausedMs).toBe(30_000);
    expect(resume.awayMs).toBe(0);
    wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS + 40_000, inFamily: false }));
    wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS + 160_000, inFamily: false }));
    expect(wd.state).toBe('PAUSED');
    expect(wd.pausedMs).toBe(30_000);
  });

  it('A-M7 预算冻结：pausedMs getter 含进行中暂停段（暂停中每刻都在增长，时长闸不烧暂停）', () => {
    // loop 暂停等待里每 250ms 轮询 BudgetGuard.check(step, now, tokens)，
    // pauseProvider=watchdog.pausedMs 必须已含未结算的当前段，否则暂停期间仍烧时长
    let clockNow = T0;
    const wd = new AnchorWatchdog({ now: () => clockNow });
    wd.tick(sample({ now: clockNow, inFamily: false }));
    clockNow = T0 + DEFAULT_IDLE_MS;
    expect(wd.tick(sample({ now: clockNow, inFamily: false })).signal).toBe('PAUSE');
    clockNow = T0 + DEFAULT_IDLE_MS + 50_000; // 仍离开 50s（暂停中）
    expect(wd.state).toBe('PAUSED');
    expect(wd.pausedMs).toBe(50_000);
    expect(wd.pauseReason).toBe('away-timeout');
    clockNow = T0 + DEFAULT_IDLE_MS + 90_000;
    expect(wd.pausedMs).toBe(90_000);
    // 回到族内 RESUME：getter 与快照口径一致（结算后不再重复计）
    const back = wd.tick(sample({ now: clockNow, inFamily: true }));
    expect(back.signal).toBe('RESUME');
    expect(wd.pausedMs).toBe(90_000);
    expect(wd.pauseReason).toBe('');
  });

  it('仍不在族内则保持 PAUSED，离开时长继续增长供播报/复盘标注', () => {
    const wd = paused();
    const stay = wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS + 60_000, inFamily: false }));
    expect(stay.signal).toBe('NONE');
    expect(stay.state).toBe('PAUSED');
    expect(stay.awayMs).toBe(DEFAULT_IDLE_MS + 60_000);
  });
});

describe('A. 状态机：进程退出 = 任务收口', () => {
  it('见过存活后族内无进程 → FINISH + STOPPED，后续采样不再产出信号', () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    wd.tick(sample({ now: T0 }));
    const gone = wd.tick(sample({ now: T0 + 5_000, inFamily: false, alive: false }));
    expect(gone.signal).toBe('FINISH');
    expect(gone.state).toBe('STOPPED');
    expect(gone.reason).toBe('app-exited');
    expect(wd.tick(sample({ now: T0 + 6_000 })).signal).toBe('NONE');
  });

  it('暂停中退出：先结算暂停段再收口（冻结账目不丢）', () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    wd.tick(sample({ now: T0, inFamily: false }));
    wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS, inFamily: false }));
    const gone = wd.tick(sample({ now: T0 + DEFAULT_IDLE_MS + 10_000, inFamily: false, alive: false }));
    expect(gone.signal).toBe('FINISH');
    expect(gone.pausedMs).toBe(10_000);
  });

  it('从未见过存活（应用尚未拉起）不判收口，也不误暂停前的暂停', () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    const r = wd.tick(sample({ now: T0, inFamily: false, alive: false }));
    expect(r.signal).toBe('NONE');
    expect(r.state).toBe('RUNNING');
  });

  it('stop() 外部收口幂等，且不覆盖已落地的 app-exited 原因', () => {
    const wd = new AnchorWatchdog({ now: () => T0 });
    expect(wd.stop().state).toBe('STOPPED');
    expect(wd.stop().signal).toBe('NONE');
    const wd2 = new AnchorWatchdog({ now: () => T0 });
    wd2.tick(sample({ now: T0 }));
    wd2.tick(sample({ now: T0 + 1000, inFamily: false, alive: false }));
    expect(wd2.stop().reason).toBe('app-exited');
  });
});

/* ------------------------------------------------------------------ */
/* B. 装配层（探针 / loop 控制 / 播报全部注入）                          */
/* ------------------------------------------------------------------ */

interface FakeLoop { pause(): void; resume(): void; cancel(): void; readonly isPaused: boolean }

function makeFakeLoop() {
  let paused = false;
  const calls = { pause: 0, resume: 0, cancel: 0 };
  const loop: FakeLoop = {
    get isPaused() { return paused; },
    pause() { paused = true; calls.pause++; },
    resume() { paused = false; calls.resume++; },
    cancel() { calls.cancel++; },
  };
  return { loop, calls };
}

async function attach(opts: {
  task: { taskId: string; targetApp?: { name?: string; exePath?: string; procFamily?: string[] }; longTask?: { watchdogIdleMs?: number } };
  probe: () => { foregroundInFamily: boolean; familyAlive: boolean };
  clock: () => number;
}) {
  const { attachAnchorWatchdog, getAnchorWatchdog } = await import('../anchor-watchdog-host');
  const { loop, calls } = makeFakeLoop();
  const broadcasts: { status: string; text: string }[] = [];
  const notes: string[] = [];
  const handle = attachAnchorWatchdog(
    { loops: new Map([[opts.task.taskId, { loop, goal: 'g' }]]) },
    opts.task,
    {
      probeFactory: () => ({ sample: opts.probe }),
      now: opts.clock,
      startTimer: () => () => undefined,
      broadcast: (status, text) => { broadcasts.push({ status, text }); },
      notify: (title, body) => { notes.push(`${title}|${body}`); },
    },
  );
  return { handle, calls, broadcasts, notes, getAnchorWatchdog };
}

describe('B. 装配层副作用', () => {
  let probeState = { foregroundInFamily: true, familyAlive: true };
  let clockAt = T0;

  beforeEach(() => {
    probeState = { foregroundInFamily: true, familyAlive: true };
    clockAt = T0;
  });
  const probe = () => ({ ...probeState });
  const clock = () => clockAt;

  it('无 targetApp 的任务不装配看门狗（零回归红线）', async () => {
    const { handle } = await attach({ task: { taskId: 'no-anchor' }, probe, clock });
    expect(handle).toBeNull();
  });

  it('procFamily 与 exePath 都推不出进程名时不装配', async () => {
    const { handle, broadcasts } = await attach({
      task: { taskId: 'no-family', targetApp: { name: '未知' } },
      probe, clock,
    });
    expect(handle).toBeNull();
    expect(broadcasts[0]?.status).toBe('thinking');
  });

  it('离开超时 → loop.pause() 恰好一次 + paused 播报 + 系统通知各一条', async () => {
    const { handle, calls, broadcasts, notes } = await attach({
      task: { taskId: 'wd-pause', targetApp: { name: '金蝶KIS', exePath: 'C:\\kis\\KIS.exe' } },
      probe, clock,
    });
    expect(handle).not.toBeNull();
    const h = handle as NonNullable<typeof handle>;
    probeState.foregroundInFamily = false;
    clockAt = T0;
    expect(h.tickOnce()?.signal).toBe('NONE');
    clockAt = T0 + DEFAULT_IDLE_MS;
    expect(h.tickOnce()?.signal).toBe('PAUSE');
    expect(h.state()).toBe('PAUSED');
    expect(calls.pause).toBe(1);
    expect(calls.resume).toBe(0);
    expect(broadcasts.map((b) => b.status)).toEqual(['paused']);
    expect(broadcasts[0]?.text).toContain('金蝶KIS');
    expect(notes).toHaveLength(1);
    // 重复滴答不再触发第二次暂停
    clockAt = T0 + DEFAULT_IDLE_MS + 1000;
    expect(h.tickOnce()?.signal).toBe('NONE');
    expect(calls.pause).toBe(1);
  });

  it('回前台 → 5s 内自动 loop.resume() 一次并播报续跑（无需人工点击）', async () => {
    const { handle, calls, broadcasts } = await attach({
      task: { taskId: 'wd-resume', targetApp: { name: 'KIS', exePath: 'C:\\kis\\kis.exe' } },
      probe, clock,
    });
    const h = handle as NonNullable<typeof handle>;
    probeState.foregroundInFamily = false;
    h.tickOnce();
    clockAt = T0 + DEFAULT_IDLE_MS;
    expect(h.tickOnce()?.signal).toBe('PAUSE');
    const backAt = T0 + DEFAULT_IDLE_MS + 40_000;
    probeState.foregroundInFamily = true; // 用户回到目标应用
    clockAt = backAt + 1000; // 回前台后第一个滴答（宿主 1s 周期）
    expect(h.tickOnce()?.signal).toBe('RESUME');
    expect(clockAt - backAt).toBeLessThanOrEqual(DEFAULT_RESUME_WINDOW_MS);
    expect(calls.resume).toBe(1);
    // 暂停段 = 40s 离开 + 1s 检测滴答
    expect(h.pausedMs()).toBe(41_000);
    expect(h.state()).toBe('RUNNING');
    expect(broadcasts.some((b) => b.status === 'thinking' && b.text.includes('自动续跑'))).toBe(true);
  });

  it('自动续跑失败兜底：loop 仍暂停且超 5s → 播报「请点继续」一次', async () => {
    let stuckPaused = true;
    const { attachAnchorWatchdog } = await import('../anchor-watchdog-host');
    const broadcasts: { status: string; text: string }[] = [];
    const fakeLoop = {
      get isPaused() { return stuckPaused; },
      pause() { stuckPaused = true; },
      resume() { /* 模拟续跑失败：状态不变 */ },
      cancel() { /* noop */ },
    };
    let clockNow = T0;
    const handle = attachAnchorWatchdog(
      { loops: new Map([['wd-stuck', { loop: fakeLoop, goal: 'g' }]]) },
      { taskId: 'wd-stuck', targetApp: { name: 'KIS', exePath: 'C:\\a\\kis.exe' } },
      {
        probeFactory: () => ({ sample: () => ({ ...probeState }) }),
        now: () => clockNow,
        startTimer: () => () => undefined,
        broadcast: (status, text) => { broadcasts.push({ status, text }); },
        notify: () => undefined,
      },
    );
    const h = handle as NonNullable<typeof handle>;
    probeState.foregroundInFamily = false;
    h.tickOnce();
    clockNow = T0 + DEFAULT_IDLE_MS;
    h.tickOnce();
    probeState.foregroundInFamily = true;
    clockNow = T0 + DEFAULT_IDLE_MS + 1000;
    expect(h.tickOnce()?.signal).toBe('RESUME');
    clockNow = T0 + DEFAULT_IDLE_MS + 6500;
    h.tickOnce();
    expect(broadcasts.some((b) => b.text.includes('请点「继续」'))).toBe(true);
    const before = broadcasts.length;
    clockNow = T0 + DEFAULT_IDLE_MS + 7500;
    h.tickOnce();
    expect(broadcasts.length).toBe(before);
    stuckPaused = false;
  });

  it('进程退出 → loop.cancel() 收口 + stopped 播报，句柄自清', async () => {
    const { handle, calls, broadcasts, getAnchorWatchdog } = await attach({
      task: { taskId: 'wd-exit', targetApp: { name: 'KIS', procFamily: ['kis.exe'] } },
      probe, clock,
    });
    const h = handle as NonNullable<typeof handle>;
    expect(getAnchorWatchdog('wd-exit')).toBe(h);
    expect(h.tickOnce()?.state).toBe('RUNNING'); // 先确认存活，武装退出判定
    probeState.familyAlive = false;
    clockAt = T0 + 2000;
    expect(h.tickOnce()?.signal).toBe('FINISH');
    expect(calls.cancel).toBe(1);
    expect(broadcasts.map((b) => b.status)).toEqual(['stopped']);
    expect(getAnchorWatchdog('wd-exit')).toBeNull();
    expect(h.tickOnce()).toBeNull();
  });

  it('采样异常（FFI 不可用）按「样本不可用」跳过，绝不暂停（误停防线）', async () => {
    const { handle, calls } = await attach({
      task: { taskId: 'wd-probe-fail', targetApp: { name: 'KIS', procFamily: ['kis.exe'] } },
      probe: () => { throw new Error('FFI 不可用'); },
      clock: () => T0,
    });
    const h = handle as NonNullable<typeof handle>;
    expect(h.tickOnce()).toBeNull();
    expect(calls.pause).toBe(0);
    expect(h.state()).toBe('RUNNING');
  });

  it('任务终态（loops 表已无该 taskId）→ 自动停表，tickOnce 返回 null', async () => {
    const { attachAnchorWatchdog } = await import('../anchor-watchdog-host');
    const { loop, calls } = makeFakeLoop();
    const loops = new Map([['wd-done', { loop, goal: 'g' }]]);
    const handle = attachAnchorWatchdog(
      { loops },
      { taskId: 'wd-done', targetApp: { name: 'KIS', procFamily: ['kis.exe'] }, longTask: { watchdogIdleMs: 60_000 } },
      {
        probeFactory: () => ({ sample: () => ({ foregroundInFamily: false, familyAlive: true }) }),
        now: () => clockAt,
        startTimer: () => () => undefined,
        broadcast: () => undefined,
        notify: () => undefined,
      },
    );
    const h = handle as NonNullable<typeof handle>;
    loops.delete('wd-done');
    expect(h.tickOnce()).toBeNull();
    expect(calls.pause).toBe(0);
  });
});

describe('C. 进程族基名推导（foreground-proc 纯函数部分）', () => {
  it('procFamily 优先，exePath basename 兜底，统一小写并去重', () => {
    expect(familyBasenamesOf({ procFamily: ['chrome.exe', 'msedge.exe'], exePath: 'C:\\Program\\Chrome.exe' }))
      .toEqual(['chrome.exe', 'msedge.exe']);
    expect(familyBasenamesOf({ exePath: 'D:\\KIS\\KIS.exe' })).toEqual(['kis.exe']);
    expect(familyBasenamesOf({})).toEqual([]);
    expect(familyBasenamesOf({ procFamily: ['', '  ', 'WeChat.exe'] })).toEqual(['wechat.exe']);
  });
});
