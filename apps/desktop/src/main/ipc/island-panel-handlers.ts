/**
 * island-panel-handlers.ts — 面板相关 IPC 处理器（任务/配置/审计）
 *
 * 依赖注入：调用方提供 configStore / auditStore / taskRunner 接口。
 * 镜像/SOP/规则模拟等扩展通道 → island-extended-handlers.ts
 */
import { ipcMain } from "electron";
import {
  ISLAND_CHANNELS,
  StartTaskSchema,
  CancelTaskSchema,
  PauseTaskSchema,
  ResumeTaskSchema,
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
  exportJson(): Promise<ExportCsvResult>;
}

/** 任务运行器接口（主进程实现，连接 orchestrator） */
export interface TaskRunner {
  startTask(goal: string, sopSteps?: string[]): Promise<TaskStartedResult & { queued?: boolean }>;
  cancelTask(taskId: string): Promise<void>;
  pauseTask(taskId: string): boolean;
  resumeTask(taskId: string): boolean;
  getActiveTasks(): { running: { taskId: string; goal: string }[]; queued: { taskId: string; goal: string }[] };
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
      return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid task payload" };
    }
    try {
      const result = await deps.taskRunner.startTask(parsed.data.goal);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "start failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.getActiveTasks, () => {
    try {
      return { ok: true as const, data: deps.taskRunner.getActiveTasks() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "query failed" };
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

  ipcMain.handle(ISLAND_CHANNELS.pauseTask, async (_event, raw: unknown) => {
    const parsed = PauseTaskSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid pause payload" };
    const paused = deps.taskRunner.pauseTask(parsed.data.taskId);
    return paused ? { ok: true } : { ok: false, error: "任务不存在或已结束，无法暂停" };
  });

  ipcMain.handle(ISLAND_CHANNELS.resumeTask, async (_event, raw: unknown) => {
    const parsed = ResumeTaskSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid resume payload" };
    const resumed = deps.taskRunner.resumeTask(parsed.data.taskId);
    return resumed ? { ok: true } : { ok: false, error: "任务不存在或已结束，无法恢复" };
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

  ipcMain.handle(ISLAND_CHANNELS.exportJson, async () => {
    try {
      const result = await deps.auditStore.exportJson();
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "export failed" };
    }
  });
}
