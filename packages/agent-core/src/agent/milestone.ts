// L2 里程碑校验：长任务在 1/3、2/3 步数处的子目标对账（纯逻辑，无循环状态）
import type { ChatMessage, ILLMClient } from '@ximo-visagent/llm-providers';
import type { AgentEvent, StepDetail } from './types';

export interface MilestoneAudit {
  drift: boolean;
  /** 已完成子任务的具体内容（注入给模型防止重做） */
  done: string[];
  /** 兼容字段：done.length */
  doneCount: number;
  current: string;
}

/** 判断本步是否为里程碑检查点（1/3 与 2/3 处）。
 *  多子任务必须对账；单目标任务步数预算够大（≥40，即长任务）也要对账。 */
export function isMilestoneStep(step: number, maxSteps: number, subTaskCount: number): boolean {
  const gate = subTaskCount > 1 || maxSteps >= 40;
  if (!gate) return false;
  return step === Math.floor(maxSteps / 3) || step === Math.floor((maxSteps * 2) / 3);
}

/** 审计消息组装 */
function auditMessages(goal: string, stepsDetail: StepDetail[]): ChatMessage[] {
  const trail = stepsDetail
    .slice(-12)
    .map((s) => `- ${s.actionName ?? '思考'} → ${(s.resultSummary || '').slice(0, 60)}`)
    .join('\n');
  return [
    { role: 'system', content: '你是任务里程碑审计员。对照总目标与最近轨迹，判断是否偏离。只输出 JSON：{"done":["已完成子任务"],"current":"当前子任务","drift":true|false}。' },
    { role: 'user', content: `总目标: ${goal}\n最近步骤:\n${trail}` },
  ];
}

/** 跑一次里程碑审计：失败返回 null（调用方静默跳过，不影响主流程）。
 *  成本说明：每次审计 = 1 次 textLLM 调用，每任务最多 2 次（1/3、2/3 处），属可接受固定成本。 */
export async function runMilestoneAudit(textLLM: ILLMClient, goal: string, stepsDetail: StepDetail[]): Promise<MilestoneAudit | null> {
  try {
    const res = await textLLM.chat(auditMessages(goal, stepsDetail));
    const m = res.content?.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { drift?: unknown; done?: unknown; current?: unknown };
    const done = Array.isArray(parsed.done) ? (parsed.done as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return {
      drift: parsed.drift === true,
      done,
      doneCount: done.length,
      current: typeof parsed.current === 'string' ? parsed.current : '',
    };
  } catch {
    return null;
  }
}

/** 审计结论 → 注入给模型的纠偏/确认消息（正常时列出已完成项，防止模型重做） */
export function milestoneMessage(audit: MilestoneAudit, step: number, maxSteps: number, goal: string): string {
  if (audit.drift) {
    return `⛔ 里程碑审计（${step}/${maxSteps} 步）：检测到偏离总目标。总目标是「${goal}」，当前在做「${audit.current}」。立即回到总目标；已无关的操作全部停止。`;
  }
  const doneList = audit.done.slice(0, 5).map((d, i) => `${i + 1}) ${d}`).join(' ');
  return `里程碑审计（${step}/${maxSteps} 步）：已完成：${doneList || '（无）'}；当前：${audit.current}。已完成的不重做；若总目标已达成，立即 task_done。`;
}

/**
 * 里程碑检查点处置（loop 侧调用）：非检查点或审计失败都返回 null 且静默——
 * 审计器故障绝不卡死任务；命中时注入纠偏/确认消息、发步骤事件，并**返回审计结果**
 * 供 loop 更新常驻任务账本的「已完成数」（A3：把 checkpoint 级进度变成每步可见）。
 */
export async function applyMilestoneCheck(
  opts: { textLLM: ILLMClient; goal: string; stepsDetail: StepDetail[]; step: number; maxSteps: number; subTaskCount: number },
  ctx: { messages: ChatMessage[]; emit: (event: AgentEvent) => void },
): Promise<MilestoneAudit | null> {
  if (!isMilestoneStep(opts.step, opts.maxSteps, opts.subTaskCount)) return null;
  const audit = await runMilestoneAudit(opts.textLLM, opts.goal, opts.stepsDetail);
  if (!audit) return null;
  ctx.messages.push({ role: 'system', content: milestoneMessage(audit, opts.step, opts.maxSteps, opts.goal) });
  ctx.emit({ type: 'step', step: { index: opts.step, thought: `[里程碑]${audit.drift ? '已纠偏' : '正常'}`, actionName: null, resultSummary: audit.current, ok: !audit.drift } });
  return audit;
}
