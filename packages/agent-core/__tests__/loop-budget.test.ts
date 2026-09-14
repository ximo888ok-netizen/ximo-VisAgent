// A-M5 预算闸单测：三预算各自独立触发 + 暂停时间冻结（不误杀）+ 任务级参数化（>30min 合法）
// 全 mock 时钟：clock/startedAt/pauseProvider 注入，零真实等待。
import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../src/agent/loop-budget';

const T0 = 1_000_000;
const MIN = 60_000;

describe('BudgetGuard（A-M5 预算闸，FR-006b/Q4）', () => {
  it('时长闸：有效时长超过 maxDurationMs → budget-duration，文案与迁移前硬顶逐字一致', () => {
    const guard = new BudgetGuard({ maxSteps: 600, maxDurationMs: 30 * MIN, startedAt: T0 });
    expect(guard.check(1, T0 + 29 * MIN, 0)).toBeNull();
    const stop = guard.check(1, T0 + 31 * MIN, 0);
    expect(stop?.gate).toBe('budget-duration');
    expect(stop?.detail).toBe('任务失败：超过单任务时间上限');
  });

  it('步数闸：step ≥ maxSteps → budget-steps（detail 含上限值）', () => {
    const guard = new BudgetGuard({ maxSteps: 600, maxDurationMs: 4 * 60 * MIN, startedAt: T0 });
    expect(guard.check(599, T0, 0)).toBeNull();
    const stop = guard.check(600, T0, 0);
    expect(stop?.gate).toBe('budget-steps');
    expect(stop?.detail).toContain('600');
  });

  it('token 闸：totalTokens ≥ maxTokens → budget-tokens；缺省 = 不设上限（现状语义）', () => {
    const withCap = new BudgetGuard({ maxSteps: 600, maxDurationMs: 4 * 60 * MIN, maxTokens: 8_000_000, startedAt: T0 });
    expect(withCap.check(1, T0, 7_999_999)).toBeNull();
    expect(withCap.check(1, T0, 8_000_000)?.gate).toBe('budget-tokens');
    const noCap = new BudgetGuard({ maxSteps: 600, maxDurationMs: 4 * 60 * MIN, startedAt: T0 });
    expect(noCap.check(1, T0, 999_999_999)).toBeNull();
  });

  it('暂停时间冻结：pauseProvider 累计暂停段不计入预算（暂停 10min 不烧预算）', () => {
    const pausedMs = { value: 0 };
    const guard = new BudgetGuard({
      maxSteps: 600, maxDurationMs: 30 * MIN, startedAt: T0,
      pauseProvider: () => pausedMs.value,
    });
    // 墙钟已走 40min：无暂停时早已超时
    expect(guard.check(1, T0 + 40 * MIN, 0)?.gate).toBe('budget-duration');
    // 其中 35min 是被看门狗暂停的时段 → 有效时长 5min，不误杀
    pausedMs.value = 35 * MIN;
    expect(guard.check(1, T0 + 40 * MIN, 0)).toBeNull();
    // 恢复后继续执行至有效时长越过上限 → 照常触发
    pausedMs.value = 5 * MIN;
    expect(guard.check(1, T0 + 36 * MIN, 0)?.gate).toBe('budget-duration');
  });

  it('预算参数化（Q4）：>30min 锚定档位合法——4h 档 1h 后仍有余量，4h1m 才触发', () => {
    const guard = new BudgetGuard({ maxSteps: 600, maxDurationMs: 4 * 60 * MIN, maxTokens: 8_000_000, startedAt: T0 });
    expect(guard.check(10, T0 + 60 * MIN, 1_000)).toBeNull();
    expect(guard.check(10, T0 + 241 * MIN, 1_000)?.gate).toBe('budget-duration');
  });

  it('先到先收：判定顺序步数 → 时长 → token（同时越界时报先触发的一闸）', () => {
    const guard = new BudgetGuard({ maxSteps: 3, maxDurationMs: 1_000, maxTokens: 10, startedAt: T0 });
    expect(guard.check(5, T0 + 9_999, 999)?.gate).toBe('budget-steps');
    expect(guard.check(1, T0 + 9_999, 999)?.gate).toBe('budget-duration');
    expect(guard.check(1, T0, 999)?.gate).toBe('budget-tokens');
  });

  it('缺省 clock = Date.now；elapsedMs 钳非负（暂停量超过墙钟不产生负时长）', () => {
    const guard = new BudgetGuard({
      maxSteps: 10, maxDurationMs: 1_000, startedAt: T0,
      clock: () => T0 + 500, pauseProvider: () => 10_000,
    });
    expect(guard.elapsedMs()).toBe(0);
    expect(guard.check(1, T0 + 500, 0)).toBeNull();
  });
});
