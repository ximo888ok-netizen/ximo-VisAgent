/**
 * TaskPanel.tsx — 任务面板（流式对话 UI）编排层
 *
 * 交互模式（2026 主流 AI 对话界面）：
 * - 无内容时：输入框位于面板中央，居中显示
 * - 用户输入后：输入框下沉到底部，上方腾出空间给对话内容流
 * - 对话流：用户消息 + Agent 步骤时间线 + 终态结果
 * - 运行中：暂停/继续/取消；成本徽章实时累计 token
 *
 * 各段呈现与自带状态见 ./Task/ 子组件；本文件只做布局编排与滚动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import { InterruptedBanner } from "./InterruptedBanner";
import { RunningControlBar } from "./RunningControlBar";
import { StepStream } from "./StepStream";
import { FinishedCard } from "./FinishedCard";
import { ErrorCard } from "./ErrorCard";
import { TaskComposer } from "./TaskComposer";

export function TaskPanel() {
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const taskRunning = useIslandStore((s) => s.taskRunning);
  const taskQueuedIndex = useIslandStore((s) => s.taskQueuedIndex);
  const currentTaskGoal = useIslandStore((s) => s.currentTaskGoal);
  const taskFinished = useIslandStore((s) => s.taskFinished);
  const steps = useIslandStore((s) => s.steps);
  const pushToast = useIslandStore((s) => s.pushToast);
  const loadInterrupted = useIslandStore((s) => s.loadInterrupted);
  const loadConversationInfo = useIslandStore((s) => s.loadConversationInfo);

  // 是否有对话内容
  const hasContent = taskRunning || !!taskFinished || !!currentTaskGoal || steps.length > 0 || !!taskQueuedIndex;

  // 启动时查询中断任务（应用崩溃/退出遗留）+ 会话轮数
  useEffect(() => {
    void loadInterrupted();
    void loadConversationInfo();
  }, [loadInterrupted, loadConversationInfo]);

  // 终态后刷新会话轮数
  useEffect(() => {
    if (taskFinished) void loadConversationInfo();
  }, [taskFinished, loadConversationInfo]);

  // 有内容时滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps, taskFinished]);

  const handleCancel = useCallback(async () => {
    const taskId = useIslandStore.getState().currentTaskId;
    if (!taskId) return;
    // P1-10 修复：取消结果反馈（排队任务即时终态；运行中任务等待当前步骤结束）
    const res = await window.islandAPI.cancelTask(taskId);
    if (res.ok) {
      pushToast("info", "已发送取消请求");
    } else {
      pushToast("error", res.error ?? "取消失败");
    }
  }, [pushToast]);

  return (
    <div className="flex h-full flex-col">
      <InterruptedBanner />

      {/* 对话内容流（有内容时显示在上方） */}
      {hasContent && (
        <div ref={scrollRef} className="island-panel-scroll flex-1 min-h-0 px-4 py-3">
          {/* 用户消息 */}
          {currentTaskGoal && (
            <div className="mb-3 flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-tr-sm px-3.5 py-2 text-[12px] t-strong"
                style={{ background: "var(--island-input-focus)", color: "#fff" }}>
                {currentTaskGoal}
              </div>
            </div>
          )}

          {/* 排队横幅 */}
          {taskQueuedIndex !== null && !taskRunning && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5 island-fade-up">
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 island-ring--waiting" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-amber-200/90">排队中（前方 {taskQueuedIndex} 个任务）</div>
              </div>
              <button className="island-btn island-btn--ghost shrink-0 px-2.5 text-[10.5px]" onClick={handleCancel} data-interactive>
                取消
              </button>
            </div>
          )}

          {/* 运行中控制条 */}
          {taskRunning && <RunningControlBar onCancel={handleCancel} />}

          {/* 步骤对话流 */}
          <StepStream steps={steps} />

          {/* 终态 */}
          {taskFinished && !taskRunning && (
            <FinishedCard finished={taskFinished} onError={setError} />
          )}

          {/* 错误 */}
          {error && <ErrorCard error={error} />}
        </div>
      )}

      {/* 输入区域：无内容时居中，有内容时在底部 */}
      <div className={hasContent ? "border-t ig-border-line px-4 py-3" : "flex flex-1 flex-col items-center justify-center px-5 py-4"}>
        {!taskRunning && <TaskComposer hasContent={hasContent} onError={setError} />}
      </div>
    </div>
  );
}
