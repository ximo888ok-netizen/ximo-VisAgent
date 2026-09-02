import { describe, expect, it, vi, beforeAll } from 'vitest';
import { AgentLoop } from '../src/agent/loop';
import { defaultAgentConfig } from '@desktop-agi/llm-providers';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult, ToolCallResult } from '@desktop-agi/llm-providers';

// ---------- Fake LLM（可脚本化的单步响应） ----------
class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  responses: Array<string | { toolCalls: ToolCallResult[]; content?: string }> = [];
  calls: ChatMessage[][] = [];
  private idx = 0;

  constructor(script: Array<string | { toolCalls: ToolCallResult[]; content?: string }>) {
    this.responses = script;
  }

  async chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<ChatResult> {
    this.calls.push(messages);
    const r = this.responses[this.idx];
    this.idx++;
    expect(r).toBeDefined();
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
    }
    return {
      content: r.content ?? '',
      toolCalls: r.toolCalls,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'fake',
    };
  }
}

function toolCall(name: string, args: Record<string, unknown>): { toolCalls: ToolCallResult[] } {
  return { toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] };
}

describe('AgentLoop（ReAct 闭环逻辑）', () => {
  it('完成任务：结束响应触发 done', async () => {
    const llm = new FakeLLM([
      toolCall('get_ui_tree', {}),
      '{"thought":"已完成","done":true,"finalAnswer":"测试完成"}',
    ]);
    const events: string[] = [];
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute() { return { ok: true, summary: 'ok' }; },
      },
      perception: {
        async snapshot() { return { screenshot: Buffer.from('fake'), uiTree: { id: 1 }, foreground: { title: 'T', className: '' } }; },
      },
      planFirst: false,
      onEvent: (e) => events.push(e.type),
    });
    const result = await loop.run('测试任务', 't1');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe('测试完成');
    expect(events).toContain('status');
  });

  it('L2 操作被拦截且审批后执行', async () => {
    const execute = vi.fn();
    const llm = new FakeLLM([
      toolCall('file_write', { path: 'a.txt', content: 'x' }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute(name, args) { execute(name, args); return { ok: true, summary: 'ok' }; },
      },
      perception: {
        async snapshot() { return { screenshot: undefined, uiTree: null }; },
      },
      planFirst: false,
      requestApproval: async (id) => ({ action: 'approve' }),
      onEvent: (e) => {
        if (e.type === 'approval_pending') expect(e.tool).toBe('file_write');
      },
    });
    const result = await loop.run('写文件', 't2');
    expect(result.status).toBe('COMPLETED');
    expect(execute).toHaveBeenCalledWith('file_write', { path: 'a.txt', content: 'x' });
  });

  it('审批拒绝后 Agent 不执行且继续尝试', async () => {
    const execute = vi.fn();
    const llm = new FakeLLM([
      toolCall('send_message', { text: 'hi' }),
      '{"thought":"被拒后换思路","done":true,"finalAnswer":"done"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name, args) { execute(name, args); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return { screenshot: undefined, uiTree: null }; } },
      planFirst: false,
      requestApproval: async () => ({ action: 'reject', reason: '不允许' }),
    });
    const result = await loop.run('发消息', 't3');
    expect(result.status).toBe('COMPLETED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('取消任务', async () => {
    const llm = new FakeLLM([
      toolCall('wait', { ms: 1e6 }),
      toolCall('wait', { ms: 1e6 }),
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute() {
          loop.cancel(); // 首次执行工具时请求取消
          return { ok: true, summary: 'ok' };
        },
      },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
    });
    const result = await loop.run('x', 't4');
    expect(result.status).toBe('CANCELLED');
  });

  it('超出最大步数判失败', async () => {
    // 无限循环响应（总是 toolCall），maxSteps=2
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 1, y: 1 }),
      toolCall('mouse_click', { x: 1, y: 1 }),
      toolCall('mouse_click', { x: 1, y: 1 }),
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      maxSteps: 2,
    });
    const result = await loop.run('x', 't5');
    expect(result.status).toBe('FAILED');
  });
});