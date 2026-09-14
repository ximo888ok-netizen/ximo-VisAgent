// A-M5 三闸收口集成测（FR-006 验收）：预算/断言/停滞三闸各自独立触发 + 终态 gate 字段断言；
// 暂停冻结不误杀与 >30min 档位通过 guard 注入在 loop 层验证（30min 缺省硬顶被解除）。
import { describe, expect, it } from 'vitest';
import { AgentLoop, BudgetGuard } from '../src';
import { defaultAgentConfig, type ILLMClient, type ChatMessage, type ChatResult, type ToolCallResult, type ToolDef } from '@ximo-visagent/llm-providers';
import type { AgentLoopOptions, AssertionResult } from '../src/agent/types';

class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  private idx = 0;
  constructor(private responses: Array<{ toolCalls: ToolCallResult[]; content?: string }>) {}
  async chat(_messages: ChatMessage[], _tools?: ToolDef[]): Promise<ChatResult> {
    const r = this.responses[this.idx];
    this.idx++;
    if (!r) throw new Error('fake LLM 脚本用尽');
    return {
      content: r.content ?? '',
      toolCalls: r.toolCalls,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'fake',
    };
  }
}

function click(i = 0): { toolCalls: ToolCallResult[] } {
  return { toolCalls: [{ id: `t${i}`, name: 'mouse_click', args: JSON.stringify({ x: 10, y: 10 }) }] };
}

function baseOpts(llm: ILLMClient, ok: boolean): AgentLoopOptions {
  return {
    textLLM: llm,
    executor: { async execute() { return { ok, summary: ok ? 'done' : 'boom', error: ok ? undefined : 'boom' }; } },
    perception: { async snapshot() { return { screenshot: Buffer.from('same-frame'), foreground: { title: 'T', className: '' } }; } },
    planFirst: false,
    requestApproval: async () => ({ action: 'approve' as const }),
  };
}

describe('三闸独立触发（loop 层 gate 字段，FR-006）', () => {
  it('预算闸（时长）：BudgetGuard 越界 → FAILED + gate=budget-duration', async () => {
    const guard = new BudgetGuard({ maxSteps: 60, maxDurationMs: 100, startedAt: 0 });
    const loop = new AgentLoop({ ...baseOpts(new FakeLLM([click()]), true), budgetGuard: guard });
    const result = await loop.run('测试', 't-dur');
    expect(result.status).toBe('FAILED');
    expect(result.gate).toBe('budget-duration');
    expect(result.finalAnswer).toBe('任务失败：超过单任务时间上限');
  });

  it('预算闸（步数）：guard maxSteps=2 用尽 → FAILED + gate=budget-steps', async () => {
    const guard = new BudgetGuard({ maxSteps: 2, maxDurationMs: 10 * 60_000 });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([click(0), click(1), click(2)]), true),
      maxSteps: 2,
      budgetGuard: guard,
    });
    const result = await loop.run('测试', 't-steps');
    expect(result.status).toBe('FAILED');
    expect(result.gate).toBe('budget-steps');
    expect(result.finalAnswer).toContain('最大步数上限（2 步）');
  });

  it('预算闸（token）：maxTokens=15 首轮烧完 → 第二轮入口触发 gate=budget-tokens', async () => {
    const guard = new BudgetGuard({ maxSteps: 600, maxDurationMs: 4 * 60 * 60_000, maxTokens: 15 });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([click(0), click(1)]), true),
      maxSteps: 600,
      budgetGuard: guard,
    });
    const result = await loop.run('测试', 't-tokens');
    expect(result.status).toBe('FAILED');
    expect(result.gate).toBe('budget-tokens');
  });

  it('停滞闸：同签名动作 + 画面恒定 → 病理步达阈值强制止损 gate=stall（不烧完步数预算）', async () => {
    // 执行成功但屏幕无变化：停滞判定不依赖执行失败（工具失败 3 连会被先行熔断，属另一路径）
    const loop = new AgentLoop(baseOpts(new FakeLLM(Array.from({ length: 16 }, (_, i) => click(i))), true));
    const result = await loop.run('测试', 't-stall');
    expect(result.status).toBe('FAILED');
    expect(result.gate).toBe('stall');
    expect(result.steps).toBeLessThan(16);
  });

  it('断言闸：task_done + 机器断言全过 → COMPLETED + gate=assertion', async () => {
    const evaluateAssertion = async (): Promise<AssertionResult> => ({ passed: true, detail: 'ok' });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([click(0), click(1), click(2), { toolCalls: [], content: '{"thought":"完成","done":true,"finalAnswer":"办好了"}' }]), true),
      assertions: [{ kind: 'window_title_contains', text: '金蝶' }],
      evaluateAssertion,
    });
    const result = await loop.run('测试', 't-assert');
    expect(result.status).toBe('COMPLETED');
    expect(result.gate).toBe('assertion');
  });

  it('直完路径 gate=task_done（评审关闭时的普通完成不带闸标记误报）', async () => {
    const done = await new AgentLoop({
      ...baseOpts(new FakeLLM([
        click(0), click(1), click(2),
        { toolCalls: [], content: '{"thought":"完成","done":true,"finalAnswer":"完成"}' },
      ]), true),
      acceptance: { enabled: false },
    }).run('测试', 't-done');
    expect(done.status).toBe('COMPLETED');
    expect(done.gate).toBe('task_done');
  });
});

