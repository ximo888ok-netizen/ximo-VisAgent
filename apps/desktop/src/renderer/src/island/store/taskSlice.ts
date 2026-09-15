/**
 * taskSlice.ts — 任务管理状态 slice（含 A-M2 目标应用 chip / 选择器状态）
 */
import type { AppEntry, TargetApp, TaskFinishedPayload } from "@shared/island-contracts";

/** A-M7 收口卡「转为长期任务」草稿（B-M1 接实现：路由到定时面板预填，A 期仅携带 payload） */
export interface ConvertToLongTaskDraft {
  goal: string;
  sourceTaskId: string | null;
  targetApp: TargetApp | null;
}

export interface TaskSliceState {
  currentTaskId: string | null;
  currentTaskGoal: string;
  taskRunning: boolean;
  /** A5：排队中（含位次，启动那一刻快照） */
  taskQueuedIndex: number | null;
  taskFinished: TaskFinishedPayload | null;

  // ---- A-M2 目标应用绑定（规划 §4.1，单实例：任何时刻至多 1 chip）----
  /** 待发送任务的锚定应用；null = 无锚态。chip 生命周期归 composer，发送成功即清空 */
  targetApp: TargetApp | null;
  /** 主进程 existsSync 预检失败 → chip 标红占位态（点击重开面板替换） */
  targetAppInvalid: boolean;
  /** 应用选择器弹层开关 */
  appPickerOpen: boolean;
  /** apps:recent 缓存（冷启动空闲预热写入；面板打开时刷新，推荐组数据源） */
  recentApps: AppEntry[];
  /** 「转为长期任务」草稿（A-M7 留路由；B-M1 接 job 载荷实现） */
  convertDraft: ConvertToLongTaskDraft | null;

  setTaskStarted(taskId: string, goal: string, queuedIndex?: number): void;
  setTaskFinished(payload: TaskFinishedPayload): void;
  clearTask(): void;
  /** 绑定/替换/移除（null）chip；任何写入都清除标红态 */
  setTargetApp(app: TargetApp | null): void;
  setTargetAppInvalid(invalid: boolean): void;
  setAppPickerOpen(open: boolean): void;
  setRecentApps(apps: AppEntry[]): void;
  setConvertDraft(draft: ConvertToLongTaskDraft | null): void;
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
    targetApp: null,
    targetAppInvalid: false,
    appPickerOpen: false,
    recentApps: [],
    convertDraft: null,

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

    setTargetApp(app) {
      set({ targetApp: app, targetAppInvalid: false });
    },

    setTargetAppInvalid(invalid) {
      set({ targetAppInvalid: invalid });
    },

    setAppPickerOpen(open) {
      set({ appPickerOpen: open });
    },

    setRecentApps(apps) {
      set({ recentApps: apps });
    },

    setConvertDraft(draft) {
      set({ convertDraft: draft });
    },
  };
}
