// 直操模式单测：actions[] 批解析 / 批内 L2 截断 / thought 截断 / 5 步滑窗
import { describe, expect, it } from 'vitest';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import { AgentLoop } from '../src/agent/loop';
import { clampThought, parseModelOutput } from '../src/agent/loop-helpers';
import { ContextManager } from '../src/agent/memory';

// ---------- 纯函数 ----------

describe('parseModelOutput（直操协议）', () => {
  it('多个 tool_calls 全收成批（不再丢第二个）', () => {
    const calls = [
      { id: '1', name: 'mouse_click', args: '{"x":100,"y":200}' },
      { id: '2', name: 'keyboard_type', args: '{"text":"hi"}' },
      { id: '3', name: 'keyboard_press', args: '{"combo":"Ctrl+S"}' },
    ];
    const parsed = parseModelOutput(null, calls);
    expect(parsed.actions.map((a) => a.name)).toEqual(['mouse_click', 'keyboard_type', 'keyboard_press']);
    expect(parsed.done).toBe(false);
  });

  it('内联 JSON actions[] 数组解析', () => {
    const parsed = parseModelOutput('{"actions":[{"name":"mouse_click","args":{"x":1,"y":2}},{"name":"keyboard_type","args":{"text":"a"}}]}', []);
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[0]!.args).toEqual({ x: 1, y: 2 });
  });

  it('task_done / chat_reply 优先并短路整批', () => {
    const calls = [
      { id: '1', name: 'mouse_click', args: '{"x":1,"y":2}' },
      { id: '2', name: 'task_done', args: '{"finalAnswer":"done"}' },
    ];
    const parsed = parseModelOutput(null, calls);
    expect(parsed.done).toBe(true);
    expect(parsed.finalAnswer).toBe('done');
    expect(parsed.actions).toHaveLength(0);
  });

  it('单个 action 兼容为长度 1 的批', () => {
    const parsed = parseModelOutput('{"action":{"name":"wait","args":{"ms":100}}}', []);
    expect(parsed.actions).toEqual([{ name: 'wait', args: { ms: 100 } }]);
  });
});

describe('clampThought（思考最小化）', () => {
  it('≤40 字原样保留', () => {
    expect(clampThought('点输入框')).toEqual({ text: '点输入框', overthink: false });
  });

  it('超 40 字截断；超 200 字标记过度思考', () => {
    const long = 'a'.repeat(80);
    const r = clampThought(long);
    expect(r.text).toHaveLength(41); // 40 + 省略号
    expect(r.overthink).toBe(false);
    const over = 'b'.repeat(201);
    expect(clampThought(over).overthink).toBe(true);
  });

  it('空/null 安全', () => {
    expect(clampThought(null).text).toBe('');
    expect(clampThought('').text).toBe('');
  });
});

describe('ContextManager（5 步滑窗一行式）', () => {
  it('历史消息为一行式动作记录，参数只留关键值', () => {
    const mem = new ContextManager(async () => '摘要');
    mem.setTasks(['目标']);
    for (let i = 0; i < 8; i++) {
      mem.addStep({ thought: `第${i}步思考`, actionName: 'mouse_click', actionArgs: { x: 100 + i, y: 200 }, resultSummary: `点击成功 ${i}` });
    }
    const msgs = mem.buildHistoryMessages();
    // 滑窗 5：8 步只留最后 5 步（x=104..108），最新一步是第 8 步
    expect(msgs).toHaveLength(5);
    expect(msgs.at(-1)!.content).toContain('mouse_click(107,200)');
    expect(msgs.at(-1)!.content).toContain('点击成功 7');
    expect(msgs.at(-1)!.content).not.toContain('思考'); // thought 不进历史（人只记动作不记独白）
  });

  it('text 类参数截断到 20 字', () => {
    const mem = new ContextManager(async () => '摘要');
    mem.addStep({ thought: '', actionName: 'keyboard_type', actionArgs: { text: 'x'.repeat(50) }, resultSummary: 'ok' });
    const content = mem.buildHistoryMessages()[0]!.content;
    expect(content).toContain('"xxxxxxxxxxxxxxxxxxxx"'); // 20 个 x + 引号
  });
});

// ---------- Loop 集成：批执行 ----------

class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  calls: ChatMessage[][] = [];
  private idx = 0;
  constructor(private script: Array<string | { toolCalls: ToolCallResult[]; content?: string }>) {}

  async chat(messages: ChatMessage[], _tools?: ToolDef[]): Promise<ChatResult> {
    this.calls.push(messages);
    const r = this.script[this.idx];
    this.idx++;
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
    }
    return { content: r.content ?? '', toolCalls: r.toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
  }
}

function batchCall(...items: [string, Record<string, unknown>][]): { toolCalls: ToolCallResult[] } {
  return { toolCalls: items.map(([name, args], i) => ({ id: `t${i}`, name, args: JSON.stringify(args) })) };
}

describe('AgentLoop 批执行', () => {
  it('一批 3 个动作串行全部执行，只消耗 1 次截图迭代', async () => {
    const executed: string[] = [];
    const llm = new FakeLLM([
      batchCall(['mouse_click', { x: 100, y: 200 }], ['keyboard_type', { text: 'hi' }], ['keyboard_press', { combo: 'Ctrl+S' }]),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name, args) { executed.push(`${name}:${JSON.stringify(args)}`); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
    });
    const result = await loop.run('测试', 't-batch');
    expect(result.status).toBe('COMPLETED');
    expect(executed).toHaveLength(3);
    expect(executed[0]).toContain('mouse_click');
    expect(result.steps).toBe(2); // 1 次批迭代 + 1 次 done
  });

  it('批内遇 L2 拒绝：已执行的保留，剩余动作不执行，任务重规划', async () => {
    const executed: string[] = [];
    const llm = new FakeLLM([
      batchCall(['mouse_click', { x: 1, y: 2 }], ['file_write', { path: 'a.txt', content: 'x' }], ['mouse_click', { x: 3, y: 4 }]),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name) { executed.push(name); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      requestApproval: async () => ({ action: 'reject', reason: '不让写' }),
    });
    const result = await loop.run('测试', 't-l2cut');
    expect(result.status).toBe('COMPLETED');
    expect(executed).toEqual(['mouse_click']); // file_write 被拒后第三个 mouse_click 也没执行
  });

  it('批内动作失败：停批，反馈失败位置', async () => {
    const executed: string[] = [];
    const llm = new FakeLLM([
      batchCall(['mouse_click', { x: 1, y: 2 }], ['open_app', { nameOrPath: '不存在' }], ['mouse_click', { x: 3, y: 4 }]),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute(name) {
          executed.push(name);
          if (name === 'open_app') return { ok: false, summary: '', error: '应用不存在' };
          return { ok: true, summary: 'ok' };
        },
      },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
    });
    const result = await loop.run('测试', 't-failcut');
    expect(result.status).toBe('COMPLETED');
    expect(executed).toEqual(['mouse_click', 'open_app']); // 第三个动作被截断
    // 失败位置反馈进了下一轮消息
    const lastMessages = llm.calls.at(-1) ?? [];
    const hasFailNote = lastMessages.some((m) => typeof m.content === 'string' && m.content.includes('open_app'));
    expect(hasFailNote).toBe(true);
  });
});
