/**
 * orchestrator-audit.ts — AgentEvent → 审计事件与岛事件流的映射
 *
 * 审计库是唯一的增值资产（S2：评估即护城河），因此这里的字段口径必须稳定：
 * 每一步都保留 thought / 动作 / 参数 / 结果摘要 / 安全等级 / 耗时，
 * 归因、蒸馏、回放与基准断言都直接读这些行。
 */
import type { AgentEvent, StepDetail } from '@ximo-visagent/agent-core';
import type { ZODB } from './audit-store';
import { feedStep } from './island-bridge';

/** 摘要截断长度：足够归因与回放阅读，又不至于把库撑爆 */
const THOUGHT_MAX = 500;
const SUMMARY_MAX = 500;

export function persistAgentEvent(audit: ZODB, taskId: string, ev: AgentEvent): void {
  try {
    audit.insert(audit.fromAgentEvent(taskId, { type: ev.type, ...toPayload(ev) }));
  } catch (err) {
    console.error('[audit] 事件落库失败', err);
  }
  // 灵动岛日志流（步骤详情/用量事件一并转发）
  feedStep(ev, taskId);
}

function toPayload(ev: AgentEvent): Record<string, unknown> {
  switch (ev.type) {
    case 'step':
      return {
        step: ev.step.index,
        thought: ev.step.thought.slice(0, THOUGHT_MAX),
        actionName: ev.step.actionName,
        args: ev.step.args,
        resultSummary: ev.step.resultSummary.slice(0, SUMMARY_MAX),
        ok: ev.step.ok,
        level: ev.step.level,
        durationMs: ev.step.durationMs,
      };
    case 'llm_usage':
      return { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
    case 'status':
      return { status: ev.status };
    case 'error':
      return { message: ev.message };
    case 'approval_pending':
      return { approvalId: ev.approvalId, tool: ev.tool, args: ev.args, reason: ev.reason };
    case 'approval_result':
      return { approvalId: ev.approvalId, decision: ev.decision, outcome: ev.outcome };
    case 'perception':
      return { detail: ev.detail };
    default:
      return {};
  }
}

/** 轨迹里有实际动作的步骤（断点续跑与自动重试的步骤骨架） */
export function toStepSkeleton(steps: StepDetail[], limit = 40): string[] {
  return steps
    .filter((s) => s.actionName)
    .map((s) => `${s.actionName}(${JSON.stringify(s.args ?? {})}) → ${s.resultSummary}`)
    .slice(0, limit);
}

/** C4：失败粗分类（v3 归因评论家在此之前，此处仍是基准重试的判据） */
export function classifyFailure(status: string, finalAnswer: string): string | null {
  if (status === 'COMPLETED') return null;
  if (status === 'CANCELLED') return 'USER_CANCELLED';
  if (status === 'EMERGENCY_STOPPED') return 'EMERGENCY_STOP';
  if (status === 'WAITING_APPROVAL') return 'APPROVAL_HANG';
  if (/超时/.test(finalAnswer)) return 'TIMEOUT';
  if (/最大步数/.test(finalAnswer)) return 'MAX_STEPS';
  if (/审批/.test(finalAnswer)) return 'APPROVAL_REJECTED';
  if (/定位失败|元素未找到|not found/.test(finalAnswer)) return 'LOCATE_FAILED';
  if (/LLM|模型|连续失败|重试耗尽/.test(finalAnswer)) return 'LLM_ERROR';
  return 'UNKNOWN';
}
