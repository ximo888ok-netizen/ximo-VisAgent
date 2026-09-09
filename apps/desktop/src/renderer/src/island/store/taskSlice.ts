/**
 * taskSlice.ts — 任务管理状态 slice
 */
import type { TaskFinishedPayload } from "@shared/island-contracts";

export interface TaskSliceState {
  currentTaskId: string | null;
  currentTaskGoal: string;
  taskRunning: boolean;
  /** A5：排队中（含位次，启动那一刻快照） */
  taskQueuedIndex: number | null;
  taskFinished: TaskFinishedPayload | null;
  setTaskStarted(taskId: string, goal: string, queuedIndex?: number): void;
  setTaskFinished(payload: TaskFinishedPayload): void;
  clearTask(): void;
}

export function createTaskSlice(
  set: (fn: Partial<TaskSliceState> | ((s: TaskSliceState) => Partial<TaskSliceState>)) => void,
  _get: () => TaskSliceState,
): TaskSliceState {
  return {
    currentTaskId: null,
    currentTaskGoal: "",
    taskRunning: false,
    taskQueuedIndex: null,
    taskFinished: null,

    setTaskStarted(taskId, goal, queuedIndex) {
      set({
        currentTaskId: taskId,
        currentTaskGoal: goal,
        // queuedIndex>0 表示在排队；0/undefined 表示立即执行
        taskRunning: queuedIndex === undefined || queuedIndex === 0,
        taskQueuedIndex: queuedIndex && queuedIndex > 0 ? queuedIndex : null,
        taskFinished: null,
      });
    },

    setTaskFinished(payload) {
      set({ taskRunning: false, taskQueuedIndex: null, taskFinished: payload });
    },

    clearTask() {
      set({ currentTaskId: null, currentTaskGoal: "", taskRunning: false, taskQueuedIndex: null, taskFinished: null });
    },
  };
}
