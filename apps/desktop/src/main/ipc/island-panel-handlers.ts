/**
 * island-panel-handlers.ts — 面板相关 IPC 处理器（任务/配置/审计）
 *
 * 从 island.handlers.ts 拆分。
 * 依赖注入：调用方提供 configStore / auditStore / taskRunner 接口。
 */
import { ipcMain } from "electron";
import {
  ISLAND_CHANNELS,
  StartTaskSchema,
  CancelTaskSchema,
  UpdateConfigSchema,
  QueryTasksSchema,
  QueryAuditSchema,
} from "../../shared/island-contracts";
import type {
  AppConfigPayload,
  UpdateConfigRequest,
  TaskRowPayload,
  AuditRowPayload,
  ExportCsvResult,
  TaskStartedResult,
  TaskFinishedPayload,
} from "../../shared/island-contracts";

/** 配置存储接口（主进程实现） */
export interface ConfigStore {
  getConfig(): Promise<AppConfigPayload>;
  updateConfig(req: UpdateConfigRequest): Promise<void>;
}

/** 审计存储接口（主进程实现） */
export interface AuditStore {
  queryTasks(limit?: number): Promise<TaskRowPayload[]>;
  queryAudit(taskId?: string, limit?: number): Promise<AuditRowPayload[]>;
  exportCsv(): Promise<ExportCsvResult>;
}

/** 任务运行器接口（主进程实现，连接 orchestrator） */
export interface TaskRunner {
  startTask(goal: string): Promise<TaskStartedResult>;
  cancelTask(taskId: string): Promise<void>;
  /** 任务终态推送（通过 webContents.send 发送 island:task-finished） */
  onTaskFinished(cb: (payload: TaskFinishedPayload) => void): void;
}

export interface PanelDeps {
  configStore: ConfigStore;
  auditStore: AuditStore;
  taskRunner: TaskRunner;
}

let panelRegistered = false;

export function registerPanelHandlers(deps: PanelDeps): void {
  if (panelRegistered) return;
  panelRegistered = true;

  // ---- 任务 ----
  ipcMain.handle(ISLAND_CHANNELS.startTask, async (_event, raw: unknown) => {
    const parsed = StartTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid task payload" };
    }
    try {
      const result = await deps.taskRunner.startTask(parsed.data.goal);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "start failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.cancelTask, async (_event, raw: unknown) => {
    const parsed = CancelTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid cancel payload" };
    }
    try {
      await deps.taskRunner.cancelTask(parsed.data.taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "cancel failed" };
    }
  });

  // ---- 配置 ----
  ipcMain.handle(ISLAND_CHANNELS.getConfig, async () => {
    try {
      const config = await deps.configStore.getConfig();
      return { ok: true, data: config };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "get config failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.updateConfig, async (_event, raw: unknown) => {
    const parsed = UpdateConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid config payload" };
    }
    try {
      await deps.configStore.updateConfig(parsed.data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "update failed" };
    }
  });

  // ---- 审计 ----
  ipcMain.handle(ISLAND_CHANNELS.queryTasks, async (_event, raw: unknown) => {
    const parsed = QueryTasksSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, error: "invalid query-tasks payload" };
    }
    try {
      const tasks = await deps.auditStore.queryTasks(parsed.data.limit);
      return { ok: true, data: tasks };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "query failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.queryAudit, async (_event, raw: unknown) => {
    const parsed = QueryAuditSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, error: "invalid query-audit payload" };
    }
    try {
      const events = await deps.auditStore.queryAudit(parsed.data.taskId, parsed.data.limit);
      return { ok: true, data: events };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "query failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.exportCsv, async () => {
    try {
      const result = await deps.auditStore.exportCsv();
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "export failed" };
    }
  });
}
