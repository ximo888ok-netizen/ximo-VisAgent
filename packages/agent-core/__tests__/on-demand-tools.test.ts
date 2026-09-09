// 按需加载工具单测：常驻/可选拆分 + request_tools 元动作（loop 内拦截）+ buildToolDefs 激活集
import { describe, expect, it, vi } from 'vitest';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import { AgentLoop } from '../src/agent/loop';
import { buildToolDefs } from '../src/agent/loop-helpers';
import { buildSystemPrompt } from '../src/prompts/system';
import { OPTIONAL_TOOL_SCHEMAS, TOOL_SCHEMA_MAP, TOOL_SCHEMAS } from '../src/tools/schema';

const FIXED_NAMES = TOOL_SCHEMAS.map((t) => t.name);

describe('常驻/可选工具拆分', () => {
  it('直操模式：常驻含鼠标键盘/剪贴板/UIA定位/文件 + 元工具；look_close/wait/excel 可选', () => {
    for (const n of ['mouse_click', 'mouse_drag', 'mouse_scroll', 'keyboard_type', 'keyboard_press',
      'ui_locate', 'ui_click',
      'open_app', 'activate_window', 'get_clipboard', 'set_clipboard',
      'file_read', 'file_write', 'file_list', 'chat_reply', 'task_done', 'request_tools']) {
      expect(FIXED_NAMES).toContain(n);
    }
    // ui_locate/ui_click 升回常驻（2026-09-07 飘移修复）：桌面图标/系统对话框走 UIA 像素级定位，
    // flash 模型目测直点误差 ±20-50px 大于图标间距，按需加载模式导致模型从不调用 → 必点飞。
    for (const n of ['wait', 'look_close', 'excel_read_range', 'excel_write_cell']) {
      expect(FIXED_NAMES).not.toContain(n);
      expect(OPTIONAL_TOOL_SCHEMAS.map((t) => t.name)).toContain(n);
    }
  });

  it('全量注册表 = 常驻 + 可选（拼错纠正仍覆盖全部）', () => {
    expect(Object.keys(TOOL_SCHEMA_MAP).length).toBe(TOOL_SCHEMAS.length + OPTIONAL_TOOL_SCHEMAS.length);
  });
});

describe('buildToolDefs（激活集过滤）', () => {
  it('未加载任何可选工具时只含常驻集', () => {
    const defs = buildToolDefs(new Set());
    expect(defs.map((d) => d.function.name)).toEqual(FIXED_NAMES);
  });

  it('加载 wait 后包含 wait，未加载的 look_close 仍缺席', () => {
    const defs = buildToolDefs(new Set(['wait']));
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('wait');
    expect(names).not.toContain('look_close');
  });

  it('custom_* 工具也按需：未激活不进列表，激活后进入', () => {
    const custom = { name: 'custom_report', description: '生成报表', level: 1 as const, source: 'office' as const, parameters: { type: 'object' as const, properties: {} } };
    const off = buildToolDefs(new Set(), [custom]);
    expect(off.map((d) => d.function.name)).not.toContain('custom_report');
    const on = buildToolDefs(new Set(['custom_report']), [custom]);
    expect(on.map((d) => d.function.name)).toContain('custom_report');
  });
});

describe('buildSystemPrompt（可选目录注入）', () => {
  it('传入目录时生成 request_tools 指引；不传时无该段', () => {
    const withCatalog = buildSystemPrompt('目标', undefined, undefined, undefined, undefined, OPTIONAL_TOOL_SCHEMAS);
    expect(withCatalog).toContain('## 可选工具');
    expect(withCatalog).toContain('request_tools');
    expect(withCatalog).toContain('excel_write_cell');
    const bare = buildSystemPrompt('目标');
    expect(bare).not.toContain('## 可选工具');
  });
});

// ---------- loop 集成：request_tools 拦截 ----------

class ToolCaptureLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  /** 每次调用的 tools 参数快照 */
  toolSnapshots: ToolDef[][] = [];
  private idx = 0;
  constructor(private script: Array<string | { toolCalls: ToolCallResult[]; content?: string }>) {}

  async chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<ChatResult> {
    this.toolSnapshots.push(tools ?? []);
    const r = this.script[this.idx];
    this.idx++;
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
    }
    return { content: r.content ?? '', toolCalls: r.toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
  }
}

function toolCall(name: string, args: Record<string, unknown>): { toolCalls: ToolCallResult[] } {
  return { toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] };
}

describe('AgentLoop + request_tools', () => {
  it('request_tools 加载 wait：下一步工具列表包含 wait，且 request_tools 不进执行器', async () => {
    const executed: string[] = [];
    const llm = new ToolCaptureLLM([
      '{"intent":"TASK"}',
      toolCall('request_tools', { names: ['wait'] }),
      toolCall('wait', { ms: 10 }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name) { executed.push(name); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
    });
    const result = await loop.run('测试', 't1');
    expect(result.status).toBe('COMPLETED');
    expect(executed).toEqual(['wait']); // request_tools 被 loop 拦截，不触执行器
    // 主循环共 3 次 LLM 调用（0 号是意图识别，无 tools）
    expect(llm.toolSnapshots.length).toBe(4);
    const before = llm.toolSnapshots[1]!.map((t) => t.function.name);
    const after = llm.toolSnapshots[2]!.map((t) => t.function.name);
    expect(before).not.toContain('wait');
    expect(after).toContain('wait');
  });

  it('拼错的工具名被拒并反馈可选目录', async () => {
    const llm = new ToolCaptureLLM([
      '{"intent":"TASK"}',
      toolCall('request_tools', { names: ['waiy'] }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      onEvent: (e) => {
        if (e.type === 'step' && e.step.actionName === 'request_tools') {
          expect(e.step.ok).toBe(false);
          expect(e.step.resultSummary).toContain('waiy');
          expect(e.step.resultSummary).toContain('wait');
        }
      },
    });
    const result = await loop.run('测试', 't2');
    expect(result.status).toBe('COMPLETED');
  });

  it('custom_* 工具未加载时模型看不到 schema，加载后可见', async () => {
    const executed: string[] = [];
    const custom = { name: 'custom_ping', description: '测试工具', level: 1 as const, source: 'office' as const, parameters: { type: 'object' as const, properties: {} } };
    const llm = new ToolCaptureLLM([
      '{"intent":"TASK"}',
      toolCall('request_tools', { names: ['custom_ping'] }),
      toolCall('custom_ping', {}),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute(name) { executed.push(name); return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      // custom_ping 对默认分类器是未知工具 → L2（S1 兜底），测试提供自动批准走通链路
      requestApproval: async () => ({ action: 'approve' }),
      extraTools: [custom],
    });
    const result = await loop.run('测试', 't3');
    expect(result.status).toBe('COMPLETED');
    expect(executed).toEqual(['custom_ping']);
    expect(llm.toolSnapshots[1]!.map((t) => t.function.name)).not.toContain('custom_ping');
    expect(llm.toolSnapshots[2]!.map((t) => t.function.name)).toContain('custom_ping');
  });

  it('request_tools 为 L0：不触发审批', async () => {
    const approvalSpy = vi.fn();
    const llm = new ToolCaptureLLM([
      '{"intent":"TASK"}',
      toolCall('request_tools', { names: ['wait'] }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { async execute() { return { ok: true, summary: 'ok' }; } },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      requestApproval: async (id) => { approvalSpy(id); return { action: 'approve' }; },
    });
    const result = await loop.run('测试', 't4');
    expect(result.status).toBe('COMPLETED');
    expect(approvalSpy).not.toHaveBeenCalled();
  });
});
