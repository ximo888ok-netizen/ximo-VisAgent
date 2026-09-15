/**
 * FinishedCard.tsx — 终态收口卡（结论 + 触发闸 + 未完成清单 + 存为 SOP + 转长期任务）
 *
 * A-M7（规划 §4.2）：收口卡显示触发闸（gate 字段，FR-006 口径）与工件对账出的
 * 未完成清单；「转为长期任务」B-M3 已接通——草稿写入 store → 跳「长期任务」面板
 * 创建流预填（目标 + 锚位 + 来源任务随 job:create 下传，B-M1 触发链接收）。
 * 终态 6s 后自动清除；SOP 输入聚焦或已填名称时暂停计时，给用户操作窗口（P1-7）。
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskFinishedPayload } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { statusLabel, GATE_LABELS } from "../../common/labels";

export function FinishedCard({
  finished,
  onError,
}: {
  finished: TaskFinishedPayload;
  onError: (message: string) => void;
}) {
  const clearTask = useIslandStore((s) => s.clearTask);
  const pushToast = useIslandStore((s) => s.pushToast);
  const setConvertDraft = useIslandStore((s) => s.setConvertDraft);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);
  const [sopName, setSopName] = useState("");
  const [sopFocused, setSopFocused] = useState(false);
  const completed = finished.status === "COMPLETED";
  const gateText = finished.gate ? GATE_LABELS[finished.gate] ?? `闸口 ${finished.gate}` : null;
  const remaining = finished.remaining ?? [];

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

  // B-M3 收口：草稿携带目标 + 锚位 + 来源任务，跳「长期任务」面板预填创建表单
  const handleConvertToLongTask = useCallback(() => {
    const goal = useIslandStore.getState().currentTaskGoal;
    if (!goal.trim()) {
      pushToast("error", "任务目标已清除，无法转为长期任务");
      return;
    }
    setConvertDraft({ goal, sourceTaskId: finished.taskId ?? null, targetApp: finished.targetApp ?? null });
    setPanelMode("longtask");
    pushToast("info", "已带目标跳转「长期任务」：确认后创建（自动携带锚位与授权）");
  }, [finished.taskId, finished.targetApp, setConvertDraft, setPanelMode, pushToast]);

  useEffect(() => {
    if (sopFocused || sopName.trim()) return;
    const timer = setTimeout(() => clearTask(), 6000);
    return () => clearTimeout(timer);
  }, [clearTask, sopFocused, sopName]);

  return (
    <div className="mt-3 island-fade-up">
      <div
        className="rounded-xl rounded-tl-sm px-3.5 py-2.5"
        style={{
          background: completed ? "rgba(63,224,160,0.08)" : "rgba(248,113,113,0.08)",
          border: `1px solid ${completed ? "rgba(63,224,160,0.2)" : "rgba(248,113,113,0.2)"}`,
        }}
      >
        <div className="flex items-center justify-between text-[12px] t-faint mb-1">
          <span style={{ color: completed ? "var(--c-thinking)" : "var(--c-error)" }}>
            {completed ? "✓ 已完成" : `✕ ${statusLabel(finished.status)}`}
          </span>
          <span>{finished.steps} 步 · {finished.totalTokens} tokens</span>
        </div>
        {/* 收口报告（FR-006）：终态由哪一闸触发（预算/停滞闸收口必然有值） */}
        {gateText && (
          <div className="mb-1 inline-flex items-center gap-1 rounded-full ig-bg-panel-hover px-2 py-0.5 text-[11px] t-muted" data-interactive>
            收口闸 · {gateText}
          </div>
        )}
        <div className="text-[13px] leading-snug t-strong">
          {finished.finalAnswer || (completed ? "任务已完成" : "未返回详细结果，可在历史面板查看")}
        </div>
        {/* 未完成清单（最新检查点工件对账；断点保留，续跑从这些项重做） */}
        {remaining.length > 0 && (
          <div className="mt-1.5 text-[12px] t-muted">
            <div className="t-faint">未完成清单（{remaining.length} 项，工件核对）：</div>
            <ul className="mt-0.5 max-h-20 list-inside list-disc overflow-y-auto pl-0.5 leading-snug">
              {remaining.slice(0, 8).map((item) => (
                <li key={item} className="truncate" title={item}>{item}</li>
              ))}
              {remaining.length > 8 && <li className="t-faint">…另 {remaining.length - 8} 项</li>}
            </ul>
          </div>
        )}
      </div>
      {/* 存为 SOP / 转为长期任务（B 期入口） */}
      <div className="mt-2 flex gap-1.5">
        <input
          className="island-input h-7 flex-1 text-[12px]"
          placeholder="存为 SOP 模板名"
          value={sopName}
          onChange={(e) => setSopName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSaveSop(); }}
          onFocus={() => setSopFocused(true)}
          onBlur={() => setSopFocused(false)}
          data-interactive
        />
        <button
          className="island-btn island-btn--primary h-7 px-3 text-[12px]"
          disabled={!sopName.trim()}
          onClick={handleSaveSop}
          data-interactive
        >
          存为模板
        </button>
        <button
          className="island-btn island-btn--ghost h-7 px-3 text-[12px]"
          onClick={handleConvertToLongTask}
          data-interactive
          title="带着本任务目标与锚位创建周期长期任务（B-M1 接通无人值守载荷）"
        >
          转为长期任务
        </button>
      </div>
    </div>
  );
}
