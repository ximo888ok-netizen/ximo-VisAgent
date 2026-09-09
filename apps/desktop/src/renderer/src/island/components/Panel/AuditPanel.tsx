/**
 * AuditPanel.tsx — 审计面板编排层
 *
 * 顶部：统计指标条（成功率/平均步数/总 token/任务数）+ 导出菜单
 * 左侧：任务历史列表；右侧：选中任务的审计事件流
 */
import { useEffect, useMemo, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { TaskList } from "./TaskList";
import { AuditEventList } from "./AuditEventList";
import { StatCard } from "./Audit/StatCard";

export function AuditPanel() {
  const tasks = useIslandStore((s) => s.tasks);
  const loadTasks = useIslandStore((s) => s.loadTasks);
  const loadAudit = useIslandStore((s) => s.loadAudit);
  const selectedTaskId = useIslandStore((s) => s.selectedTaskId);
  const exportAuditCsv = useIslandStore((s) => s.exportAuditCsv);
  const csvExportResult = useIslandStore((s) => s.csvExportResult);
  const auditLoading = useIslandStore((s) => s.auditLoading);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // 选中任务后自动加载审计事件
  useEffect(() => {
    if (selectedTaskId) void loadAudit(selectedTaskId);
  }, [selectedTaskId, loadAudit]);

  // 统计指标（近 50 任务）
  const stats = useMemo(() => {
    const finished = tasks.filter((t) => t.status === "COMPLETED" || t.status === "FAILED");
    const completed = tasks.filter((t) => t.status === "COMPLETED");
    const rate = finished.length > 0 ? Math.round((completed.length / finished.length) * 100) : 0;
    const withSteps = tasks.filter((t) => typeof t.steps === "number");
    const avgSteps = withSteps.length > 0
      ? Math.round(withSteps.reduce((a, t) => a + (t.steps ?? 0), 0) / withSteps.length)
      : 0;
    const totalTokens = tasks.reduce((a, t) => a + (t.tokens ?? 0), 0);
    return { rate, avgSteps, totalTokens, count: tasks.length };
  }, [tasks]);

  const handleExport = async (kind: "csv" | "json") => {
    if (kind === "csv") {
      await exportAuditCsv();
    } else {
      const res = await window.islandAPI.exportJson();
      setExportMsg(res.ok && res.data.ok ? `已导出至 ${res.data.path}` : `导出失败：${res.ok ? res.data.error : res.error}`);
      setTimeout(() => setExportMsg(null), 4000);
    }
  };

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {/* 统计指标条 */}
      <div className="grid grid-cols-4 gap-2 px-4 pt-3">
        <StatCard label="成功率" value={`${stats.rate}%`} accent={stats.rate >= 70 ? "#3fe0a0" : "#fbbf24"} />
        <StatCard label="平均步数" value={String(stats.avgSteps)} />
        <StatCard label="累计 token" value={stats.totalTokens >= 1000 ? `${(stats.totalTokens / 1000).toFixed(1)}k` : String(stats.totalTokens)} />
        <StatCard label="任务总数" value={String(stats.count)} />
      </div>

      {/* 顶部条 */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] t-muted">
          {auditLoading ? "加载中…" : "审计记录（近 50 任务）"}
        </span>
        <div className="flex gap-1.5">
          <button
            className="island-btn island-btn--ghost text-[10.5px]"
            style={{ height: 26, padding: "0 10px" }}
            onClick={() => void handleExport("csv")}
            data-interactive
          >
            导出 CSV
          </button>
          <button
            className="island-btn island-btn--ghost text-[10.5px]"
            style={{ height: 26, padding: "0 10px" }}
            onClick={() => void handleExport("json")}
            data-interactive
          >
            导出 JSON
          </button>
        </div>
      </div>

      {/* 导出结果提示 */}
      {(csvExportResult || exportMsg) && (
        <div className="mx-4 mt-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300 island-fade-up">
          {exportMsg ?? (csvExportResult?.ok ? `已导出至 ${csvExportResult.path}` : `导出失败：${csvExportResult?.error}`)}
        </div>
      )}

      {/* 双栏布局 */}
      <div className="flex flex-1 gap-0 overflow-hidden px-2" style={{ minHeight: 0 }}>
        <div style={{ width: "38%", borderRight: "1px solid var(--ig-line)" }}>
          <TaskList />
        </div>
        <div className="flex-1 overflow-hidden">
          <AuditEventList />
        </div>
      </div>
    </div>
  );
}

