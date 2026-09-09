/**
 * FinishedCard.tsx — 终态卡（结论 + 存为 SOP 模板）
 *
 * 终态 6s 后自动清除；SOP 输入聚焦或已填名称时暂停计时，给用户操作窗口（P1-7）。
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskFinishedPayload } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { statusLabel } from "../../common/labels";

export function FinishedCard({
  finished,
  onError,
}: {
  finished: TaskFinishedPayload;
  onError: (message: string) => void;
}) {
  const clearTask = useIslandStore((s) => s.clearTask);
  const pushToast = useIslandStore((s) => s.pushToast);
  const [sopName, setSopName] = useState("");
  const [sopFocused, setSopFocused] = useState(false);
  const completed = finished.status === "COMPLETED";

  const handleSaveSop = useCallback(async () => {
    // P1-7 修复：终态自动清除后 currentTaskId 为空，回退到终态 payload 中的 taskId
    const taskId = useIslandStore.getState().currentTaskId ?? finished.taskId ?? null;
    if (!taskId) {
      pushToast("error", "任务上下文已清除，无法保存模板");
      return;
    }
    if (!sopName.trim()) return;
    const res = await window.islandAPI.saveSopFromTask({ taskId, name: sopName.trim() });
    if (res.ok) {
      pushToast("success", `模板「${sopName.trim()}」已保存，可在 SOP 面板运行`);
      setSopName("");
    } else {
      onError(res.error);
    }
  }, [sopName, finished.taskId, pushToast, onError]);

  useEffect(() => {
    if (sopFocused || sopName.trim()) return;
    const timer = setTimeout(() => clearTask(), 6000);
    return () => clearTimeout(timer);
  }, [clearTask, sopFocused, sopName]);

  return (
    <div className="mt-3 island-fade-up">
      <div
        className="rounded-2xl rounded-tl-sm px-3.5 py-2.5"
        style={{
          background: completed ? "rgba(63,224,160,0.08)" : "rgba(248,113,113,0.08)",
          border: `1px solid ${completed ? "rgba(63,224,160,0.2)" : "rgba(248,113,113,0.2)"}`,
        }}
      >
        <div className="flex items-center justify-between text-[10px] t-faint mb-1">
          <span style={{ color: completed ? "#3fe0a0" : "#f87171" }}>
            {completed ? "✓ 已完成" : `✕ ${statusLabel(finished.status)}`}
          </span>
          <span>{finished.steps} 步 · {finished.totalTokens} tokens</span>
        </div>
        <div className="text-[12px] leading-snug t-strong">
          {finished.finalAnswer || (completed ? "任务已完成" : "未返回详细结果，可在历史面板查看")}
        </div>
      </div>
      {/* 存为 SOP */}
      <div className="mt-2 flex gap-1.5">
        <input
          className="island-input h-7 flex-1 text-[11px]"
          placeholder="存为 SOP 模板名"
          value={sopName}
          onChange={(e) => setSopName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSaveSop(); }}
          onFocus={() => setSopFocused(true)}
          onBlur={() => setSopFocused(false)}
          data-interactive
        />
        <button
          className="island-btn island-btn--primary h-7 px-3 text-[10.5px]"
          disabled={!sopName.trim()}
          onClick={handleSaveSop}
          data-interactive
        >
          存为模板
        </button>
      </div>
    </div>
  );
}
