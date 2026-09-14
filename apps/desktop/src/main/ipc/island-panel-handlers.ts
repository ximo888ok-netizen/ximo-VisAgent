/**
 * island-panel-handlers.ts — 面板相关 IPC 处理器（任务/配置/审计）
 *
 * 依赖注入：调用方提供 configStore / auditStore / taskRunner 接口。
 * 镜像/SOP/规则模拟等扩展通道 → island-extended-handlers.ts
 */
import { ipcMain } from "electron";
import { existsSync } from "node:fs";
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
  /**
   * app_recent 仓储（规划 §2.5，A-M1 注释指定的 A-M2 接线）：
   * 带 targetApp 的 startTask 成功 = 一次“使用”，记一条最近应用。缺省不记。
   */
  appRecent?: { recordUse(entry: { id: string; name: string; exePath: string }): void };
  /**
   * preauth_grants 仓储（A-M6）：task:start 携带 grantId 时主进程复校三生效条件
   * （acked ∧ active ∧ 未过期），不满足任务不起跑；起跑成功后补绑 task_id。
   * 缺省 = 未装配：任何带 grantId 的请求直接拒绝（fail-closed）。
   */
  preauthGrants?: {
    get(grantId: string): { acked: boolean; status: string; expiresAt: number } | null;
    bindTask(grantId: string, taskId: string): boolean;
  };
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
    // A-M2 预检（规划 §4.1-5）：chip 绑定的 exePath 必须存在，失败任务不起跑，
    // 回传 targetAppMissing 供渲染层把 chip 标红重选。无 chip 路径与现状一致（零回归红线）。
    const { goal, targetApp, grantId } = parsed.data;
    if (targetApp && !existsSync(targetApp.exePath)) {
      return { ok: false as const, error: "目标应用不存在，请重选", targetAppMissing: true as const };
    }
    // A-M6 边界复校（绝不相信渲染层）：带 grantId 起跑的三生效条件缺一即拒起任务
    if (grantId) {
      const grant = deps.preauthGrants?.get(grantId);
      if (!grant || !grant.acked || grant.status !== "active" || grant.expiresAt <= Date.now()) {
        return { ok: false as const, error: "预授权未确认或已失效，任务未起跑" };
      }
    }
    try {
      const result = await deps.taskRunner.startTask(goal);
      if (targetApp) {
        // 最近列表为旁路写入：失败绝不影响已起跑的任务
        try { deps.appRecent?.recordUse({ id: targetApp.id, name: targetApp.name, exePath: targetApp.exePath }); } catch { /* 忽略：app_recent 写失败仅影响推荐组 */ }
      }
      if (grantId) {
        // 绑定同为旁路：绑不上则任务照跑但审批门取不到该 grant（回落逐次询问），必须留痕
        if (!deps.preauthGrants?.bindTask(grantId, result.taskId)) {
          console.warn(`[preauth] grant ${grantId} 未能绑定任务 ${result.taskId}（已绑或不存在），预授权不生效`);
        }
      }
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
