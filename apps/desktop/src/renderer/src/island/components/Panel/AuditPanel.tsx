/**
 * AuditPanel.tsx — 审计面板编排层
 *
 * 左侧：任务历史列表
 * 右侧：选中任务的审计事件流
 * 顶部：导出按钮
 */
import { useEffect } from "react";
import { useIslandStore } from "../../store/islandStore";
import { TaskList } from "./TaskList";
import { AuditEventList } from "./AuditEventList";

export function AuditPanel() {
  const loadTasks = useIslandStore((s) => s.loadTasks);
  const loadAudit = useIslandStore((s) => s.loadAudit);
  const selectedTaskId = useIslandStore((s) => s.selectedTaskId);
  const exportAuditCsv = useIslandStore((s) => s.exportAuditCsv);
  const csvExportResult = useIslandStore((s) => s.csvExportResult);
  const auditLoading = useIslandStore((s) => s.auditLoading);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // 选中任务后自动加载审计事件
  useEffect(() => {
    if (selectedTaskId) void loadAudit(selectedTaskId);
  }, [selectedTaskId, loadAudit]);

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {/* 顶部条 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06]">
        <span className="text-[11px] text-white/40">
          {auditLoading ? "加载中…" : "审计记录"}
        </span>
        <button
          className="island-btn island-btn--ghost text-[10.5px]"
          style={{ height: 26, padding: "0 10px" }}
          onClick={exportAuditCsv}
          data-interactive
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="mr-1.5 inline-block">
            <path d="M8 2v8m0 0l3-3m-3 3L5 7M2.5 12h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          导出 CSV
        </button>
      </div>

      {/* 导出结果提示 */}
      {csvExportResult && (
        <div className="mx-4 mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300 island-fade-up">
          {csvExportResult.ok ? `已导出至 ${csvExportResult.path}` : `导出失败：${csvExportResult.error}`}
        </div>
      )}

      {/* 双栏布局 */}
      <div className="flex flex-1 gap-0 overflow-hidden" style={{ minHeight: 0 }}>
        <div style={{ width: "38%", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
          <TaskList />
        </div>
        <div className="flex-1 overflow-hidden">
          <AuditEventList />
        </div>
      </div>
    </div>
  );
}
