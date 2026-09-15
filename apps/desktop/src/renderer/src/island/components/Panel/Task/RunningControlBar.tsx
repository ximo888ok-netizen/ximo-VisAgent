/**
 * RunningControlBar.tsx — 运行中控制条（状态点 + 成本徽章 + 暂停/继续）
 *
 * A-M7（规划 §4.2）：锚定态经 longtask:status 1s 轮询聚合展示
 * 「已锚定 [icon] 名称 · 进度 x/y · 剩余 时长/步数」；看门狗来源的 PAUSED
 * 显示横幅（原因 + 恢复按钮）。非锚定任务数据面 anchored=false，呈现与旧一致。
 * 取消按钮与排队横幅共用同一个 onCancel 回调，由 TaskPanel 传入。
 */
import { useCallback, useEffect, useState } from "react";
import type { AppEntry, LongTaskStatusPayload } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { AppIcon } from "./AppPicker/AppIcon";

/** 成本徽章：实时 token 累计 */
function CostBadge({ promptTokens, completionTokens }: { promptTokens: number; completionTokens: number }) {
  const total = promptTokens + completionTokens;
  if (total === 0) return null;
  const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return (
    <span
      data-interactive
      className="rounded-full ig-bg-panel-hover px-2 py-0.5 text-[12px] tabular-nums t-muted"
      title={`输入 ${promptTokens} / 输出 ${completionTokens} tokens`}
    >
      {k} tok
    </span>
  );
}

/** 剩余时长人话（3h12m / 45m / 8m12s / <1m） */
function formatDurationLeft(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s > 0 && m < 10 ? `${String(s).padStart(2, "0")}s` : ""}`;
  return totalSec < 60 ? `${s}s` : "<1m";
}

/** 看门狗暂停原因 → 横幅文案（规划 §4.2：原因必须可见，续跑方式按 Q8 自动） */
function pauseReasonText(reason: LongTaskStatusPayload["pauseReason"], appName: string): string {
  if (reason === "app-exited") return `目标应用「${appName}」已退出，任务收口中（进度与断点保留）`;
  return `已离开「${appName}」超时，任务暂停；切回该应用会自动续跑（也可点「继续」强制恢复）`;
}

export function RunningControlBar({ onCancel }: { onCancel: () => void }) {
  const taskPaused = useIslandStore((s) => s.taskPaused);
  const promptTokens = useIslandStore((s) => s.promptTokens);
  const completionTokens = useIslandStore((s) => s.completionTokens);
  const pushToast = useIslandStore((s) => s.pushToast);
  const currentTaskId = useIslandStore((s) => s.currentTaskId);
  const [lt, setLt] = useState<LongTaskStatusPayload | null>(null);

  // §4.4 定案：1s 轮询够用（不做事件推流避免过度工程）；终态/切任务即停表清态
  useEffect(() => {
    if (!currentTaskId) {
      setLt(null);
      return;
    }
    let alive = true;
    const poll = (): void => {
      void window.islandAPI
        .longTaskStatus({ taskId: currentTaskId })
        .then((res) => {
          if (alive && res.ok) setLt(res.data);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [currentTaskId]);

  const handlePauseToggle = useCallback(async () => {
    const taskId = useIslandStore.getState().currentTaskId;
    if (!taskId) return;
    // P1-10 修复：暂停/继续失败时给出反馈，不再静默无响应
    const res = taskPaused
      ? await window.islandAPI.resumeTask(taskId)
      : await window.islandAPI.pauseTask(taskId);
    if (!res.ok) pushToast("error", res.error ?? "操作失败，任务可能已结束");
  }, [taskPaused, pushToast]);

  const anchorApp: AppEntry | null = lt?.anchored && lt.targetApp
    ? {
        id: lt.targetApp.id,
        name: lt.targetApp.name,
        exePath: lt.targetApp.exePath,
        iconRef: lt.targetApp.iconRef,
        source: "recent",
      }
    : null;
  const watchdogPaused = lt?.anchored === true && lt.watchdogState === "PAUSED";
  const anchorName = anchorApp?.name ?? "目标应用";

  const progressText = lt?.anchored
    ? lt.progress
      ? `进度 ${lt.progress.done}${lt.progress.total !== undefined ? `/${lt.progress.total}` : ""} ${lt.progress.unit}`
      : "进度 建立中"
    : null;
  const budgetText = lt?.anchored && (lt.budgetLeft?.durationMs !== undefined || lt.budgetLeft?.steps !== undefined)
    ? [
        lt.budgetLeft?.durationMs !== undefined ? `剩余 ${formatDurationLeft(lt.budgetLeft.durationMs)}` : null,
        lt.budgetLeft?.steps !== undefined ? `${lt.budgetLeft.steps} 步` : null,
      ].filter(Boolean).join("/")
    : null;

  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {/* 锚定态（A-M7 §4.2）：已锚定 [icon] 名称 · 进度 x/y · 剩余 时长/步数 */}
      {anchorApp && (
        <div
          className="island-fade-up flex items-center gap-1.5 rounded-xl ig-bg-panel px-3 py-1.5 text-[12px] t-muted transition-colors duration-150"
          title={lt?.summary ? `断点：${lt.summary}` : undefined}
        >
          <span className="ig-tag ig-tone-info shrink-0 rounded-full px-1.5 py-0.5 text-[11px]">已锚定</span>
          <AppIcon app={anchorApp} size={16} />
          <span className="truncate font-medium t-strong">{anchorApp.name}</span>
          {(progressText || budgetText) && <span className="shrink-0 t-faint">·</span>}
          {progressText && <span className="shrink-0 t-num">{progressText}</span>}
          {budgetText && <span className="shrink-0 t-num">{budgetText}</span>}
          {(lt?.redoCount ?? 0) > 0 && (
            <span className="shrink-0 ig-fg-warning">· {lt?.redoCount} 项工件待重做</span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl ig-bg-panel px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${taskPaused ? "ig-bg-info" : "ig-bg-success island-ring--idle"}`} />
          <span className="truncate text-[12px] t-body">
            {watchdogPaused ? "看门狗暂停" : taskPaused ? "已暂停" : "运行中"}
          </span>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <CostBadge promptTokens={promptTokens} completionTokens={completionTokens} />
          <button className="island-btn island-btn--ghost h-7 px-2.5 text-[12px]" onClick={handlePauseToggle} data-interactive>
            {taskPaused ? "继续" : "暂停"}
          </button>
          <button className="island-btn island-btn--ghost h-7 px-2.5 text-[12px] hover:ig-fg-danger" onClick={onCancel} data-interactive>
            取消
          </button>
        </div>
      </div>

      {/* PAUSED（看门狗来源）横幅：温和提示原因 + 恢复按钮（手动暂停仍走上方原语） */}
      {watchdogPaused && (
        <div className="island-fade-up flex items-center gap-2.5 rounded-xl ig-alert ig-tone-warning px-3 py-2.5">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full ig-bg-warning island-ring--idle" />
          <div className="min-w-0 flex-1 text-[12px] leading-snug ig-fg-warning">
            {pauseReasonText(lt?.pauseReason, anchorName)}
          </div>
          <button
            className="island-btn island-btn--ghost h-7 shrink-0 px-2.5 text-[12px]"
            data-interactive
            onClick={() => {
              void (async () => {
                const taskId = useIslandStore.getState().currentTaskId;
                if (!taskId) return;
                const res = await window.islandAPI.resumeTask(taskId);
                if (!res.ok) pushToast("error", res.error ?? "恢复失败，任务可能已结束");
              })();
            }}
          >
            继续
          </button>
        </div>
      )}
    </div>
  );
}
