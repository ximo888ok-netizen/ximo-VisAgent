// 按步思考预算（auto 档）单测：地板规则各分支、模型自请只作用于下一步、
// 非 auto 档不表态（旧四档语义零回归）、自请标记解析、观测标签与终态汇总。
import { describe, expect, it } from 'vitest';
import {
  createThinkingBudget, decideThinkingStep, extractThinkRequest, floorReason,
} from '../src/agent/thinking-policy';
import { parseModelOutput } from '../src/agent/loop-helpers';
import type { AgentEvent, StepDetail } from '../src/agent/types';

function step(index: number, over: Partial<StepDetail> = {}): StepDetail {
  return { index, thought: '', actionName: 'mouse_click', resultSummary: 'ok', ok: true, ...over };
}

/** 干净信号基线：例行第 5 步（无自请、无干预、轨迹无失败）→ 关思考 */
const routine = {
  mode: 'auto' as const,
  step: 5,
  recentFailures: 0,
  noChangeCount: 0,
  trail: [step(3), step(4)] as StepDetail[],
  interventions: [] as string[],
  modelAsk: false,
  planned: false,
};

describe('地板规则（模型不使用自请也能触发）', () => {
  it('首步必思考；规划器产出多子任务时归因为「规划产出」', () => {
    expect(decideThinkingStep({ ...routine, step: 1, trail: [] })).toEqual({ think: true, reason: '首步' });
    expect(decideThinkingStep({ ...routine, step: 1, trail: [], planned: true })?.reason).toBe('规划产出');
  });

  it('上一步失败（ok=false）→ 强制思考', () => {
    expect(floorReason({ ...routine, trail: [step(4, { ok: false })] })).toBe('上一步失败');
  });

  it('批执行中断批（同步号内后一个动作失败）优先于普通失败归因', () => {
    const trail = [step(4, { actionName: 'mouse_click' }), step(4, { actionName: 'keyboard_type', ok: false })];
    expect(floorReason({ ...routine, trail })).toBe('批执行中断');
  });

  it('L2+ 审批过的动作之后一步必思考', () => {
    expect(floorReason({ ...routine, trail: [step(4, { level: 2 })] })).toBe('L2+审批');
    expect(floorReason({ ...routine, trail: [step(4, { level: 1 })] })).toBeNull();
  });

  it('ui_locate 多候选（歧义）→ 强制思考；唯一命中不算', () => {
    expect(floorReason({ ...routine, trail: [step(4, { actionName: 'ui_locate', resultSummary: '找到3个: 保存, 另存为, 导出' })] })).toBe('定位歧义');
    expect(floorReason({ ...routine, trail: [step(4, { actionName: 'ui_locate', resultSummary: '找到1个: 保存' })] })).toBeNull();
  });

  it('停滞/熔断等干预提示、画面停滞、连续失败 → 强制思考', () => {
    expect(floorReason({ ...routine, interventions: ['里程碑审计'] })).toBe('里程碑审计');
    expect(floorReason({ ...routine, interventions: ['停滞提示', '熔断预警'] })).toBe('熔断预警');
    expect(floorReason({ ...routine, noChangeCount: 2 })).toBe('画面停滞');
    expect(floorReason({ ...routine, recentFailures: 2 })).toBe('连续失败');
  });

  it('例行且无歧义的步骤关思考（省钱）', () => {
    expect(decideThinkingStep(routine)).toEqual({ think: false, reason: '例行' });
    expect(decideThinkingStep({ ...routine, noChangeCount: 1 })).toEqual({ think: false, reason: '例行' });
  });

  it('地板优先于自请；无地板时自请生效', () => {
    expect(decideThinkingStep({ ...routine, modelAsk: true })).toEqual({ think: true, reason: '模型自请' });
    expect(decideThinkingStep({ ...routine, modelAsk: true, step: 1, trail: [] })?.reason).toBe('首步');
  });

  it('daily/long/deep 与未配置档不表态（旧语义零回归）', () => {
    for (const mode of ['daily', 'long', 'deep', undefined] as const) {
      expect(decideThinkingStep({ ...routine, mode, modelAsk: true, step: 1, trail: [] })).toBeNull();
    }
  });
});

