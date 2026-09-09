/**
 * wechat-notify.ts — 微信通知文本格式化
 */

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
  return `【审批请求】\n工具：${tool}\n原因：${reason || '(无)'}\n任务：${taskId.slice(0, 8)}\n\n回复"同意 ${taskId.slice(0, 8)}"批准，"拒绝"驳回`;
}
