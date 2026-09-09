/**
 * panels/task.ts — 任务域 preload 绑定（提交/取消/暂停恢复/快照/断点续跑/会话/步骤事件）
 *
 * 方法签名一律取 IslandApi 的对应切片：preload 与渲染层契约同源，不再手抄（I2）。
 */
import type { IslandApi } from "../../shared/island-api";
import {
  ISLAND_CHANNELS,
  StepDetailEventSchema,
  UsageEventSchema,
} from "../../shared/island-contracts";
import type {
  ActiveTasksPayload,
  ConversationInfoPayload,
  InterruptedTaskInfo,
  TaskStartedResult,
} from "../../shared/island-contracts";
import { invokeOk, onValidated, type PanelIpc, type SafeInvoke } from "./deps";

export type TaskPanelApi = Pick<
  IslandApi,
  | "startTask"
  | "cancelTask"
  | "pauseTask"
  | "resumeTask"
  | "getActiveTasks"
  | "resumeInterrupted"
  | "listInterrupted"
  | "conversationInfo"
  | "conversationClear"
  | "onStepDetail"
  | "onUsage"
  | "onFocusQuickInput"
>;

export function registerTaskApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): TaskPanelApi {
  return {
    async startTask(req) {
      return safeInvoke<TaskStartedResult>(ISLAND_CHANNELS.startTask, req);
    },

    async cancelTask(taskId) {
      return invokeOk(ipc, ISLAND_CHANNELS.cancelTask, { taskId });
    },

    async pauseTask(taskId) {
      return invokeOk(ipc, ISLAND_CHANNELS.pauseTask, { taskId });
    },

    async resumeTask(taskId) {
      return invokeOk(ipc, ISLAND_CHANNELS.resumeTask, { taskId });
    },

    async getActiveTasks() {
      return safeInvoke<ActiveTasksPayload>(ISLAND_CHANNELS.getActiveTasks);
    },

    async resumeInterrupted(req) {
      return safeInvoke<TaskStartedResult>(ISLAND_CHANNELS.resumeInterrupted, req);
    },

    async listInterrupted() {
      return safeInvoke<InterruptedTaskInfo[]>(ISLAND_CHANNELS.listInterrupted);
    },

    async conversationInfo() {
      return safeInvoke<ConversationInfoPayload>(ISLAND_CHANNELS.conversationInfo);
    },

    async conversationClear() {
      return invokeOk(ipc, ISLAND_CHANNELS.conversationClear);
    },

    onStepDetail(cb) {
      return onValidated(ipc, ISLAND_CHANNELS.stepDetail, StepDetailEventSchema, cb);
    },

    onUsage(cb) {
      return onValidated(ipc, ISLAND_CHANNELS.usage, UsageEventSchema, cb);
    },

    onFocusQuickInput(cb) {
      const listener = (): void => cb();
      ipc.on(ISLAND_CHANNELS.focusQuickInput, listener);
      return () => ipc.removeListener(ISLAND_CHANNELS.focusQuickInput, listener);
    },
  };
}
