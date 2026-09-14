// recovery 闭环单测：advisor 去重 + ruleId 记账 + auto 动作安全闸 + loop 集成（条目6 全链路）
import { describe, expect, it, vi } from 'vitest';
import { createRecoveryAdvisor, resolveAutoRecovery, type RecoveryContext, type RecoveryExecution, type RecoveryHit } from '../src/agent/recovery';
import { SafetyClassifier } from '@ximo-visagent/safety';
import { AgentLoop } from '../src/agent/loop';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ChatResult, ToolCallResult } from '@ximo-visagent/llm-providers';

// ---------- createRecoveryAdvisor：去重 + 记账（recovery.ts 纯逻辑直测） ----------

const exec = (over: Partial<RecoveryExecution> = {}): RecoveryExecution => ({
  stepIndex: 1, tool: 'ui_click', ok: false, error: '元素 #7 已不存在', windowTitle: '记事本', ...over,
});

describe('createRecoveryAdvisor（hint 去重 + ruleId 记账）', () => {
  it('成功执行：不匹配、直接 null（结算分支在无 pending 时也静默）', () => {
    const matcher = vi.fn();
    const advisor = createRecoveryAdvisor({ matcher });
    expect(advisor.afterExecution(exec({ ok: true }))).toBeNull();
    expect(matcher).not.toHaveBeenCalled();
  });

  it('失败 → matcher 收到与 detect 口径一致的上下文', () => {
    const hit: RecoveryHit = { mode: 'hint', reason: '先 activate_window 再点', ruleId: 'R1' };
    const matcher = vi.fn(() => hit);
    const advisor = createRecoveryAdvisor({ matcher });
    expect(advisor.afterExecution(exec())).toBe(hit);
    expect(matcher).toHaveBeenCalledWith<RecoveryContext[]>({
      stepIndex: 1, lastTool: 'ui_click', lastResult: '元素 #7 已不存在', lastOk: false, windowTitle: '记事本',
    });
  });

  it('同 ruleId 去重：本任务内同一规则只提示一次，matcher 仍被调（后续可换规则）', () => {
    const hit: RecoveryHit = { mode: 'hint', reason: 'r', ruleId: 'R1' };
    const matcher = vi.fn(() => hit);
    const onResult = vi.fn();
    const advisor = createRecoveryAdvisor({ matcher, onResult });
    expect(advisor.afterExecution(exec())).toBe(hit);        // 首次命中
    advisor.afterExecution(exec({ ok: true }));               // 结算 + 无新提示
    expect(advisor.afterExecution(exec())).toBeNull();        // 再次命中同 ruleId → 去重
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('记账闭环：命中 ruleId 后，下一次执行无论成败都先结算上一次命中', () => {
    const onResult = vi.fn();
    const matcher = vi.fn((): RecoveryHit => ({ mode: 'hint', reason: 'r', ruleId: 'R1' }));
    const advisor = createRecoveryAdvisor({ matcher, onResult });
    advisor.afterExecution(exec());                            // 命中 R1，进入待记账
    advisor.afterExecution(exec({ ok: true }));                // 结算：按本次执行结果记账
    expect(onResult).toHaveBeenCalledWith('R1', true);
    // 结算只发生一次（pending 已清空），后续成功不再重复记账
    advisor.afterExecution(exec({ ok: true }));
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('下一次执行也失败 → 按失败记账（success=false）', () => {
    const onResult = vi.fn();
    let ruleSeq = 0;
    const matcher = vi.fn((): RecoveryHit => ({ mode: 'hint', reason: 'r', ruleId: `R${++ruleSeq}` }));
    const advisor = createRecoveryAdvisor({ matcher, onResult });
    advisor.afterExecution(exec());      // 命中 R1
    advisor.afterExecution(exec());      // R1 结算为 false，随后命中 R2
    expect(onResult).toHaveBeenCalledWith('R1', false);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('无 ruleId 的 hint：不去重不记账（宿主无法归因，保持向后兼容）', () => {
    const onResult = vi.fn();
    const hit: RecoveryHit = { mode: 'hint', reason: 'r' };
    const matcher = vi.fn(() => hit);
    const advisor = createRecoveryAdvisor({ matcher, onResult });
    expect(advisor.afterExecution(exec())).toBe(hit);
    expect(advisor.afterExecution(exec({ ok: true }))).toBeNull();
    expect(advisor.afterExecution(exec())).toBe(hit);          // 再次返回，不被去重
    expect(onResult).not.toHaveBeenCalled();
  });

  it('auto 档命中不进 advisor（缺现场校验，只产出 hint）；无 matcher 也安全', () => {
    const advisor = createRecoveryAdvisor({
      matcher: () => ({ mode: 'auto', action: 'mouse_click', args: { x: 1, y: 2 }, reason: 'r', ruleId: 'R1' }),
    });
    expect(advisor.afterExecution(exec())).toBeNull();
    // auto 命中不记 pending：同一步再失败也不会把 auto 规则当 hint 结算
    const onResult = vi.fn();
    const advisor2 = createRecoveryAdvisor({
      matcher: () => ({ mode: 'auto', action: 'keyboard_press', reason: 'r', ruleId: 'R1' }),
      onResult,
    });
    advisor2.afterExecution(exec());
    advisor2.afterExecution(exec({ ok: true }));
    expect(onResult).not.toHaveBeenCalled();
    expect(createRecoveryAdvisor({}).afterExecution(exec())).toBeNull();
  });
});

// ---------- resolveAutoRecovery：auto 替换动作的安全闸 ----------

describe('resolveAutoRecovery（auto 动作仅在 ≤L1 时放行）', () => {
  const classifier = new SafetyClassifier();

  it('L1 动作（mouse_click）→ 放行并带默认空 args', () => {
    const r = resolveAutoRecovery(
      { mode: 'auto', action: 'mouse_click', reason: 'r' },
      { foreground: { title: '记事本', className: 'Notepad' } },
      classifier,
    );
    expect(r).toEqual({ name: 'mouse_click', args: {} });
  });

  it('L2+ 动作（file_write / 未知工具）→ null，交调用方降级为提示', () => {
    expect(resolveAutoRecovery(
      { mode: 'auto', action: 'file_write', args: { path: 'a.txt' }, reason: 'r' },
      {},
      classifier,
    )).toBeNull();
    expect(resolveAutoRecovery(
      { mode: 'auto', action: 'mystery_tool', reason: 'r' },
      {},
      classifier,
    )).toBeNull();
  });

  it('无 action 字段 → null（hint 型命中不进此闸）', () => {
    expect(resolveAutoRecovery({ mode: 'hint', reason: 'r' }, {}, classifier)).toBeNull();
  });
});

// ---------- loop 集成：失败 → 注入提示 → 下一步结算（走真实 AgentLoop） ----------

class FakeLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  calls: ChatMessage[][] = [];
  private idx = 0;
  constructor(private responses: Array<string | { toolCalls: ToolCallResult[] }>) {}
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const r = this.responses[this.idx];
    this.idx++;
    if (r === undefined) throw new Error('fake LLM 响应脚本已用尽');
    if (typeof r === 'string') {
      return { content: r, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
    }
    return { content: '', toolCalls: r.toolCalls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
  }
}

const toolCall = (name: string, args: Record<string, unknown>) =>
  ({ toolCalls: [{ id: 't1', name, args: JSON.stringify(args) }] });

describe('AgentLoop × recovery 闭环（条目6 集成）', () => {
  it('失败步注入 [经验恢复] 提示；下一动作成功后 onRecoveryResult(ruleId, true) 结算', async () => {
    const matchCtxs: RecoveryContext[] = [];
    const onRecoveryResult = vi.fn();
    const llm = new FakeLLM([
      toolCall('wait', { ms: 1 }),
      toolCall('wait', { ms: 1 }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    const hintEvents: string[] = [];
  const loop = new AgentLoop({
      textLLM: llm,
      executor: {
        execute: vi.fn()
          .mockResolvedValueOnce({ ok: false, summary: '', error: '找不到窗口' })
          .mockResolvedValueOnce({ ok: true, summary: 'ok' }),
      },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      recoveryMatcher: (ctx) => { matchCtxs.push(ctx); return { mode: 'hint', reason: '上次经验：先 activate_window 再操作', ruleId: 'R-act' }; },
      onRecoveryResult,
      onEvent: (e) => { if (e.type === 'step' && e.step.thought.includes('[经验恢复]')) hintEvents.push(e.step.resultSummary); },
    });
    const result = await loop.run('操作记事本', 't-rec-1');
    expect(result.status).toBe('COMPLETED');
    // 失败现场上下文传入 matcher
    expect(matchCtxs[0]).toMatchObject({ lastTool: 'wait', lastOk: false, lastResult: '找不到窗口' });
    // hint 注入为系统消息 + [经验恢复] 步骤事件（文案回显在 resultSummary）
    expect(hintEvents).toHaveLength(1);
    expect(hintEvents[0]).toContain('activate_window');
    // 下一次执行成功 → 记账 true（且只记一次）
    expect(onRecoveryResult).toHaveBeenCalledTimes(1);
    expect(onRecoveryResult).toHaveBeenCalledWith('R-act', true);
  });

  it('同 ruleId 连续失败只提示一次（去重），第二次失败按 success=false 结算', async () => {
    const onRecoveryResult = vi.fn();
    let matcherCalls = 0;
    const llm = new FakeLLM([
      toolCall('wait', { ms: 1 }),
      toolCall('wait', { ms: 1 }),
      '{"thought":"done","done":true,"finalAnswer":"ok"}',
    ]);
    let hintEvents = 0;
    const loop = new AgentLoop({
      textLLM: llm,
      executor: { execute: async () => ({ ok: false, summary: '', error: 'boom' }) },
      perception: { async snapshot() { return {}; } },
      planFirst: false,
      acceptance: { enabled: false },
      recoveryMatcher: () => { matcherCalls++; return { mode: 'hint', reason: 'r', ruleId: 'R-dup' }; },
      onRecoveryResult,
      onEvent: (e) => { if (e.type === 'step' && e.step.thought.includes('[经验恢复]')) hintEvents++; },
    });
    await loop.run('反复失败', 't-rec-2');
    expect(hintEvents).toBe(1);
    expect(matcherCalls).toBe(2);
    expect(onRecoveryResult).toHaveBeenCalledWith('R-dup', false);
    expect(onRecoveryResult).toHaveBeenCalledTimes(1);
  });
});
