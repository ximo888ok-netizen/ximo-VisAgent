/**
 * island-employee-handlers.ts — 员工域 IPC（岗位 / 事实卡 / 入职报告）
 *
 * 全部 payload 主进程侧 Zod 复校，统一 { ok, data | error } 返回。
 * 岗位身份/职责/边界的修改走宪法门提案（M2 接线），本文件只做 CRUD 读写。
 */
import { ipcMain } from "electron";
import {
  ISLAND_CHANNELS,
  CreatePositionSchema,
  UpdatePositionSchema,
  SearchFactCardsSchema,
} from "../../shared/island-contracts";
import { makeClients } from "../orchestrator-clients";
import type {
  PositionRowPayload,
  FactCardRowPayload,
  OnboardingReportRowPayload,
  SearchFactCardsResult,
} from "../../shared/island-contracts";
import type { EmployeeStore } from "../stores/employee-store";
import type { ZODB } from "../audit-store";
import type { Store } from "../config-store";
import { runOnboarding } from "../onboarding";
import { getIslandWindow } from "../windows/island";

export interface EmployeeDeps {
  employee: EmployeeStore;
  audit: ZODB;
  store: Store;
}

let empRegistered = false;

export function registerEmployeeHandlers(deps: EmployeeDeps): void {
  if (empRegistered) return;
  empRegistered = true;

  // ---- 岗位列表 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeListPositions, () => {
    try {
      const rows = deps.employee.listPositions() as PositionRowPayload[];
      return { ok: true as const, data: rows };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "list failed" };
    }
  });

  // ---- 获取单个岗位 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeGetPosition, (_e, raw: unknown) => {
    const id = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!id) return { ok: false as const, error: "invalid id" };
    try {
      const row = deps.employee.getPosition(id);
      return row ? { ok: true as const, data: row as PositionRowPayload } : { ok: false as const, error: "岗位不存在" };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "get failed" };
    }
  });

  // ---- 创建岗位 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeCreatePosition, (_e, raw: unknown) => {
    const parsed = CreatePositionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid payload" };
    try {
      const d = parsed.data;
      const id = `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      deps.employee.insertPosition({
        id,
        name: d.name,
        roleProfile: d.roleProfile ?? '',
        reportTo: d.reportTo ?? '',
        tone: d.tone ?? '',
        dutyScopeJson: JSON.stringify(d.dutyScope),
        dutyBoundaryJson: JSON.stringify(d.dutyBoundary),
        goalsJson: JSON.stringify(d.goals),
        knowledgeJson: JSON.stringify(d.knowledge),
        routineJson: JSON.stringify(d.routine),
        status: 'draft',
      });
      return { ok: true as const, data: { id } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "create failed" };
    }
  });

  // ---- 更新岗位（M2 接线后身份/职责/边界走宪法门，此处先做直接更新）----
  ipcMain.handle(ISLAND_CHANNELS.employeeUpdatePosition, (_e, raw: unknown) => {
    // raw 期望 { id, ...updates }
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj.id !== 'string') return { ok: false as const, error: "invalid id" };
    const { id, ...rest } = obj;
    const parsed = UpdatePositionSchema.safeParse(rest);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid payload" };
    try {
      const d = parsed.data;
      const updates: Record<string, string> = {};
      if (d.name !== undefined) updates.name = d.name;
      if (d.roleProfile !== undefined) updates.roleProfile = d.roleProfile;
      if (d.reportTo !== undefined) updates.reportTo = d.reportTo;
      if (d.tone !== undefined) updates.tone = d.tone;
      if (d.dutyScope !== undefined) updates.dutyScopeJson = JSON.stringify(d.dutyScope);
      if (d.dutyBoundary !== undefined) updates.dutyBoundaryJson = JSON.stringify(d.dutyBoundary);
      if (d.goals !== undefined) updates.goalsJson = JSON.stringify(d.goals);
      if (d.knowledge !== undefined) updates.knowledgeJson = JSON.stringify(d.knowledge);
      if (d.routine !== undefined) updates.routineJson = JSON.stringify(d.routine);
      if (Object.keys(updates).length === 0) return { ok: false as const, error: "无更新字段" };
      deps.employee.updatePosition(id, updates);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "update failed" };
    }
  });

  // ---- 删除岗位 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeDeletePosition, (_e, raw: unknown) => {
    const id = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!id) return { ok: false as const, error: "invalid id" };
    try {
      return deps.employee.deletePosition(id) ? { ok: true as const } : { ok: false as const, error: "岗位不存在" };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "delete failed" };
    }
  });

  // ---- 搜索事实卡 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeSearchFactCards, (_e, raw: unknown) => {
    const parsed = SearchFactCardsSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    try {
      const items = parsed.data.query
        ? deps.employee.searchFactCards(parsed.data.query, parsed.data.positionId, parsed.data.topic, parsed.data.limit ?? 20)
        : deps.employee.listFactCards(parsed.data.positionId);
      return { ok: true as const, data: { items: items as FactCardRowPayload[] } as SearchFactCardsResult };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "search failed" };
    }
  });

  // ---- 入职报告列表 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeListReports, (_e, raw: unknown) => {
    const positionId = typeof raw === 'string' ? raw : undefined;
    try {
      const rows = deps.employee.listReports(positionId) as OnboardingReportRowPayload[];
      return { ok: true as const, data: rows };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "list failed" };
    }
  });

  // ---- 获取入职报告 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeGetReport, (_e, raw: unknown) => {
    const id = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!id) return { ok: false as const, error: "invalid id" };
    try {
      const row = deps.employee.getReport(id);
      return row ? { ok: true as const, data: row as OnboardingReportRowPayload } : { ok: false as const, error: "报告不存在" };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "get failed" };
    }
  });

  // ---- 保存/更新入职报告 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeSaveReport, (_e, raw: unknown) => {
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj.id !== 'string' || typeof obj.positionId !== 'string') {
      return { ok: false as const, error: "invalid payload" };
    }
    try {
      deps.employee.upsertReport({
        id: obj.id,
        positionId: obj.positionId,
        reportJson: typeof obj.reportJson === 'string' ? obj.reportJson : '{}',
        questionsJson: typeof obj.questionsJson === 'string' ? obj.questionsJson : '[]',
        lastCursorJson: typeof obj.lastCursorJson === 'string' ? obj.lastCursorJson : '{}',
        coverage: typeof obj.coverage === 'number' ? obj.coverage : 0,
        status: typeof obj.status === 'string' ? obj.status as OnboardingReportRowPayload['status'] : 'in_progress',
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  // ---- 确认入职报告（事实卡转正 + 岗位状态迁移）----
  ipcMain.handle(ISLAND_CHANNELS.employeeConfirmReport, (_e, raw: unknown) => {
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj.id !== 'string' || typeof obj.positionId !== 'string') {
      return { ok: false as const, error: "invalid payload" };
    }
    try {
      // 1. 报告标记 confirmed
      deps.employee.updateReportStatus(obj.id, 'confirmed');
      // 2. 事实卡批量转正
      const confirmed = deps.employee.confirmFactCards(obj.positionId);
      // 3. 岗位状态迁移 onboarding → active（降权类变更，即时执行 + 留痕）
      deps.employee.updatePosition(obj.positionId, { status: 'active' });
      return { ok: true as const, data: { confirmed } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "confirm failed" };
    }
  });

  // ---- 启动入职流程 ----
  ipcMain.handle(ISLAND_CHANNELS.employeeStartOnboarding, async (_e, raw: unknown) => {
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj.positionId !== 'string') {
      return { ok: false as const, error: "invalid payload" };
    }
    try {
      const positionId = obj.positionId as string;
      // 岗位状态迁移 draft → onboarding
      deps.employee.updatePosition(positionId, { status: 'onboarding' });

      const appCfg = deps.store.get();
      const { text: llm } = makeClients(appCfg.agent);

      // 异步执行入职流程（不阻塞 IPC）
      const islandWin = getIslandWindow();
      const sendProgress = (stage: string, detail: string) => {
        try {
          if (islandWin && !islandWin.isDestroyed()) {
            islandWin.webContents.send(ISLAND_CHANNELS.employeeOnboardingProgress, { stage, detail });
          }
        } catch { /* 窗口可能已销毁 */ }
      };

      void runOnboarding({
        positionId,
        llm,
        employee: deps.employee,
        audit: deps.audit,
        workspaceDir: appCfg.workspaceDir,
        skipCodebase: obj.skipCodebase === true,
        onProgress: sendProgress,
      }).then((result) => {
        sendProgress('complete', JSON.stringify(result));
      }).catch((err) => {
        sendProgress('error', err instanceof Error ? err.message : String(err));
      });

      return { ok: true as const, data: { positionId } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "onboarding failed" };
    }
  });

  // ---- M4: 资料失效检测 ----
  ipcMain.handle('island:employee-detect-stale', async (_e, raw: unknown) => {
    const positionId = typeof raw === 'string' ? raw : undefined;
    try {
      const stale = deps.employee.detectStaleFactCards(positionId);
      return { ok: true as const, data: { stale } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "detect failed" };
    }
  });

  // ---- M4: FTS5 全文检索事实卡 ----
  ipcMain.handle('island:employee-fts-search', async (_e, raw: unknown) => {
    const obj = raw as Record<string, unknown> | null;
    const query = typeof obj?.query === 'string' ? obj.query : '';
    const positionId = typeof obj?.positionId === 'string' ? obj.positionId : undefined;
    if (!query) return { ok: false as const, error: "query is required" };
    try {
      const items = deps.employee.searchFactCardsFTS(query, positionId);
      return { ok: true as const, data: { items } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "search failed" };
    }
  });
}
