/**
 * LogPanel.tsx — 步骤时间线面板
 *
 * 展示 Agent 每步 thought/action/result，逆向滚动（最新在底部）。
 * 包含 token 统计。
 */
import { useMemo } from "react";
import { useIslandStore } from "../../store/islandStore";

export function LogPanel() {
  const logs = useIslandStore((s) => s.logs);
  const status = useIslandStore((s) => s.status);
  const currentTaskGoal = useIslandStore((s) => s.currentTaskGoal);
  const taskFinished = useIslandStore((s) => s.taskFinished);

  // 反向排序，最新在底部
  const reversedLogs = useMemo(() => [...logs].reverse(), [logs]);

  // 分组：连续相同 status 的高亮最新一条
  const displayLogs = useMemo(() => {
    return reversedLogs.map((log, i) => ({
      ...log,
      isFirst: i === 0,
    }));
  }, [reversedLogs]);

  if (logs.length === 0 && !currentTaskGoal) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full ig-bg-panel grid place-items-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M5 5h14v10H5z" stroke="var(--ig-t-faint)" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M5 15l-2 4 3-2h12l3 2-2-4" stroke="var(--ig-t-faint)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-[12px] t-faint">尚无执行记录</p>
          <p className="mt-1 text-[11px] t-faint">在「任务」面板输入任务以开始</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      {/* 任务目标 */}
      {currentTaskGoal && (
        <div className="mb-3 rounded-lg border ig-border-line ig-bg-panel px-3 py-2">
          <div className="text-[10px] t-faint">任务目标</div>
          <div className="mt-0.5 text-[12px] t-body">{currentTaskGoal}</div>
        </div>
      )}

      {/* 时间线 */}
      <div className="island-timeline space-y-1">
        {displayLogs.map((log) => (
          <div key={log.id} className="island-fade-up flex gap-2.5" style={{ animationDelay: `${Math.min(log.id * 30, 200)}ms` }}>
            {/* 节点 */}
            <div
              className={`island-timeline-dot ${
                log.isFirst && status !== "idle"
                  ? log.status === "error" ? "island-timeline-dot--error" : "island-timeline-dot--active"
                  : ""
              }`}
            />
            {/* 内容 */}
            <div className="flex-1 pb-1">
              <div className="text-[10px] t-faint">
                {new Date(log.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                <span className="ml-2" style={{ color: statusColor(log.status) }}>
                  {statusText(log.status)}
                </span>
              </div>
              <div className="mt-0.5 text-[12px] leading-snug t-strong">
                {log.text}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 终态 */}
      {taskFinished && (
        <div
          className="mt-3 rounded-lg px-3 py-2 island-fade-up"
          style={{
            background: taskFinished.status === "COMPLETED" ? "rgba(63,224,160,0.06)" : "rgba(248,113,113,0.06)",
            border: `1px solid ${taskFinished.status === "COMPLETED" ? "rgba(63,224,160,0.2)" : "rgba(248,113,113,0.2)"}`,
          }}
        >
          <div className="flex items-center justify-between text-[11px]">
            <span style={{ color: taskFinished.status === "COMPLETED" ? "#3fe0a0" : "#f87171" }}>
              {taskFinished.status === "COMPLETED" ? "任务完成" : taskFinished.status}
            </span>
            <span className="t-faint">{taskFinished.steps} 步 · {taskFinished.totalTokens} tokens</span>
          </div>
          <div className="mt-1 text-[11.5px] leading-snug t-body" style={{ maxHeight: 48, overflow: "hidden" }}>
            {taskFinished.finalAnswer}
          </div>
        </div>
      )}
    </div>
  );
}

function statusColor(s: string): string {
  switch (s) {
    case "idle": return "var(--ig-t-muted)";
    case "thinking": return "#3fe0a0";
    case "paused": return "#60a5fa";
    case "waiting_approval": return "#fbbf24";
    case "error": return "#f87171";
    case "stopped": return "#f87171";
    default: return "var(--ig-t-muted)";
  }
}

function statusText(s: string): string {
  switch (s) {
    case "idle": return "就绪";
    case "thinking": return "运行";
    case "paused": return "暂停";
    case "waiting_approval": return "审批";
    case "error": return "异常";
    case "stopped": return "停止";
    default: return s;
  }
}
