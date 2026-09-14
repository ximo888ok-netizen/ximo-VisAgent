// 审批门（自 loop.ts 迁出，语义零改动）：L2+ 动作的审批请求、轮询/回调决策、
// 拒绝重规划与连续被拒熔断（R3）、审批超时挂起、编辑参数回写。
import type { ChatMessage } from '@ximo-visagent/llm-providers';
import type { ClassifiedOperation, TaskStatus, ToolCall } from '@ximo-visagent/shared-types';
import type { ApprovalEngine } from '@ximo-visagent/safety';
import type { AgentEvent, AgentLoopOptions } from './types';
import type { StepRecord } from './memory';
import { pollApproval } from './loop-llm';

/** 审批拒绝的连续终止阈值 */
const MAX_CONSECUTIVE_REJECTIONS = 3;

export interface ApprovalGateInput {
  action: ToolCall;
  classified: ClassifiedOperation;
  /** 批内序号与批长度：拒绝断批时提示剩余未执行动作 */
  ai: number;
  actionCount: number;
  taskId: string;
  appName?: string;
  /** 进入审批时的运行状态与连续被拒计数 */
  status: TaskStatus;
  consecutiveRejections: number;
  approval: ApprovalEngine;
  requestApproval?: AgentLoopOptions['requestApproval'];
  emit: (e: AgentEvent) => void;
  approvalTimeoutMs: number;
  startedAt: number;
  maxDurationMs: number;
  isCancelled: () => boolean;
  stopped: boolean;
  memory: { addStep(record: StepRecord): void };
  messages: ChatMessage[];
}

export interface ApprovalGateResult {
  /** 放行后最终执行参数（断批时调用方忽略） */
  finalArgs: Record<string, unknown>;
  /** true = 断批（等价迁移前 batchBroken = true + break；status 非 RUNNING 时由 loop 结束主循环） */
  batchBroken: boolean;
  /** 回写运行状态（undefined = 保持不变） */
  status?: TaskStatus;
  /** 回写终止文案（undefined = 保持不变） */
  finalAnswer?: string;
  /** 回写连续被拒计数 */
  consecutiveRejections: number;
}

/** 处理一个 L2+ 动作的审批全流程；与迁移前批执行 5b 块逐分支等价 */
export async function runApprovalGate(input: ApprovalGateInput): Promise<ApprovalGateResult> {
  const {
    action, classified, ai, actionCount, taskId, appName, status, consecutiveRejections,
    approval, requestApproval, emit, approvalTimeoutMs, startedAt, maxDurationMs,
    isCancelled, stopped, memory, messages,
  } = input;

  const ap = approval.create({ name: action.name, args: action.args }, classified, taskId);
  emit({ type: 'approval_pending', approvalId: ap.id, tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason });
  const decision = requestApproval ? await requestApproval(ap.id, { tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason, level: classified.level, appName }) : null;
  let consecutive = consecutiveRejections;

  // 被拒公共路径：连续拒绝达阈值即终止；否则拒绝写入记忆、断批并交给模型重新规划
  const onRejected = (thought: string): ApprovalGateResult => {
    consecutive++;
    if (consecutive >= MAX_CONSECUTIVE_REJECTIONS) {
      const finalAnswer = `连续 ${MAX_CONSECUTIVE_REJECTIONS} 次操作被审批拒绝，任务终止`;
      emit({ type: 'error', message: finalAnswer });
      return { finalArgs: action.args, batchBroken: true, status: 'FAILED', finalAnswer, consecutiveRejections: consecutive };
    }
    memory.addStep({ thought, actionName: null, actionArgs: null, resultSummary: '拒绝' });
    emit({ type: 'approval_result', approvalId: ap.id, decision: 'reject', outcome: 'replan' });
    // 拒绝后剩余动作不再执行，交给模型重新规划（批内截断提示仅在任务仍运行时注入）
    if (ai < actionCount - 1 && status === 'RUNNING') {
      messages.push({ role: 'system', content: `批动作在 ${action.name} 处被审批拒绝，剩余 ${actionCount - ai - 1} 个动作未执行。请基于当前画面重新规划。` });
    }
    return { finalArgs: action.args, batchBroken: true, consecutiveRejections: consecutive };
  };

  if (!decision) {
    const outcome = await pollApproval(ap.id, approval, approvalTimeoutMs, emit, startedAt, maxDurationMs, isCancelled);
    if (outcome === 'cancelled') {
      return { finalArgs: action.args, batchBroken: true, status: stopped ? 'EMERGENCY_STOPPED' : 'CANCELLED', consecutiveRejections: consecutive };
    }
    if (outcome === 'task_timeout') {
      emit({ type: 'error', message: '任务超时（审批等待期间）' });
      return { finalArgs: action.args, batchBroken: true, status: 'FAILED', consecutiveRejections: consecutive };
    }
    if (outcome === 'rejected') return onRejected(`操作被审批拒绝: ${approval.get(ap.id)?.reason ?? '用户拒绝'}，请改用其他方案`);
    if (outcome === 'timeout_hang') {
      emit({ type: 'approval_result', approvalId: ap.id, decision: 'timeout', outcome: 'timeout_hang' });
      return { finalArgs: action.args, batchBroken: true, status: 'WAITING_APPROVAL', finalAnswer: `审批超时挂起: ${ap.toolCall.name}（等待人工处理）`, consecutiveRejections: consecutive };
    }
    const finalArgs = approval.finalArgs(ap.id) ?? action.args;
    emit({ type: 'approval_result', approvalId: ap.id, decision: 'approve', outcome: 'executed' });
    emit({ type: 'status', status: 'RUNNING' });
    return { finalArgs, batchBroken: false, status: 'RUNNING', consecutiveRejections: 0 };
  }
  if (decision.action === 'reject') return onRejected(`任务被审批拒绝: ${decision.reason}，请改用其他方案`);
  if (decision.action === 'edit') {
    emit({ type: 'approval_result', approvalId: ap.id, decision: 'edit', outcome: 'executed' });
    return { finalArgs: decision.newArgs ?? action.args, batchBroken: false, consecutiveRejections: 0 };
  }
  approval.decide(ap.id, { action: 'approve' });
  emit({ type: 'approval_result', approvalId: ap.id, decision: 'approve', outcome: 'executed' });
  return { finalArgs: action.args, batchBroken: false, consecutiveRejections: 0 };
}
