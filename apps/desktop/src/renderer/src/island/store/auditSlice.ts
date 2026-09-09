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
  // BUG-20 修复：请求序号守卫，防止快速切换任务时旧响应覆盖新结果
  let auditReqId = 0;
  let tasksReqId = 0;
  return {
    tasks: [],
    auditEvents: [],
    auditLoading: false,
    auditError: null,
    selectedTaskId: null,
    csvExportResult: null,

    async loadTasks() {
      const myReqId = ++tasksReqId;
      set({ auditLoading: true, auditError: null });
      const res = await window.islandAPI.queryTasks({ limit: 50 });
      if (myReqId !== tasksReqId) return; // 被后续请求取代
      if (res.ok) {
        set({ tasks: res.data, auditLoading: false });
      } else {
        set({ auditError: res.error, auditLoading: false });
      }
    },

    async loadAudit(taskId) {
      const tid = taskId ?? get().selectedTaskId ?? undefined;
      const myReqId = ++auditReqId;
      set({ auditLoading: true, auditError: null });
      const res = await window.islandAPI.queryAudit({ taskId: tid, limit: 500 });
      if (myReqId !== auditReqId) return; // 被后续请求取代
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
      // M02 修复：导出失败时设置错误结果，成功后 5s 自动清理
      const res = await window.islandAPI.exportCsv();
      if (res.ok) {
        set({ csvExportResult: res.data });
        // 5s 后自动清理旧提示
        setTimeout(() => {
          set((s) => s.csvExportResult?.path === res.data.path ? { csvExportResult: null } : {});
        }, 5000);
      } else {
        set({ csvExportResult: { ok: false, path: '', error: res.error } });
      }
    },
  };
}
