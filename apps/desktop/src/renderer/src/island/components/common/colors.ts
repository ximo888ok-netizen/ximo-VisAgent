// 任务状态语义色统一（历史列表 / 统计分布条共用，避免色值散落漂移）
export const TASK_STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#3fe0a0",
  FAILED: "#f87171",
  CANCELLED: "#a1a1aa",
  EMERGENCY_STOPPED: "#f87171",
  RUNNING: "#3fe0a0",
  QUEUED: "#fbbf24",
  WAITING_APPROVAL: "#fbbf24",
  PAUSED: "#60a5fa",
  INTERRUPTED: "#fbbf24",
};

/** 状态色兜底（未知状态中性灰，与原各处 ?? "#a1a1aa" 一致） */
export const STATUS_COLOR_FALLBACK = "#a1a1aa";
