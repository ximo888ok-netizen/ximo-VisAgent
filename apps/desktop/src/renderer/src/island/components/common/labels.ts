// 任务状态中文标签统一（全 UI 引用，避免 QUEUED/WAITING_APPROVAL 等文案散落）
export const TASK_STATUS_LABEL: Record<string, string> = {
  IDLE: "就绪",
  PLANNING: "规划中",
  RUNNING: "运行中",
  PAUSED: "已暂停",
  WAITING_APPROVAL: "挂起待审批",
  QUEUED: "排队中",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  INTERRUPTED: "中断",
  EMERGENCY_STOPPED: "已急停",
};

export function statusLabel(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status;
}

// 审批档位中文标签（选择器 / 顶部徽标共用）
export const APPROVAL_MODE_LABEL: Record<string, string> = {
  manual: "手动审批",
  auto: "自动审批",
  autonomous: "完全自主",
};

// 岛左翼实时状态中文标签（AgentStatus 域，与任务终态 TASK_STATUS_LABEL 区分）
export const AGENT_STATUS_LABEL: Record<string, string> = {
  idle: "就绪",
  thinking: "运行中",
  paused: "已暂停",
  waiting_approval: "等待审批",
  error: "异常",
  stopped: "已停止",
};
