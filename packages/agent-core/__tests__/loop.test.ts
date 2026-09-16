import { describe, expect, it, vi} from 'vitest';
import { AgentLoop } from '../src/agent/loop';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ChatOptions, ToolDef, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';

// ---------- Fake LLM（可脚本化的单步响应） ----------
class FakeLLM implements ILLMClient {
  readonly config: ReturnType<typeof defaultAgentConfig>['textLLM'];
  responses: Array<string | { toolCalls: ToolCallResult[]; content?: string }> = [];
  calls: ChatMessage[][] = [];
  /** 每次调用收到的思考信号（按步思考预算的可观测面） */
  options: ChatOptions[] = [];
  private idx = 0;

  constructor(script: Array<string | { toolCalls: ToolCallResult[]; content?: string }>, thinkingMode?: 'auto' | 'daily' | 'long' | 'deep') {
    this.responses = script;
    this.config = { ...defaultAgentConfig().textLLM, thinkingMode };
  }

  async chat(messages: ChatMessage[], tools?: ToolDef[], options?: ChatOptions): Promise<ChatResult> {
    this.calls.push(messages);
    this.options.push(options ?? {});
    const r = this.responses[this.idx];
    this.idx++;
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
    }
    return {
      content: r.content ?? '',
      toolCalls: r.toolCalls,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'fake'};
  }
}

function toolCall(name: string, args: Record<string, unknown>): { toolCalls: ToolCallResult[] } {
  return { toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] };
}

describe('AgentLoop（ReAct 闭环逻辑）', () => {
  it('完成任务：结束响应触发 done', async () => {
    const llm = new FakeLLM([
      '{"intent":"TASK"}',
      toolCall('mouse_click', { x: 100, y: 100 }),
      '{"thought":"已完成","done":true,"finalAnswer":"测试完成"}',
    ]);
    const events: string[] = [];
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute() { return { ok: true, summary: 'ok' }; }},
      perception: {
        async snapshot() { return { screenshot: Buffer.from('fake'), foreground: { title: 'T', className: '' } }; }},
      planFirst: false,
      onEvent: (e) => events.push(e.type)});
    const result = await loop.run('测试任务', 't1');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe('测试完成');
    expect(events).toContain('status');
  });

  it('L2 操作被拦截且审批后执行', async () => {
    const execute = vi.fn();
    const llm = new FakeLLM([
      '{"intent":"TASK"}',
      toolCall('file_write', { path: 'a.txt', content: 'x' }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute(name, args) { execute(name, args); return { ok: true, summary: 'ok' }; }},
      perception: {
        async snapshot() { return { screenshot: undefined }; }},
      planFirst: false,
      requestApproval: async (id) => ({ action: 'approve' }),
      onEvent: (e) => {
        if (e.type === 'approval_pending') expect(e.tool).toBe('file_write');
      }});
    const result = await loop.run('写文件', 't2');
    expect(result.status).toBe('COMPLETED');
    expect(execute).toHaveBeenCalledWith('file_write', { path: 'a.txt', content: 'x' });
  });

  it('审批拒绝后 Agent 不执行且继续尝试', async () => {
    const execute = vi.fn();
    const llm = new FakeLLM([
      '{"intent":"TASK"}',
      toolCall('send_message', { text: 'hi' }),
      '{"thought":"被拒后换思路","done":true,"finalAnswer":"done"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name, args) { execute(name, args); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return { screenshot: undefined }; } },
      planFirst: false,
      requestApproval: async () => ({ action: 'reject', reason: '不允许' })});
    const result = await loop.run('发消息', 't3');
    expect(result.status).toBe('COMPLETED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('取消任务', async () => {
    const llm = new FakeLLM([
      '{"intent":"TASK"}',
      toolCall('wait', { ms: 1e6 }),
      toolCall('wait', { ms: 1e6 }),
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        async execute() {
          loop.cancel(); // 首次执行工具时请求取消
          return { ok: true, summary: 'ok' };
        }},
      perception: { async snapshot() { return {}; } },
      planFirst: false});
    const result = await loop.run('x', 't4');
    expect(result.status).toBe('CANCELLED');
  });

  it('超出最大步数判失败', async () => {
    // 无限循环响应（总是 toolCall），maxSteps=2
    const llm = new FakeLLM([
      '{"intent":"TASK"}',
      toolCall('mouse_click', { x: 1, y: 1 }),
      toolCall('mouse_click', { x: 1, y: 1 }),
      toolCall('mouse_click', { x: 1, y: 1 }),
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      maxSteps: 2});
    const result = await loop.run('x', 't5');
    expect(result.status).toBe('FAILED');
  });
});

