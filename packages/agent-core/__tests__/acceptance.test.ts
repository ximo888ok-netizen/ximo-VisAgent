// 自动验收单测：评审输出解析 + 门控调用（fail-open） + loop 集成（打回/带保留完成）
import { describe, expect, it } from 'vitest';
import { buildAcceptanceMessages, parseVerdict, runAcceptanceGate } from '../src/agent/acceptance';
import { AgentLoop } from '../src/agent/loop';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';

describe('parseVerdict', () => {
  it('解析严格 JSON 与夹在文本里的 JSON', () => {
    expect(parseVerdict('{"pass":true,"reason":"目标已达成"}')).toEqual({ pass: true, reason: '目标已达成' });
    expect(parseVerdict('评审结论如下：{"pass":false,"reason":"尚未打开 Qoder CN"}完')).toEqual({ pass: false, reason: '尚未打开 Qoder CN' });
  });

  it('pass 非布尔或非 JSON 返回 null（fail-open 交给调用方）', () => {
    expect(parseVerdict('{"pass":"yes"}')).toBeNull();
    expect(parseVerdict('看起来完成了')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict('{"pass":true}')).toEqual({ pass: true, reason: '' });
  });
});

describe('buildAcceptanceMessages', () => {
  it('带图片块时 user 内容含该块，轨迹与目标都在文本里', async () => {
    const msgs = await buildAcceptanceMessages('打开Qoder CN看项目进度', '项目在做XX，进度60%', ['- [步1] mouse_click → ok'], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } });
    expect(msgs[0]!.role).toBe('system');
    const user = msgs[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    const textPart = parts.find((p) => p.type === 'text');
    expect(textPart?.text).toContain('打开Qoder CN看项目进度');
    expect(textPart?.text).toContain('[步1] mouse_click');
  });
});

describe('runAcceptanceGate', () => {
  it('评审正常 → 返回 verdict 与 token 计数', async () => {
    const llm: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> {
        return { content: '{"pass":true,"reason":"ok"}', toolCalls: [], usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, model: 'fake' };
      },
    };
    const r = await runAcceptanceGate({ goal: 'g', finalAnswer: 'a', stepsDetail: [], textLLM: llm });
    expect(r.verdict?.pass).toBe(true);
    expect(r.tokens).toBe(120);
  });

  it('评审抛错 → verdict 为 null 且 error 可见（fail-open，不卡死任务）', async () => {
    const llm: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> {
        throw new Error('api down');
      },
    };
    const r = await runAcceptanceGate({ goal: 'g', finalAnswer: 'a', stepsDetail: [], textLLM: llm });
    expect(r.verdict).toBeNull();
    expect(r.error).toContain('api down');
  });
});

// ---------- loop 集成：验收门打回与带保留完成 ----------

class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  calls: ChatMessage[][] = [];
  constructor(private responses: Array<string | { toolCalls: ToolCallResult[]; content?: string }>) {}
  async chat(messages: ChatMessage[], _tools?: ToolDef[]): Promise<ChatResult> {
    this.calls.push(messages);
    const r = this.responses[this.calls.length - 1];
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
    }
    return { content: r.content ?? '', toolCalls: r.toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
  }
}

function toolCall(name: string, args: Record<string, unknown>): { toolCalls: ToolCallResult[]; content?: string } {
  return { toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] };
}

function makeLoop(llm: FakeLLM): AgentLoop {
  return new AgentLoop({
    textLLM: llm,
    executor: { async execute() { return { ok: true, summary: 'ok' }; } },
    perception: { async snapshot() { return { screenshot: Buffer.from('fake'), foreground: { title: 'T', className: '' } }; } },
    planFirst: false,
  });
}

describe('AgentLoop 自动验收集成', () => {
  it('验收不通过 → 打回继续；二次 task_done 通过 → COMPLETED，attempts=2', async () => {
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 100, y: 100 }),
      toolCall('mouse_click', { x: 200, y: 200 }),
      toolCall('mouse_click', { x: 300, y: 300 }),
      '{"thought":"完成","done":true,"finalAnswer":"项目在做UI改版"}',
      '{"pass":false,"reason":"轨迹只有三次点击，没有任何打开Qoder CN的证据"}',
      '{"thought":"补齐","done":true,"finalAnswer":"项目在做UI改版，已完成33个文件的修改"}',
      '{"pass":true,"reason":"轨迹与截图支撑"}',
    ]);
    const events: Array<{ type: string; step?: { thought: string } }> = [];
    const result = await makeLoop(llm).run('打开Qoder CN看进度', 't-acc');
    void events;
    expect(result.status).toBe('COMPLETED');
    expect(result.acceptance).toEqual({ passed: true, attempts: 2 });
    expect(result.finalAnswer).toContain('33个文件');
  });

  it('验收连续不通过 → 达到打回上限（默认 1 次）后带保留完成，finalAnswer 附人工复核提示', async () => {
    const llm = new FakeLLM([
      toolCall('mouse_click', { x: 1, y: 1 }),
      toolCall('mouse_click', { x: 2, y: 2 }),
      toolCall('mouse_click', { x: 3, y: 3 }),
      '{"thought":"完成","done":true,"finalAnswer":"应该好了"}',
      '{"pass":false,"reason":"目标未达成"}',
      '{"thought":"再试","done":true,"finalAnswer":"好了"}',
      '{"pass":false,"reason":"仍然没有证据"}',
    ]);
    const result = await makeLoop(llm).run('验证目标', 't-acc2');
    expect(result.status).toBe('COMPLETED');
    expect(result.acceptance).toEqual({ passed: false, attempts: 2 });
    expect(result.finalAnswer).toContain('请人工复核');
    expect(result.finalAnswer).toContain('累计 2 次');
    expect(result.finalAnswer).toContain('仍然没有证据');
  });

  it('验收关闭（enabled:false）→ task_done 直接生效，无额外评审调用', async () => {
    const llm = new FakeLLM([
      '{"thought":"完成","done":true,"finalAnswer":"完成"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return { screenshot: Buffer.from('fake') }; } },
      planFirst: false,
      acceptance: { enabled: false },
    });
    const result = await loop.run('测试', 't-acc3');
    expect(result.status).toBe('COMPLETED');
    expect(result.acceptance).toBeUndefined();
    expect(llm.calls).toHaveLength(1); // done 前无意图/规划调用，无评审调用
  });
});
