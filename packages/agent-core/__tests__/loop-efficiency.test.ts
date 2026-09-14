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

describe('EfficiencyGuard 交替循环拦截（场景复刻自 locate→click→locate 空转 27 次的事故）', () => {
  const locate = () => ({ name: 'ui_locate', args: { query: '小答AI客服' } });
  const click = (x: number, y: number) => ({ name: 'mouse_click', args: { x, y } });

  it('同签名在近 10 步出现 ≥5 次（中间夹其他动作，画面有变）→ 硬拦截', () => {
    const g = new EfficiencyGuard(60);
    // 5 轮 locate→click 交替（每次画面都变：菜单开开关关，停滞检测不触发）
    for (let i = 0; i < 5; i++) {
      g.onStep(i * 2 + 1, `找${i}`, locate());
      g.onStep(i * 2 + 2, `点${i}`, click(798, 243), { noChangeCount: 0 });
    }
    // 第 11 步再 locate：近 10 步内同签名恰 5 次（纯 1:1 交替的上限）→ 拦截
    g.onStep(11, '再找', locate());
    const reason = g.blockReason(locate());
    expect(reason).toContain('已拦截');
    expect(reason).toContain('ui_locate');
    expect(reason).toContain('空转循环');
  });

  it('拦截后签名历史清空（软冷却）：紧接着的重复不拦截，再累计 5 次才再拦', () => {
    const g = new EfficiencyGuard(60);
    for (let i = 0; i < 6; i++) g.onStep(i + 1, 'a', locate());
    expect(g.blockReason(locate())).toContain('已拦截');
    // 拦截清空了该签名历史 → 下一轮放行
    g.onStep(8, 'b', locate());
    expect(g.blockReason(locate())).toBeNull();
  });

  it('正常工作流（同签名低频）不受影响', () => {
    const g = new EfficiencyGuard(60);
    // 5 次内 locate/click 交替 = 正常的找-点-找-点
    for (let i = 0; i < 5; i++) {
      g.onStep(i * 2 + 1, `找${i}`, { name: 'ui_locate', args: { query: `目标${i}` } });
      g.onStep(i * 2 + 2, `点${i}`, click(100 + i, 200 + i));
    }
    expect(g.blockReason({ name: 'ui_locate', args: { query: '目标0' } })).toBeNull();
    expect(g.blockReason(click(100, 200))).toBeNull();
  });
});

describe('EfficiencyGuard 死局止损（C1：病理步累计超限 → 强制终止，不再烧剩余步数）', () => {
  const locate = () => ({ name: 'ui_locate', args: { query: '小答AI客服' } });
  const click = (x: number, y: number) => ({ name: 'mouse_click', args: { x, y } });

  it('健康任务（病理步 <8）→ 无预警也无止损', () => {
    const g = new EfficiencyGuard(120);
    for (let i = 0; i < 5; i++) {
      g.onStep(i + 1, `步${i}`, click(i * 50, i * 50));
      g.notePathological(`偶发失败 ${i}`);
    }
    expect(g.bailoutNudge()).toBeNull();
    expect(g.shouldForceBailout()).toBeNull();
  });

  it('病理步累计达 8 → 一次性死局预警；未达 12 不终止；达 12 → 强制止损', () => {
    const g = new EfficiencyGuard(120);
    // 7 次：未到预警阈值
    for (let i = 0; i < 7; i++) g.notePathological(`失败 ${i}`);
    expect(g.bailoutNudge()).toBeNull();
    expect(g.shouldForceBailout()).toBeNull();
    // 第 8 次：预警触发（一次性），但仍不终止
    g.notePathological('失败 8');
    const warn = g.bailoutNudge();
    expect(warn).toContain('无效操作');
    expect(g.bailoutNudge()).toBeNull();
    expect(g.shouldForceBailout()).toBeNull();
    // 累计到 12：强制止损，消息含病理原因与人工建议
    g.notePathological('失败 9');
    g.notePathological('失败 10');
    g.notePathological('失败 11');
    g.notePathological('locate 循环');
    const bailout = g.shouldForceBailout();
    expect(bailout).toContain('死局止损');
    expect(bailout).toContain('locate 循环');
    expect(bailout).toContain('建议人工');
  });

  it('loop 集成：画面停滞 + 模型重复同一动作被持续拦截 → 病理步超限 FAILED（不烧满 maxSteps）', async () => {
    const { AgentLoop } = await import('../src/agent/loop');
    const { defaultAgentConfig } = await import('@ximo-visagent/llm-providers');
    let i = 0;
    const llm = {
      config: defaultAgentConfig().textLLM,
      async chat() {
        i++;
        return { content: '', toolCalls: [{ id: `t${i}`, name: 'mouse_click', args: JSON.stringify({ x: 798, y: 243 }) }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
      },
    };
    const loop = new AgentLoop({
      textLLM: llm as never,
      // 执行器永远成功（排除 3 次连续失败熔断路径）；同一截图 → 停滞 → 点击被拦截计入病理步
      executor: { async execute() { return { ok: true, summary: '(成功)' }; } },
      perception: { async snapshot() { return { screenshot: Buffer.from('same-frame') }; } },
      planFirst: false,
      acceptance: { enabled: false },
      maxSteps: 60,
    });
    const result = await loop.run('死局任务', 't-c1');
    expect(result.status).toBe('FAILED');
    expect(result.finalAnswer).toContain('死局止损');
    expect(result.steps).toBeLessThan(30); // 远小于 maxSteps=60，止损生效
  }, 20_000);
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
