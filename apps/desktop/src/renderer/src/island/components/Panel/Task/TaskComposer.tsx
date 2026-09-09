/**
 * TaskComposer.tsx — 任务输入区（草稿输入 + 提交 + 推荐条 + 会话/档位工具条）
 *
 * 无内容时由父层居中摆放（hasContent=false），有内容时沉到底部。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import { ThinkingModeSelect } from "./ThinkingModeSelect";
import { RecommendBar } from "./RecommendBar";
import { useSopRecommendation } from "./useSopRecommendation";

export function TaskComposer({
  hasContent,
  onError,
}: {
  hasContent: boolean;
  onError: (message: string | null) => void;
}) {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const taskRunning = useIslandStore((s) => s.taskRunning);
  const setTaskStarted = useIslandStore((s) => s.setTaskStarted);
  const resetRun = useIslandStore((s) => s.resetRun);
  const clearTask = useIslandStore((s) => s.clearTask);
  const pushToast = useIslandStore((s) => s.pushToast);
  const conversationTurns = useIslandStore((s) => s.conversationTurns);
  const clearConversation = useIslandStore((s) => s.clearConversation);

  useSopRecommendation(goal);

  // 无内容时自动聚焦
  useEffect(() => {
    if (hasContent) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, [hasContent]);

  // 全局快速输入聚焦
  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("island:focus-quick-input", onFocus);
    return () => window.removeEventListener("island:focus-quick-input", onFocus);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || submitting || taskRunning) return;
    setSubmitting(true);
    onError(null);
    try {
      const res = await window.islandAPI.startTask({ goal: trimmed });
      if (res.ok) {
        // P2-14 修复：提交成功后才清空旧对话，失败时保留上一轮结果
        resetRun();
        setTaskStarted(res.data.taskId, res.data.goal, res.data.queuedIndex);
        setGoal("");
        if (res.data.queued) {
          pushToast("info", `任务已加入队列（前方 ${res.data.queuedIndex ?? 1} 个），将自动依次执行`);
        } else {
          pushToast("success", "任务已启动");
        }
      } else {
        onError(res.error);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }, [goal, submitting, taskRunning, setTaskStarted, resetRun, pushToast, onError]);

  // 新对话：清空会话上下文与当前展示
  const handleNewConversation = useCallback(async () => {
    await clearConversation();
    clearTask();
    resetRun();
    pushToast("info", "已开启新对话");
  }, [clearConversation, clearTask, resetRun, pushToast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className={hasContent ? "" : "w-full max-w-[460px]"}>
      <RecommendBar />
      {!hasContent && (
        <div className="mb-4 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full ig-bg-panel grid place-items-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L14 8H20L15 12L17 18L12 14L7 18L9 12L4 8H10L12 2Z" stroke="var(--ig-t-muted)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-[13px] t-body font-medium">有什么可以帮你？</p>
          <p className="mt-1 text-[10.5px] t-faint">输入任务，Agent 将自动执行</p>
        </div>
      )}
      <div className="relative">
        <textarea
          ref={inputRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入任务，例如：打开记事本，输入「你好」并保存到桌面"
          rows={hasContent ? 1 : 2}
          maxLength={2000}
          className="island-input island-glow resize-none"
          style={{ fontSize: "12.5px", lineHeight: "1.5", minHeight: hasContent ? 36 : 56 }}
          data-interactive
        />
      </div>
      <div className="mt-2 flex items-center justify-between">
        {conversationTurns > 0 ? (
          <div className="flex items-center gap-2" data-interactive>
            <span className="text-[10px] t-faint">已关联 {conversationTurns} 轮对话（可说"把刚才那个再…"）</span>
            <button className="text-[10px] t-muted hover:t-body" onClick={() => void handleNewConversation()} data-interactive>
              新对话
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2" data-interactive>
            <ApprovalModeSelect />
            <ThinkingModeSelect />
            <span className="text-[10px] t-faint">Enter 提交 · Shift+Enter 换行</span>
          </div>
        )}
        <button
          className="island-btn island-btn--primary text-[11.5px]"
          disabled={!goal.trim() || submitting}
          onClick={handleSubmit}
          data-interactive
        >
          {submitting ? "提交中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
