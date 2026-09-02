/**
 * taskSlice.ts — 任务管理状态 slice
 */
import type { TaskFinishedPayload } from "@shared/island-contracts";

export interface TaskSliceState {
  currentTaskId: string | null;
  currentTaskGoal: string;
  taskRunning: boolean;
  taskFinished: TaskFinishedPayload | null;
  setTaskStarted(taskId: string, goal: string): void;
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
    taskFinished: null,

    setTaskStarted(taskId, goal) {
      set({ currentTaskId: taskId, currentTaskGoal: goal, taskRunning: true, taskFinished: null });
    },

    setTaskFinished(payload) {
      set({ taskRunning: false, taskFinished: payload });
    },

    clearTask() {
      set({ currentTaskId: null, currentTaskGoal: "", taskRunning: false, taskFinished: null });
    },
  };
}
