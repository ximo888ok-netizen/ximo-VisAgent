// 任务状态语义色统一（历史列表 / 统计分布条共用，避免色值散落漂移）
export const TASK_STATUS_COLOR: Record<string, string> = {
  COMPLETED: "var(--c-thinking)",
  FAILED: "var(--c-error)",
  CANCELLED: "var(--p-ink-7)",
  EMERGENCY_STOPPED: "var(--c-error)",
  RUNNING: "var(--c-thinking)",
  QUEUED: "var(--c-waiting)",
  WAITING_APPROVAL: "var(--c-waiting)",
  PAUSED: "var(--p-ice-400)",
  INTERRUPTED: "var(--c-waiting)",
};

/** 状态色兜底（未知状态中性灰，与原各处 ?? "var(--p-ink-7)" 一致） */
export const STATUS_COLOR_FALLBACK = "var(--p-ink-7)";
