/**
 * RunningControlBar.tsx — 运行中控制条（状态点 + 成本徽章 + 暂停/继续）
 *
 * 取消按钮与排队横幅共用同一个 onCancel 回调，由 TaskPanel 传入。
 */
import { useCallback } from "react";
import { useIslandStore } from "../../../store/islandStore";

/** 成本徽章：实时 token 累计 */
function CostBadge({ promptTokens, completionTokens }: { promptTokens: number; completionTokens: number }) {
  const total = promptTokens + completionTokens;
  if (total === 0) return null;
  const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return (
    <span
      data-interactive
      className="rounded-full ig-bg-panel-hover px-2 py-0.5 text-[10px] tabular-nums t-muted"
      title={`输入 ${promptTokens} / 输出 ${completionTokens} tokens`}
    >
      {k} tok
    </span>
  );
}

export function RunningControlBar({ onCancel }: { onCancel: () => void }) {
  const taskPaused = useIslandStore((s) => s.taskPaused);
  const promptTokens = useIslandStore((s) => s.promptTokens);
  const completionTokens = useIslandStore((s) => s.completionTokens);
  const pushToast = useIslandStore((s) => s.pushToast);

  const handlePauseToggle = useCallback(async () => {
    const taskId = useIslandStore.getState().currentTaskId;
    if (!taskId) return;
    // P1-10 修复：暂停/继续失败时给出反馈，不再静默无响应
    const res = taskPaused
      ? await window.islandAPI.resumeTask(taskId)
      : await window.islandAPI.pauseTask(taskId);
    if (!res.ok) pushToast("error", res.error ?? "操作失败，任务可能已结束");
  }, [taskPaused, pushToast]);

  return (
    <div className="mb-3 flex items-center justify-between rounded-lg ig-bg-panel px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${taskPaused ? "bg-blue-400" : "bg-emerald-400 island-ring--thinking"}`} />
        <span className="truncate text-[11px] t-body">
          {taskPaused ? "已暂停" : "运行中"}
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <CostBadge promptTokens={promptTokens} completionTokens={completionTokens} />
        <button className="island-btn island-btn--ghost px-2.5 text-[10.5px]" onClick={handlePauseToggle} data-interactive>
          {taskPaused ? "继续" : "暂停"}
        </button>
        <button className="island-btn island-btn--ghost px-2.5 text-[10.5px]" onClick={onCancel} data-interactive>
          取消
        </button>
      </div>
    </div>
  );
}
