/**
 * auditSlice.ts — 审计查询状态 slice
 */
import type {
  TaskRowPayload,
  AuditRowPayload,
  ExportCsvResult,
} from "@shared/island-contracts";

export interface AuditSliceState {
  tasks: TaskRowPayload[];
  auditEvents: AuditRowPayload[];
  auditLoading: boolean;
  auditError: string | null;
  selectedTaskId: string | null;
  csvExportResult: ExportCsvResult | null;
  loadTasks(): Promise<void>;
  loadAudit(taskId?: string): Promise<void>;
  selectTask(taskId: string | null): void;
  exportAuditCsv(): Promise<void>;
}

export function createAuditSlice(
  set: (fn: Partial<AuditSliceState> | ((s: AuditSliceState) => Partial<AuditSliceState>)) => void,
  get: () => AuditSliceState,
): AuditSliceState {
  return {
    tasks: [],
    auditEvents: [],
    auditLoading: false,
    auditError: null,
    selectedTaskId: null,
    csvExportResult: null,

    async loadTasks() {
      set({ auditLoading: true, auditError: null });
      const res = await window.islandAPI.queryTasks({ limit: 50 });
      if (res.ok) {
        set({ tasks: res.data, auditLoading: false });
      } else {
        set({ auditError: res.error, auditLoading: false });
      }
    },

    async loadAudit(taskId) {
      const tid = taskId ?? get().selectedTaskId ?? undefined;
      set({ auditLoading: true, auditError: null });
      const res = await window.islandAPI.queryAudit({ taskId: tid, limit: 500 });
      if (res.ok) {
        set({ auditEvents: res.data, auditLoading: false });
      } else {
        set({ auditError: res.error, auditLoading: false });
      }
    },

    selectTask(taskId) {
      set({ selectedTaskId: taskId });
    },

    async exportAuditCsv() {
      const res = await window.islandAPI.exportCsv();
      if (res.ok) {
        set({ csvExportResult: res.data });
      }
    },
  };
}