describe('模型自请标记（复用 thought 通道，工具表零改动）', () => {
  it('抽取并剥离标记，正文不受污染；无标记原样返回', () => {
    expect(extractThinkRequest('点哪个保存按钮？[需思考]')).toEqual({ text: '点哪个保存按钮？', ask: true });
    expect(extractThinkRequest('need [think] next')).toEqual({ text: 'need next', ask: true });
    expect(extractThinkRequest('直接输入即可')).toEqual({ text: '直接输入即可', ask: false });
  });

  it('function calling 协议下解析出 needThink', () => {
    const parsed = parseModelOutput('这一堆候选要选一个 [需思考]', [{ name: 'ui_locate', args: '{"query":"保存"}' }]);
    expect(parsed.needThink).toBe(true);
    expect(parsed.thought).toBe('这一堆候选要选一个');
    expect(parseModelOutput('继续', [{ name: 'mouse_click', args: '{"x":1,"y":2}' }]).needThink).toBe(false);
  });
});

describe('ThinkingBudget 接线状态机（观测 + 记账 + 自请只作用于下一步）', () => {
  /** 无轨迹基线：step 1 命中首步地板，step≥2 无信号即例行 */
  const fresh = { mode: 'auto' as const, step: 1, recentFailures: 0, noChangeCount: 0, trail: [] as StepDetail[], planned: false };

  it('上一步注入的干预提示让下一步开思考，且只生效一步', () => {
    const budget = createThinkingBudget('t-floor');
    const nudge: AgentEvent = { type: 'step', step: step(1, { thought: '[停滞纠正] 画面连续 3 步无变化', actionName: null }) };
    budget.observe(nudge);
    expect(budget.decide({ ...fresh, step: 2 })).toEqual({ think: true, reason: '停滞提示' });
    expect(budget.decide({ ...fresh, step: 3 })).toEqual({ think: false, reason: '例行' });
  });

  it('模型自请影响下一步（本步判定早于本步请求），一步后衰减', () => {
    const budget = createThinkingBudget('t-ask');
    expect(budget.decide(fresh)).toEqual({ think: true, reason: '首步' });
    budget.noteAsk(true);
    expect(budget.decide({ ...fresh, step: 2 })).toEqual({ think: true, reason: '模型自请' });
    expect(budget.decide({ ...fresh, step: 3 })).toEqual({ think: false, reason: '例行' });
  });

  it('异常上报与审批结果都算地板（审计库 43 次「模型未输出工具调用」的对策）', () => {
    const budget = createThinkingBudget('t-err');
    budget.decide(fresh);
    budget.observe({ type: 'error', message: '模型未输出工具调用' });
    expect(budget.decide({ ...fresh, step: 2 })?.reason).toBe('异常上报');
    budget.observe({ type: 'approval_result', approvalId: 'a', decision: 'reject', outcome: 'replan' });
    expect(budget.decide({ ...fresh, step: 3 })?.reason).toBe('审批已决');
  });

  it('非 auto 档不表态时没有标签、不进统计（观测口径零污染）', () => {
    const budget = createThinkingBudget('t-daily');
    expect(budget.decide({ ...fresh, mode: 'daily' })).toBeNull();
    expect(budget.label()).toBeUndefined();
    expect(budget.summary()).toEqual({ on: 0, total: 0, reasons: {} });
  });

  it('终态汇总思考步数/占比与原因分布（量收益用）', () => {
    const budget = createThinkingBudget('t-stats');
    budget.decide(fresh);                        // 步1 开（首步）
    budget.decide({ ...fresh, step: 2 });        // 步2 关（例行）
    expect(budget.summary()).toEqual({ on: 1, total: 2, reasons: { 首步: 1 } });
  });

  it('标签随判定产出，供 step 事件与审计库落库', () => {
    const budget = createThinkingBudget('t-label');
    budget.decide(fresh);
    expect(budget.label()).toBe('开·首步');
    budget.decide({ ...fresh, step: 2 });
    expect(budget.label()).toBe('关·例行');
  });
});
