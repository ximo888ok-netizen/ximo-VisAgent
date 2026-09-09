// 效率守卫与停滞信号单测：画面停滞 → 提示换策略 + 硬拦截重复动作
import { describe, expect, it } from 'vitest';
import { EfficiencyGuard } from '../src/agent/loop-efficiency';
import { isScreenChanged } from '../src/agent/loop-helpers';

const click = (x: number, y: number) => ({ name: 'mouse_click', args: { x, y } });

describe('EfficiencyGuard 停滞硬约束', () => {
  it('画面未停滞时不拦截', () => {
    const g = new EfficiencyGuard(20);
    g.onStep(1, 'a', click(470, 630));
    g.onStep(2, 'b', click(470, 630), { noChangeCount: 0 });
    expect(g.blockReason(click(470, 630))).toBeNull();
  });

  it('停滞且重复上一步动作 → 拦截并给出替代方案', () => {
    const g = new EfficiencyGuard(20);
    g.onStep(1, 'a', click(470, 630));
    g.onStep(2, 'b', click(470, 631), { noChangeCount: 3 });
    const reason = g.blockReason(click(470, 632)); // 24px 栅格内视为同一动作
    expect(reason).toContain('已拦截');
    expect(reason).toContain('ui_locate');
  });

  it('停滞但换成不同动作 → 不拦截（模型换策略时必须放行）', () => {
    const g = new EfficiencyGuard(20);
    g.onStep(1, 'a', click(470, 630));
    g.onStep(2, 'b', click(470, 630), { noChangeCount: 3 });
    expect(g.blockReason({ name: 'keyboard_press', args: { combo: 'Enter' } })).toBeNull();
  });

  it('停滞提示只注入一次', () => {
    const g = new EfficiencyGuard(20);
    const first = g.onStep(1, 'a', click(1, 1), { noChangeCount: 3 });
    const second = g.onStep(2, 'b', click(2, 2), { noChangeCount: 4 });
    expect(first.some((n) => n.notice.includes('停滞'))).toBe(true);
    expect(second.some((n) => n.notice.includes('停滞'))).toBe(false);
  });
});

describe('isScreenChanged（停滞信号判定）', () => {
  it('分块指纹按汉明距离判定：1bit 抖动不算变化', () => {
    const base = '0'.repeat(64);
    const oneBit = `${'0'.repeat(10)}1${'0'.repeat(53)}`;
    expect(isScreenChanged(base, base)).toBe(false);
    expect(isScreenChanged(base, oneBit)).toBe(false);
  });

  it('差异超过阈值才算变化', () => {
    const base = '0'.repeat(64);
    const manyBits = '1'.repeat(20) + '0'.repeat(44);
    expect(isScreenChanged(base, manyBits)).toBe(true);
  });

  it('非位串（字节哈希兜底）按严格不等', () => {
    expect(isScreenChanged('abc:123', 'abc:123')).toBe(false);
    expect(isScreenChanged('abc:123', 'abc:124')).toBe(true);
  });
});