describe('暂停冻结与预算参数化（loop 层）', () => {
  it('暂停 10min 不误杀：墙钟 40min（其中 15min 被看门狗暂停）在 30min 档内正常完成', async () => {
    const guard = new BudgetGuard({
      maxSteps: 60,
      maxDurationMs: 30 * 60_000,
      startedAt: Date.now() - 40 * 60_000,
      pauseProvider: () => 15 * 60_000,
    });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([
        click(0), click(1), click(2),
        { toolCalls: [], content: '{"thought":"完成","done":true,"finalAnswer":"完成"}' },
      ]), true),
      acceptance: { enabled: false },
      budgetGuard: guard,
    });
    const result = await loop.run('测试', 't-freeze');
    expect(result.status).toBe('COMPLETED');
    expect(result.gate).toBe('task_done');
  });

  it('同参数无暂停冻结 → 时长闸照常触发（对照组，证明冻结逻辑生效）', async () => {
    const guard = new BudgetGuard({ maxSteps: 60, maxDurationMs: 30 * 60_000, startedAt: Date.now() - 40 * 60_000 });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([click(0)]), true),
      budgetGuard: guard,
    });
    const result = await loop.run('测试', 't-freeze-ctrl');
    expect(result.gate).toBe('budget-duration');
  });

  it('>30min 锚定任务合法（Q4）：opts 仍传缺省 30min，guard 4h 档下 1h 前起跑的任务正常完成', async () => {
    const guard = new BudgetGuard({
      maxSteps: 600,
      maxDurationMs: 4 * 60 * 60_000,
      maxTokens: 8_000_000,
      startedAt: Date.now() - 60 * 60_000,
    });
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([
        click(0), click(1), click(2),
        { toolCalls: [], content: '{"thought":"完成","done":true,"finalAnswer":"长任务完成"}' },
      ]), true),
      acceptance: { enabled: false },
      budgetGuard: guard,
    });
    const result = await loop.run('测试', 't-4h');
    expect(result.status).toBe('COMPLETED');
  });

  it('未注入 guard 的旧任务零回归：缺省墙钟超时判定逐字保留（含暂停期间文案）', async () => {
    const loop = new AgentLoop({
      ...baseOpts(new FakeLLM([click(0)]), true),
      maxDurationMs: -1,
    });
    const result = await loop.run('测试', 't-legacy');
    expect(result.status).toBe('FAILED');
    expect(result.finalAnswer).toBe('任务失败：超过单任务时间上限');
    expect(result.gate).toBe('budget-duration');
  });
});
