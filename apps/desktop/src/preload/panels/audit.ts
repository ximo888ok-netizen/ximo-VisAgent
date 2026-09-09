/**
 * panels/audit.ts — 审计域 preload 绑定（任务列表 / 审计事件 / 导出）
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  AuditRowPayload,
  ExportCsvResult,
  TaskRowPayload,
} from "../../shared/island-contracts";
import type { SafeInvoke } from "./deps";

export type AuditPanelApi = Pick<
  IslandApi,
  "queryTasks" | "queryAudit" | "exportCsv" | "exportJson"
>;

export function registerAuditApi(safeInvoke: SafeInvoke): AuditPanelApi {
  return {
    async queryTasks(req) {
      return safeInvoke<TaskRowPayload[]>(ISLAND_CHANNELS.queryTasks, req ?? {});
    },

    async queryAudit(req) {
      return safeInvoke<AuditRowPayload[]>(ISLAND_CHANNELS.queryAudit, req ?? {});
    },

    async exportCsv() {
      return safeInvoke<ExportCsvResult>(ISLAND_CHANNELS.exportCsv);
    },

    async exportJson() {
      return safeInvoke<ExportCsvResult>(ISLAND_CHANNELS.exportJson);
    },
  };
}
