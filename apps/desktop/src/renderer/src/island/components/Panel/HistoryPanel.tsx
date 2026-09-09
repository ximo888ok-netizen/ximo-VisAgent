/**
 * HistoryPanel.tsx — 任务历史列表（状态/耗时/成本/失败归因）
 * 点击任务 → pushView(taskDetail)；「回放」→ pushView(replay)
 */
import { useEffect, useMemo, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { statusLabel } from "../common/labels";
import { STATUS_COLOR_FALLBACK, TASK_STATUS_COLOR } from "../common/colors";

const STATUS_COLOR = TASK_STATUS_COLOR;

export function HistoryPanel() {
  const tasks = useIslandStore((s) => s.tasks);
  const loadTasks = useIslandStore((s) => s.loadTasks);
  const auditError = useIslandStore((s) => s.auditError);
  const pushView = useIslandStore((s) => s.pushView);
  const [filter, setFilter] = useState<"all" | "COMPLETED" | "FAILED">("all");
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    void loadTasks().finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTasks]);

  const filtered = useMemo(
    () => filter === "all" ? tasks : tasks.filter((t) => t.status === filter),
    [tasks, filter],
  );

  return (
    <div className="flex h-full flex-col px-4 py-3">
      {/* 筛选 */}
      <div className="mb-2 flex items-center gap-1">
        {([["all", "全部"], ["COMPLETED", "完成"], ["FAILED", "失败"]] as const).map(([key, label]) => (
          <button
            key={key}
            data-interactive
            className={`rounded-full px-2.5 py-1 text-[10.5px] transition ${
              filter === key ? "ig-bg-panel-hover t-strong" : "t-muted hover:t-body"
            }`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <button
          data-interactive
          className="ml-auto text-[10.5px] t-muted hover:t-body"
          onClick={refresh}
        >
          刷新
        </button>
      </div>

      {/* 列表 */}
      <div className="island-panel-scroll min-h-0 flex-1 space-y-1.5 pr-1">
        {/* C：首次加载骨架 */}
        {loading && tasks.length === 0 && (
          <>
            <div className="island-skeleton h-14 rounded-lg ig-bg-panel" />
            <div className="island-skeleton h-14 rounded-lg ig-bg-panel" />
            <div className="island-skeleton h-14 rounded-lg ig-bg-panel" />
          </>
        )}
        {/* P2-13 修复：加载失败与空态区分，失败提供重试入口 */}
        {!loading && auditError && (
          <div className="flex h-24 flex-col items-center justify-center gap-2">
            <span className="text-[11px] text-red-300">历史记录加载失败：{auditError}</span>
            <button data-interactive className="island-btn island-btn--ghost text-[10.5px]" onClick={refresh}>
              重试
            </button>
          </div>
        )}
        {!loading && !auditError && filtered.length === 0 && (
          <div className="flex h-24 items-center justify-center text-[11px] t-faint">暂无任务记录</div>
        )}
        {filtered.map((t) => {
          const color = STATUS_COLOR[t.status] ?? STATUS_COLOR_FALLBACK;
          return (
            <div
              key={t.taskId}
              data-interactive
              className="group rounded-lg ig-bg-panel px-3 py-2 transition hover:ig-bg-panel"
            >
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] t-strong" title={`${statusLabel(t.status)} · ${t.goal}`}>{t.goal}</span>
                <span className="shrink-0 text-[9.5px] tabular-nums t-faint">
                  {t.steps !== null && t.steps !== undefined ? `${t.steps}步` : ""}
                  {t.tokens ? ` · ${(t.tokens / 1000).toFixed(1)}k` : ""}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[9.5px] t-faint">
                  {new Date(t.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  {t.failureKind && t.status !== "COMPLETED" && ` · ${t.failureKind}`}
                </span>
                <span className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    className="rounded-md ig-bg-panel-hover px-2 py-0.5 text-[9.5px] t-body hover:ig-bg-panel-hover"
                    onClick={() => pushView({ kind: "taskDetail", taskId: t.taskId })}
                  >
                    详情
                  </button>
                  <button
                    className="rounded-md ig-bg-panel-hover px-2 py-0.5 text-[9.5px] t-body hover:ig-bg-panel-hover"
                    onClick={() => pushView({ kind: "replay", taskId: t.taskId })}
                  >
                    回放
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
