/**
 * InterruptedBanner.tsx — 中断任务恢复横幅（应用崩溃/退出遗留）
 */
import { useCallback } from "react";
import { useIslandStore } from "../../../store/islandStore";

export function InterruptedBanner() {
  const taskRunning = useIslandStore((s) => s.taskRunning);
  const interrupted = useIslandStore((s) => s.interrupted);
  const resumeTask = useIslandStore((s) => s.resumeTask);
  const resetRun = useIslandStore((s) => s.resetRun);
  const pushToast = useIslandStore((s) => s.pushToast);
  const dismissInterrupted = useIslandStore((s) => s.dismissInterrupted);

  const task = interrupted[0];

  // 断点续跑：从中断任务的原步骤骨架重启
  const handleResumeInterrupted = useCallback(async (taskId: string) => {
    const res = await resumeTask(taskId);
    if (res.ok) {
      resetRun();
      pushToast("success", "已从中断点续跑，原步骤将作为骨架注入");
    } else {
      pushToast("error", res.error ?? "续跑失败");
    }
  }, [resumeTask, resetRun, pushToast]);

  if (taskRunning || !task) return null;

  return (
    <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5 island-fade-up">
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
      <div className="min-w-0 flex-1 truncate text-[11px] text-amber-200/90" title={task.goal}>
        检测到未完成任务「{task.goal.slice(0, 30)}…」（已进行 {task.steps} 步）
      </div>
      <button
        className="island-btn island-btn--ghost shrink-0 px-2.5 text-[10.5px]"
        onClick={() => void handleResumeInterrupted(task.taskId)}
        data-interactive
      >
        继续执行
      </button>
      <button className="island-btn island-btn--ghost shrink-0 px-2.5 text-[10.5px]" onClick={dismissInterrupted} data-interactive>
        放弃
      </button>
    </div>
  );
}