describe('AgentLoop（直操模式对话门控）', () => {
  it('纯对话：模型第一步 chat_reply 直接回答，不再有独立意图识别调用', async () => {
    const answer = '你好！我是 ximo-VisAgent，可以帮你操作电脑完成任务。';
    const llm = new FakeLLM([toolCall('chat_reply', { answer })]);
    const snapshot = vi.fn();
    const execute = vi.fn();
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { execute(); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { snapshot(); return {}; } },
      planFirst: false,
      acceptance: { enabled: false }});
    const result = await loop.run('你好，你是谁？', 't-chat');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe(answer);
    expect(execute).not.toHaveBeenCalled();
  });

  it('首条输出非工具非 JSON → 落入循环继续，后续动作正常执行', async () => {
    const execute = vi.fn();
    const llm = new FakeLLM([
      '(模型输出了非 JSON 内容)',
      toolCall('mouse_click', { x: 100, y: 100 }),
      '{"thought":"完成","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name, args) { execute(name, args); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false }});
    const result = await loop.run('查一下界面', 't-fallback');
    expect(result.status).toBe('COMPLETED');
    expect(execute).toHaveBeenCalledWith('mouse_click', { x: 100, y: 100 });
  });

  it('SOP 模板任务跳过意图识别（第一条调用即为 ReAct 消息）', async () => {
    const llm = new FakeLLM([
      toolCall('wait', { ms: 100 }),
      '{"thought":"done","done":true,"finalAnswer":"sop ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      sopSteps: ['wait({ms:100}) → ok'],
      // 本用例白盒断言 LLM 调用次数，关闭默认开启的自动验收以隔离变量
      acceptance: { enabled: false }});
    const result = await loop.run('运行模板', 't-sop');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe('sop ok');
    // 2 次调用 = ReAct 2 轮；若误跑了意图识别会是 3 次
    expect(llm.calls.length).toBe(2);
  });

  it('工具连续失败 3 次熔断（拼错工具名不得空转到 maxSteps）', async () => {
    const execute = vi.fn(async () => ({ ok: false, summary: '', error: '未知工具: mouse_dick。你可能想调用 "mouse_click"' }));
    const llm = new FakeLLM(Array.from({ length: 6 }, () => toolCall('mouse_dick', { x: 1, y: 2 })));
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute },
      perception: { async snapshot() { return {}; } },
      // 未知工具默认 L2（S1），需审批回调放行，否则会卡在 waitApproval 轮询
      requestApproval: async () => ({ action: 'approve' as const }),
      planFirst: false});
    const result = await loop.run('打开图标', 't-toolfail');
    expect(result.status).toBe('FAILED');
    expect(result.finalAnswer).toContain('工具连续失败');
    // 熔断在第 3 次执行，而非跑满 maxSteps
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('工具成功后失败计数归零（不误伤偶发失败）', async () => {
    let n = 0;
    const execute = vi.fn(async () => {
      n += 1;
      // 失败、成功、失败、成功... 永不连续 3 次失败
      return n % 2 === 1
        ? { ok: false, summary: '', error: 'boom' }
        : { ok: true, summary: 'ok' };
    });
    const llm = new FakeLLM(Array.from({ length: 6 }, (_, i) =>
      i === 5 ? '{"thought":"done","done":true,"finalAnswer":"ok"}' : toolCall('wait', { ms: 1 })));
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute },
      perception: { async snapshot() { return {}; } },
      planFirst: false});
    const result = await loop.run('混合成败', 't-mixed');
    expect(result.status).toBe('COMPLETED');
    expect(result.finalAnswer).toBe('ok');
  });

  it('画面停滞时重复同一动作被硬拦截（不再做真实注入）', async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: 'ok' }));
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 470, y: 630 }),
      toolCall('mouse_click', { x: 470, y: 631 }),
      toolCall('mouse_click', { x: 470, y: 632 }),
      toolCall('mouse_click', { x: 470, y: 633 }),
      toolCall('mouse_click', { x: 470, y: 634 }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute },
      // 指纹恒定 = 画面从未变化（模拟"点了没反应"）
      perception: { async snapshot() { return { screenshot: Buffer.from('same'), signature: '0'.repeat(64) }; } },
      planFirst: false,
      acceptance: { enabled: false }});
    const result = await loop.run('点输入框', 't-stall');
    expect(result.status).toBe('COMPLETED');
    // 前 3 步执行；第 4、5 步画面连续停滞且动作签名相同 → 被拦截
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('auto 档按步自适应：首步开、例行步关、失败步的下一步自动开思考', async () => {
    let shot = 0;
    let n = 0;
    const execute = vi.fn(async () => {
      n += 1;
      return n === 2 ? { ok: false, summary: '', error: 'boom' } : { ok: true, summary: 'ok' };
    });
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 10, y: 10 }),
      toolCall('mouse_click', { x: 20, y: 20 }),
      toolCall('mouse_click', { x: 30, y: 30 }),
      { toolCalls: [], content: '{"thought":"done","done":true,"finalAnswer":"ok"}' },
    ], 'auto');
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute },
      // 每步画面都在变 → 排除停滞地板，只留「首步/失败」两条信号参与判定
      perception: { async snapshot() { return { screenshot: Buffer.from(`frame-${++shot}`) }; } },
      planFirst: false,
      acceptance: { enabled: false }});
    const result = await loop.run('连续点击三处', 't-think');
    expect(result.status).toBe('COMPLETED');
    // 步1 首步地板 → 开；步2 上一步成功且无歧义 → 关（省钱）；步3 上一步失败 → 开；步4 恢复成功 → 关
    expect(llm.options.map((o) => o.thinkingHint?.think)).toEqual([true, false, true, false]);
    expect(result.stepsDetail[0]?.thinking).toBe('开·首步');
    expect(result.stepsDetail[1]?.thinking).toBe('关·例行');
    expect(result.stepsDetail[2]?.thinking).toBe('开·上一步失败');
    expect(result.thinking).toEqual({ on: 2, total: 4, reasons: { 首步: 1, 上一步失败: 1 } });
  });

  it('非 auto 档（daily）不产出逐步判定，思考信号与步骤标签保持原样', async () => {
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 10, y: 10 }),
      { toolCalls: [], content: '{"thought":"done","done":true,"finalAnswer":"ok"}' },
    ], 'daily');
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false }});
    const result = await loop.run('点一下', 't-think-daily');
    expect(result.status).toBe('COMPLETED');
    expect(llm.options.every((o) => o.thinkingHint?.think === undefined)).toBe(true);
    expect(result.stepsDetail[0]?.thinking).toBeUndefined();
    expect(result.thinking).toEqual({ on: 0, total: 0, reasons: {} });
  });
});