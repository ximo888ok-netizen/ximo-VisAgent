// planFirst:true 集成回归：planner 产物进主循环的完整链路
//（PLANNING 状态 → plan 调用 → setTasks 注入 memory → 感知文本编号计划 → 里程碑门控 subTaskCount>1）
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/agent/loop';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';

// 捕获 ContextManager.setTasks 调用（loop 内部 new，不改生产代码的唯一注入点）
const spy = vi.hoisted(() => ({ setTasks: [] as string[][] }));
vi.mock('../src/agent/memory', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/agent/memory')>();
  class SpiedContextManager extends orig.ContextManager {
    setTasks(tasks: string[]): void {
      spy.setTasks.push([...tasks]);
      super.setTasks(tasks);
    }
  }
  return { ...orig, ContextManager: SpiedContextManager };
});

class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  calls: ChatMessage[][] = [];
  private idx = 0;
  constructor(private responses: Array<string | { toolCalls: ToolCallResult[] } | Error>) {}
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const r = this.responses[this.idx];
    this.idx++;
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (r instanceof Error) throw r;
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
    }
    return { content: '', toolCalls: r.toolCalls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
  }
}

const toolCall = (name: string, args: Record<string, unknown>) =>
  ({ toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] });

/** 一次调用的全部文本内容拼接（user 消息的 ContentPart[] 取 text 段） */
function allText(msgs: ChatMessage[]): string {
  return msgs.map((m) => {
    if (typeof m.content === 'string') return m.content;
    return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }).join('\n');
}

const GOAL = '打开记事本输入一段文字并保存为文件';

describe('planFirst:true 集成链路（planner → 主循环）', () => {
  it('多步目标：规划产物注入 setTasks / 感知文本编号计划 / 里程碑门控生效', async () => {
    spy.setTasks.length = 0;
    const llm = new FakeLLM([
      // ① planner 调用
      '["启动记事本并等待窗口出现", "在编辑区输入文字并按Ctrl+S保存"]',
      // ② 步1 ReAct
      toolCall('wait', { ms: 1 }),
      // ③ 步1 里程碑审计（subTaskCount=2 → maxSteps=3 的 1/3 处即步1 命中）
      '{"done":["启动记事本"],"current":"输入文字","drift":false}',
      // ④ 步2 ReAct
      toolCall('wait', { ms: 1 }),
      // ⑤ 步2 里程碑审计
      '{"done":["输入文字"],"current":"保存","drift":true}',
      // ⑥ 步3 收尾
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const statuses: string[] = [];
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute: async () => ({ ok: true, summary: 'ok' }) },
      perception: { async snapshot() { return {}; } },
      planFirst: true,
      maxSteps: 3,
      acceptance: { enabled: false },
      onEvent: (e) => { if (e.type === 'status') statuses.push(e.status); },
    });
    const result = await loop.run(GOAL, 't-plan-1');
    expect(result.status).toBe('COMPLETED');

    // 链路 1：先规划（PLANNING 状态先于 RUNNING 发出）
    expect(statuses.slice(0, 2)).toEqual(['PLANNING', 'RUNNING']);
    // planner 收到规划系统提示与原始目标
    expect(allText(llm.calls[0]!)).toContain('任务规划器');
    expect(llm.calls[0]![1]!.content).toBe(GOAL);

    // 链路 2：规划产物进 memory.setTasks（2 个子任务，不再是单 goal 回退）
    expect(spy.setTasks).toEqual([['启动记事本并等待窗口出现', '在编辑区输入文字并按Ctrl+S保存']]);

    // 链路 3：首轮 ReAct 感知文本带编号计划（模型知道自己在做第几项）
    const react1 = allText(llm.calls[1]!);
    expect(react1).toContain('计划: 1) 启动记事本并等待窗口出现  2) 在编辑区输入文字并按Ctrl+S保存');
    expect(react1).toContain('（按计划顺序推进；已完成的不重做；全部完成才 task_done）');

    // 链路 4：里程碑门控在 subTaskCount>1 时生效——步1/步2 各触发一次审计调用
    expect(allText(llm.calls[2]!)).toContain('里程碑审计员');
    expect(allText(llm.calls[4]!)).toContain('里程碑审计员');
    // 审计结论注入回主循环：步2 ReAct 看到步1 审计（正常：列出已完成，防重做）
    expect(react1).not.toContain('里程碑审计（1/3 步）');
    expect(allText(llm.calls[3]!)).toContain('里程碑审计（1/3 步）：已完成：1) 启动记事本');
    // 步3 收到步2 的跑偏纠偏（drift=true → ⛔ + 回到总目标）
    expect(allText(llm.calls[5]!)).toContain('⛔ 里程碑审计（2/3 步）：检测到偏离总目标');
  });

  it('planFirst:false 对照组：单任务不规划、感知文本无编号计划、短任务不触发里程碑', async () => {
    spy.setTasks.length = 0;
    const llm = new FakeLLM([
      toolCall('wait', { ms: 1 }),
      toolCall('wait', { ms: 1 }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute: async () => ({ ok: true, summary: 'ok' }) },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      maxSteps: 3,
      acceptance: { enabled: false },
    });
    const result = await loop.run(GOAL, 't-plan-2');
    expect(result.status).toBe('COMPLETED');
    // 无规划调用：3 次调用全是 ReAct
    expect(llm.calls).toHaveLength(3);
    expect(spy.setTasks).toEqual([[GOAL]]);
    const react1 = allText(llm.calls[0]!);
    expect(react1).toContain(`目标: ${GOAL}`);
    expect(react1).not.toContain('计划:');
    // 单任务 + maxSteps<40 → 里程碑门控关闭（没有审计调用）
    expect(llm.calls.every((c) => !allText(c).includes('里程碑审计员'))).toBe(true);
  });

  it('规划调用抛错 → 回退单任务继续跑（不因 planner 卡死主循环）', async () => {
    spy.setTasks.length = 0;
    const llm = new FakeLLM([
      new Error('planner 网络中断'),
      '{"thought":"done","done":true,"finalAnswer":"fallback ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute: async () => ({ ok: true, summary: 'ok' }) },
      perception: { async snapshot() { return {}; } },
      planFirst: true,
      maxSteps: 3,
      acceptance: { enabled: false },
    });
    const result = await loop.run(GOAL, 't-plan-3');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe('fallback ok');
    expect(spy.setTasks).toEqual([[GOAL]]);
    // 回退后就是单任务：感知文本无编号计划
    expect(allText(llm.calls[1]!)).not.toContain('计划:');
  });
});
