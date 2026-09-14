/**
 * uia-restart-policy.test.ts — sidecar 重启预算的纯逻辑门禁
 *
 * 背景 bug：restartCount 成功后不复位 → 跨天累计 5 次退出后永久不再自动重启（失联）。
 * 这里钉住预算边界与退避曲线；「健康后复位」在 UiaClient.start()（设备级路径，见局限说明）。
 */
import { describe, it, expect } from 'vitest';
import { MAX_RESTARTS, shouldRestart, nextBackoffMs } from '../src/uia-restart-policy';

describe('shouldRestart', () => {
  it('预算内允许重启，第 5 次后耗尽', () => {
    expect(shouldRestart(0)).toBe(true);
    expect(shouldRestart(MAX_RESTARTS - 1)).toBe(true);
    expect(shouldRestart(MAX_RESTARTS)).toBe(false);
    expect(shouldRestart(MAX_RESTARTS + 10)).toBe(false);
  });
});

describe('nextBackoffMs', () => {
  it('指数退避：500ms 起步翻倍', () => {
    expect(nextBackoffMs(1)).toBe(500);
    expect(nextBackoffMs(2)).toBe(1000);
    expect(nextBackoffMs(3)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(4000);
  });

  it('封顶 10s，count<=0 不产生负指数', () => {
    expect(nextBackoffMs(6)).toBe(10_000);
    expect(nextBackoffMs(0)).toBe(500);
    expect(nextBackoffMs(-3)).toBe(500);
  });
});
