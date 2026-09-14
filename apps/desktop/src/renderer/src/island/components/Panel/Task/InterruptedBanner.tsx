/**
 * InterruptedBanner.tsx — 中断任务恢复横幅（应用崩溃/退出遗留）
 *
 * 锚定长任务分支（A-M4）：listInterrupted 附带工件对账预览时，显示
 * 「上次进行到第 X 项（读自工件核对），N 项将重做」并可展开重做清单；
 * 无 checkpoint 的旧任务保持原单行文案（零回归红线）。
 */
import { useCallback, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";

export function InterruptedBanner() {
  const taskRunning = useIslandStore((s) => s.taskRunning);
  const interrupted = useIslandStore((s) => s.interrupted);
  const resumeTask = useIslandStore((s) => s.resumeTask);
  const resetRun = useIslandStore((s) => s.resetRun);
  const pushToast = useIslandStore((s) => s.pushToast);
  const dismissInterrupted = useIslandStore((s) => s.dismissInterrupted);
  const [redoExpanded, setRedoExpanded] = useState(false);

  const task = interrupted[0];
  const cp = task?.checkpoint;

  // 断点续跑：从中断任务的原步骤骨架重启（工件对账预览来自 §2.3 reconcile）
  const handleResumeInterrupted = useCallback(async (taskId: string) => {
    const res = await resumeTask(taskId);
    if (res.ok) {
      resetRun();
      pushToast("success", cp ? "已按工件对账结果续跑，变动工件将重做" : "已从中断点续跑，原步骤将作为骨架注入");
    } else {
      pushToast("error", res.error ?? "续跑失败");
    }
  }, [resumeTask, resetRun, pushToast, cp]);

  if (taskRunning || !task) return null;

  return (
    <div className={`mx-4 mt-3 rounded-lg ig-alert ig-tone-warning px-3 py-2.5 island-fade-up${cp ? "" : " flex items-center gap-2"}`}>
      <div className={cp ? "flex items-start gap-2" : "flex min-w-0 flex-1 items-center gap-2"}>
        <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ig-bg-warning" />
        <div className="min-w-0 flex-1 text-[12px] ig-fg-warning">
          {cp ? (
            <>
              <div className="truncate" title={task.goal}>
                未完成任务「{task.goal.slice(0, 30)}…」（已进行 {task.steps} 步）
              </div>
              <div className="mt-0.5 truncate" title={cp.summary || undefined}>
                上次进行到第 {cp.done} {cp.unit}（读自工件核对）
                {cp.redoCount > 0 ? `，${cp.redoCount} 项将重做` : "，工件核对全部通过"}
                {cp.redoCount > 0 && (
                  <button
                    className="ml-1.5 underline decoration-dotted ig-fg-warning"
                    onClick={() => setRedoExpanded((v) => !v)}
                    data-interactive
                  >
                    {redoExpanded ? "收起清单" : "展开清单"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="truncate" title={task.goal}>
              检测到未完成任务「{task.goal.slice(0, 30)}…」（已进行 {task.steps} 步）
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="island-btn island-btn--ghost px-2.5 text-[12px]"
            onClick={() => void handleResumeInterrupted(task.taskId)}
            data-interactive
          >
            继续执行
          </button>
          <button className="island-btn island-btn--ghost px-2.5 text-[12px]" onClick={dismissInterrupted} data-interactive>
            放弃
          </button>
        </div>
      </div>
      {cp && redoExpanded && cp.redoCount > 0 && (
        <ul className="mt-1.5 max-h-28 overflow-y-auto pl-5 text-[11px] ig-fg-warning" data-testid="redo-list">
          {cp.redoItems.map((item) => (
            <li key={`${item.path}:${item.reason}`} className="truncate" title={item.path}>
              {item.path.split(/[\\/]/).pop()} · {item.reason === "missing" ? "文件已丢失" : "内容有变动"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
