/**
 * wechat-notify.ts — 微信通知文本格式化
 */
import type { ApprovalReplyRoute } from './wechat-approval-inbound';

/**
 * 格式化任务终态为微信通知文本。
 */
export function formatTaskNotification(
  goal: string,
  status: string,
  finalAnswer: string,
): string {
  const statusText =
    status === 'COMPLETED' ? '✅ 已完成'
    : status === 'FAILED' ? '❌ 失败'
    : status === 'CANCELLED' ? '⏹ 已取消'
    : status;
  const answer = (finalAnswer || '(无)').slice(0, 400);
  return `【任务${statusText}】\n目标：${goal.slice(0, 80)}\n结果：${answer}`;
}

/**
 * 格式化审批请求为微信通知文本。
 */
export function formatApprovalNotification(
  tool: string,
  reason: string,
  taskId: string,
): string {
  return `【审批请求】\n工具：${tool}\n原因：${reason || '(无)'}\n任务：${taskId.slice(0, 8)}\n\n回复"同意 ${taskId.slice(0, 8)}"批准，"拒绝 ${taskId.slice(0, 8)}"驳回`;
}

/**
 * 格式化审批入站回复的处理结果（承接出站文案的「回复同意 xxx」）。
 */
export function formatApprovalReplyResult(route: ApprovalReplyRoute): string {
  switch (route.kind) {
    case 'decide':
      return route.decision === 'approve'
        ? `✅ 已批准审批 ${route.id.slice(0, 8)}，任务继续执行。`
        : `⛔ 已驳回审批 ${route.id.slice(0, 8)}。`;
    case 'not_found':
      return `未找到编号「${route.idPrefix}」对应的待审批项：编号可能有误，或审批已处理完毕。`;
    case 'ambiguous':
      return '该编号匹配到多个待审批项，请使用更长的编号后重试。';
    case 'timeout':
      return `审批 ${route.id.slice(0, 8)} 已超时，微信回复不再受理，请在灵动岛处理。`;
  }
}
