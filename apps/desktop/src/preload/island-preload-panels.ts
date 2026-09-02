/**
 * island-preload-panels.ts — 面板相关 IPC 绑定（任务/配置/审计）
 *
 * 从 island-preload.ts 拆分，避免单文件超限。
 * 只负责 ipcRenderer.invoke / send 的封装，不做任何权限判断。
 */
import type { IpcResult } from "../shared/island-api";
import type {
  StartTaskRequest,
  TaskStartedResult,
  AppConfigPayload,
  UpdateConfigRequest,
  QueryTasksRequest,
  TaskRowPayload,
  QueryAuditRequest,
  AuditRowPayload,
  ExportCsvResult,
} from "../shared/island-contracts";
import { ISLAND_CHANNELS } from "../shared/island-contracts";

type SafeInvoke = <T>(
  channel: string,
  arg?: unknown,
) => Promise<IpcResult<T>>;

export type PanelApiMethods = {
  startTask: (req: StartTaskRequest) => Promise<IpcResult<TaskStartedResult>>;
  cancelTask: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  getConfig: () => Promise<IpcResult<AppConfigPayload>>;
  updateConfig: (req: UpdateConfigRequest) => Promise<{ ok: boolean; error?: string }>;
  queryTasks: (req?: QueryTasksRequest) => Promise<IpcResult<TaskRowPayload[]>>;
  queryAudit: (req?: QueryAuditRequest) => Promise<IpcResult<AuditRowPayload[]>>;
  exportCsv: () => Promise<IpcResult<ExportCsvResult>>;
};

export function registerPanelApi(
  safeInvoke: SafeInvoke,
  ipc: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> },
): PanelApiMethods {
  return {
    async startTask(req) {
      return safeInvoke<TaskStartedResult>(ISLAND_CHANNELS.startTask, req);
    },

    async cancelTask(taskId) {
      return (await ipc.invoke(
        ISLAND_CHANNELS.cancelTask,
        { taskId },
      )) as { ok: boolean; error?: string };
    },

    async getConfig() {
      return safeInvoke<AppConfigPayload>(ISLAND_CHANNELS.getConfig);
    },

    async updateConfig(req) {
      return (await ipc.invoke(
        ISLAND_CHANNELS.updateConfig,
        req,
      )) as { ok: boolean; error?: string };
    },

    async queryTasks(req) {
      return safeInvoke<TaskRowPayload[]>(ISLAND_CHANNELS.queryTasks, req ?? {});
    },

    async queryAudit(req) {
      return safeInvoke<AuditRowPayload[]>(ISLAND_CHANNELS.queryAudit, req ?? {});
    },

    async exportCsv() {
      return safeInvoke<ExportCsvResult>(ISLAND_CHANNELS.exportCsv);
    },
  };
}
