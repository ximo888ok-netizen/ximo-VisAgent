/**
 * StatsPanel.tsx — 任务统计（成功率/失败归因/人工干预/成本）
 */
import { useEffect } from "react";
import { useIslandStore } from "../../store/islandStore";
import { TASK_STATUS_LABEL } from "../common/labels";
import { TASK_STATUS_COLOR } from "../common/colors";

const FAILURE_KIND_LABEL: Record<string, string> = {
  TIMEOUT: "超时",
  MAX_STEPS: "超步数",
  LLM_ERROR: "模型调用失败",
  APPROVAL_REJECTED: "审批拒绝",
  APPROVAL_HANG: "审批挂起",
  LOCATE_FAILED: "界面定位失败",
  USER_CANCELLED: "用户取消",
  EMERGENCY_STOP: "急停",
  INTERNAL_ERROR: "内部错误",
  UNKNOWN: "未知",
};

export function StatsPanel() {
  const stats = useIslandStore((s) => s.stats);
  const statsLoading = useIslandStore((s) => s.statsLoading);
  const statsError = useIslandStore((s) => s.statsError);
  const statsDays = useIslandStore((s) => s.statsDays);
  const loadStats = useIslandStore((s) => s.loadStats);
  const setStatsDays = useIslandStore((s) => s.setStatsDays);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const pickDays = (d: number) => {
    setStatsDays(d);
    void loadStats(d);
  };

  return (
    <div className="flex h-full flex-col px-4 py-3">
      {/* 时间范围筛选 */}
      <div className="mb-3 flex items-center gap-1">
        <span className="text-[11px] t-strong font-medium">任务统计</span>
        <div className="ml-auto flex gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              data-interactive
              className={`rounded-full px-2.5 py-1 text-[10.5px] transition ${statsDays === d ? "ig-bg-panel-hover t-strong" : "t-muted hover:t-body"}`}
              onClick={() => pickDays(d)}
            >
              {d === 7 ? "近 7 天" : d === 30 ? "近 30 天" : "近 90 天"}
            </button>
          ))}
        </div>
      </div>

      <div className="island-panel-scroll min-h-0 flex-1 space-y-2.5 pr-1">
        {statsLoading && !stats && (
          <>
            <div className="island-skeleton h-20 rounded-xl ig-bg-panel" />
            <div className="island-skeleton h-32 rounded-xl ig-bg-panel" />
          </>
        )}
        {statsError && !stats && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="text-[11px] text-red-300">统计加载失败：{statsError}</span>
            <button data-interactive className="island-btn island-btn--ghost text-[10.5px]" onClick={() => void loadStats()}>重试</button>
          </div>
        )}
        {stats && (
          <>
            {/* 概览卡 */}
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="成功率" value={`${Math.round(stats.successRate * 100)}%`} ratio={stats.successRate} good />
              <StatCard label="任务总数" value={String(stats.totalTasks)} sub={`${stats.days} 天内`} />
              <StatCard label="人工干预" value={String(stats.interventions)} sub="审批决定次数" />
              <StatCard label="平均成本" value={stats.avgTokens >= 1000 ? `${(stats.avgTokens / 1000).toFixed(1)}k` : String(stats.avgTokens)} sub="tokens / 任务" />
            </div>

            {/* 结果分布 */}
            <div className="rounded-xl ig-bg-panel px-3 py-2.5">
              <div className="mb-1.5 text-[11px] t-strong font-medium">结果分布</div>
              <div className="flex h-2.5 overflow-hidden rounded-full">
                <Bar status="COMPLETED" value={stats.completed} total={stats.totalTasks} />
                <Bar status="FAILED" value={stats.failed} total={stats.totalTasks} />
                <Bar status="CANCELLED" value={stats.cancelled} total={stats.totalTasks} />
                <Bar status="INTERRUPTED" value={stats.interrupted} total={stats.totalTasks} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"] as const).map((k) => (
                  <span key={k} className="flex items-center gap-1 text-[9.5px] t-muted">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: BAR_COLOR[k] }} />
                    {TASK_STATUS_LABEL[k]} {countOf(stats, k)}
                  </span>
                ))}
              </div>
            </div>

            {/* 失败归因 */}
            <div className="rounded-xl ig-bg-panel px-3 py-2.5">
              <div className="mb-2 text-[11px] t-strong font-medium">失败归因</div>
              {stats.failureKinds.length === 0 ? (
                <div className="py-2 text-center text-[10.5px] t-faint">期间无失败任务 🎉</div>
              ) : (
                <div className="space-y-1.5">
                  {stats.failureKinds.map((f) => (
                    <div key={f.kind} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 truncate text-[10px] t-muted" title={f.kind}>
                        {FAILURE_KIND_LABEL[f.kind] ?? f.kind}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full ig-bg-panel-hover">
                        <div
                          className="h-full rounded-full bg-red-400/70"
                          style={{ width: `${Math.max(4, (f.count / (stats.failureKinds[0]?.count ?? 1)) * 100)}%` }}
                        />
                      </div>
                      <span className="w-6 shrink-0 text-right text-[10px] tabular-nums t-muted">{f.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pb-1 text-center text-[9.5px] t-faint">
              累计消耗 {stats.totalTokens >= 1000 ? `${(stats.totalTokens / 1000).toFixed(1)}k` : stats.totalTokens} tokens
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const BAR_COLOR = TASK_STATUS_COLOR;

function countOf(stats: { completed: number; failed: number; cancelled: number; interrupted: number }, k: string): number {
  if (k === "COMPLETED") return stats.completed;
  if (k === "FAILED") return stats.failed;
  if (k === "CANCELLED") return stats.cancelled;
  return stats.interrupted;
}

function Bar({ status, value, total }: { status: string; value: number; total: number }) {
  if (value <= 0 || total <= 0) return null;
  return <div style={{ width: `${(value / total) * 100}%`, background: BAR_COLOR[status] }} />;
}

function StatCard({ label, value, sub, ratio, good }: { label: string; value: string; sub?: string; ratio?: number; good?: boolean }) {
  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5">
      <div className="text-[9.5px] t-faint">{label}</div>
      <div
        className="mt-0.5 text-[17px] font-semibold tabular-nums"
        style={{ color: good && ratio !== undefined ? (ratio >= 0.8 ? "#3fe0a0" : ratio >= 0.5 ? "#fbbf24" : "#f87171") : undefined }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[9px] t-faint">{sub}</div>}
    </div>
  );
}
