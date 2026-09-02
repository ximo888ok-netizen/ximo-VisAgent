/**
 * TaskList.tsx — 任务历史列表（审计面板左栏）
 */
import { useIslandStore } from "../../store/islandStore";

export function TaskList() {
  const tasks = useIslandStore((s) => s.tasks);
  const selectedTaskId = useIslandStore((s) => s.selectedTaskId);
  const selectTask = useIslandStore((s) => s.selectTask);

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <span className="text-[11px] text-white/25">无任务记录</span>
      </div>
    );
  }

  return (
    <div className="island-panel-scroll h-full">
      {tasks.map((task, i) => {
        const active = task.taskId === selectedTaskId;
        const isDone = task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED";
        return (
          <div
            key={task.taskId}
            className={`island-list-item island-fade-up ${active ? "island-list-item--active" : ""}`}
            style={{ animationDelay: `${i * 30}ms` }}
            onClick={() => selectTask(task.taskId)}
            data-interactive
          >
            {/* 状态点 */}
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                style={{
                  background: task.status === "COMPLETED" ? "#3fe0a0" : task.status === "FAILED" ? "#f87171" : "#fbbf24",
                }}
              />
              <span className="text-[11px] text-white/60 truncate" style={{ maxWidth: 160 }}>
                {task.goal}
              </span>
            </div>
            <div className="mt-1 ml-4 flex items-center justify-between">
              <span className="text-[9.5px] text-white/25">
                {new Date(task.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="text-[9.5px]" style={{
                color: isDone ? (task.status === "COMPLETED" ? "#3fe0a0" : "#f87171") : "#fbbf24",
              }}>
                {isDone ? task.status : "运行中"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
