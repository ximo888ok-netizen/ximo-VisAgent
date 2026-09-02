/**
 * TaskPanel.tsx — 任务下达面板
 *
 * 交互：
 * - 自然语言输入框（多行，回车提交，Shift+回车换行）
 * - 提交后自动切到日志面板
 * - 任务运行中显示状态 + 取消按钮
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useIslandStore, PANEL_HEIGHTS } from "../../store/islandStore";

export function TaskPanel() {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const taskRunning = useIslandStore((s) => s.taskRunning);
  const currentTaskGoal = useIslandStore((s) => s.currentTaskGoal);
  const taskFinished = useIslandStore((s) => s.taskFinished);
  const setTaskStarted = useIslandStore((s) => s.setTaskStarted);
  const setTaskFinished = useIslandStore((s) => s.setTaskFinished);
  const clearTask = useIslandStore((s) => s.clearTask);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);

  // 聚焦输入框
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || submitting || taskRunning) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.islandAPI.startTask({ goal: trimmed });
      if (res.ok) {
        setTaskStarted(res.data.taskId, res.data.goal);
        setPanelMode("log");
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }, [goal, submitting, taskRunning, setTaskStarted, setPanelMode]);

  const handleCancel = useCallback(async () => {
    const taskId = useIslandStore.getState().currentTaskId;
    if (!taskId) return;
    await window.islandAPI.cancelTask(taskId);
  }, []);

  // 任务终态自动展示
  useEffect(() => {
    if (taskFinished && !taskRunning) {
      const timer = setTimeout(() => setPanelMode("log"), 800);
      return () => clearTimeout(timer);
    }
  }, [taskFinished, taskRunning, setPanelMode]);

  // 清除终态
  useEffect(() => {
    if (taskFinished) {
      const timer = setTimeout(() => clearTask(), 4000);
      return () => clearTimeout(timer);
    }
  }, [taskFinished, clearTask]);

  const charCount = goal.length;

  return (
    <div className="px-5 py-4">
      {/* 输入区 */}
      <div className="relative">
        <textarea
          ref={inputRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="输入任务，例如：打开记事本，输入「你好，AGI」并保存到桌面"
          rows={3}
          className="island-input island-glow resize-none"
          style={{ fontSize: "13px", lineHeight: "1.5", minHeight: 72 }}
          data-interactive
        />
        {/* 字数指示 */}
        <span
          className="absolute right-3 bottom-2.5 text-[10px] transition-colors"
          style={{
            color: charCount > 1500 ? "rgba(248,113,113,0.6)" : "rgba(255,255,255,0.2)",
          }}
        >
          {charCount}/2000
        </span>
      </div>

      {/* 操作区 */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10.5px] text-white/30">
          {taskRunning ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 island-ring--thinking" />
              任务运行中
            </span>
          ) : taskFinished ? (
            <span style={{ color: taskFinished.status === "COMPLETED" ? "#3fe0a0" : "#f87171" }}>
              {taskFinished.status === "COMPLETED" ? "✓ 已完成" : "✕ " + taskFinished.status}
            </span>
          ) : (
            "Enter 提交 · Shift+Enter 换行"
          )}
        </span>

        <div className="flex gap-2">
          {taskRunning && (
            <button
              className="island-btn island-btn--ghost text-[11px]"
              onClick={handleCancel}
              data-interactive
            >
              取消任务
            </button>
          )}
          <button
            className="island-btn island-btn--primary"
            disabled={!goal.trim() || submitting || taskRunning}
            onClick={handleSubmit}
            data-interactive
          >
            {submitting ? "提交中…" : taskRunning ? "运行中" : "开始任务"}
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300 island-fade-up">
          {error}
        </div>
      )}

      {/* 当前任务描述 */}
      {taskRunning && currentTaskGoal && (
        <div className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 island-fade-up">
          <div className="text-[10px] text-white/30">当前任务</div>
          <div className="mt-0.5 text-[12px] text-white/80">{currentTaskGoal}</div>
        </div>
      )}

      {/* 终态摘要 */}
      {taskFinished && (
        <div className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 island-fade-up">
          <div className="flex items-center justify-between text-[10px] text-white/30">
            <span>任务结果</span>
            <span>{taskFinished.steps} 步 · {taskFinished.totalTokens} tokens</span>
          </div>
          <div className="mt-1 text-[12px] text-white/70" style={{ maxHeight: 40, overflow: "hidden" }}>
            {taskFinished.finalAnswer}
          </div>
        </div>
      )}
    </div>
  );
}

// 确保面板高度常量被引用（供 IslandShell 读取）
export const TASK_PANEL_HEIGHT = PANEL_HEIGHTS.task;
