/**
 * runSlice.ts — 任务运行态：步骤时间线 / token 用量 / 暂停态
 */
import type { StepDetailEvent, UsageEvent, TaskFinishedPayload } from "@shared/island-contracts";

export interface RunSliceState {
  /** 当前任务步骤时间线（含 thought/args/result） */
  steps: StepDetailEvent[];
  /** 累计 token */
  promptTokens: number;
  completionTokens: number;
  /** 最近一次用量事件时间 */
  lastUsageTs: number;
  /** 暂停态（主进程 PAUSED 事件驱动） */
  taskPaused: boolean;
  pushStepDetail(ev: StepDetailEvent): void;
  applyUsage(ev: UsageEvent): void;
  setTaskPaused(paused: boolean): void;
  resetRun(): void;
  /** BUG-09 修复：重命名以避免与 taskSlice.setTaskFinished 同名覆盖 */
  onTaskFinishedRuntime(payload: TaskFinishedPayload): void;
}

export function createRunSlice(
  set: (fn: Partial<RunSliceState> | ((s: RunSliceState) => Partial<RunSliceState>)) => void,
): RunSliceState {
  return {
    steps: [],
    promptTokens: 0,
    completionTokens: 0,
    lastUsageTs: 0,
    taskPaused: false,

    pushStepDetail(ev) {
      set((s) => ({ steps: [...s.steps, ev].slice(-120) }));
    },

    applyUsage(ev) {
      set((s) => ({
        promptTokens: s.promptTokens + ev.promptTokens,
        completionTokens: s.completionTokens + ev.completionTokens,
        lastUsageTs: ev.ts,
      }));
    },

    setTaskPaused(paused) {
      set({ taskPaused: paused });
    },

    resetRun() {
      set({ steps: [], promptTokens: 0, completionTokens: 0, lastUsageTs: 0, taskPaused: false });
    },

    /** BUG-09 修复：重命名以避免与 taskSlice.setTaskFinished 同名覆盖 */
    onTaskFinishedRuntime(payload) {
      // WAITING_APPROVAL 挂起不算终态清理；其余终态保留 steps 供查看
      if (payload.status === "WAITING_APPROVAL") return;
      set({ taskPaused: false });
    },
  };
}
