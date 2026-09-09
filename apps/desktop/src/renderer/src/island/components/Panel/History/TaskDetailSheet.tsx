/**
 * TaskDetailSheet.tsx — 历史任务详情（头部信息 + 审计事件流）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import { statusLabel } from "../../common/labels";
import type { AuditRowPayload, TaskRowPayload } from "@shared/island-contracts";

export function TaskDetailSheet({ taskId }: { taskId: string }) {
  const tasks = useIslandStore((s) => s.tasks);
  const loadTasks = useIslandStore((s) => s.loadTasks);
  const resumeTask = useIslandStore((s) => s.resumeTask);
  const resetRun = useIslandStore((s) => s.resetRun);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);
  const pushToast = useIslandStore((s) => s.pushToast);
  const [events, setEvents] = useState<AuditRowPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);

  const task = tasks.find((t) => t.taskId === taskId);
  const resumable = !!task && ["RUNNING", "QUEUED", "PAUSED", "WAITING_APPROVAL"].includes(task.status);

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    const res = await resumeTask(taskId);
    setResuming(false);
    if (res.ok) {
      resetRun();
      setPanelMode("task");
    } else {
      pushToast("error", res.error ?? "续跑失败");
    }
  };

  useEffect(() => {
    if (tasks.length === 0) void loadTasks();
    let mounted = true;
    setLoading(true);
    void window.islandAPI.queryAudit({ taskId, limit: 500 })
      .then((res) => { if (mounted && res.ok) setEvents(res.data); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [taskId, tasks.length, loadTasks]);

  return (
    <div className="space-y-3 px-5 py-4">
      {task && <TaskHeader task={task} />}
      {resumable && (
        <button
          data-interactive
          className="island-btn island-btn--primary w-full text-[11px]"
          disabled={resuming}
          onClick={() => void handleResume()}
        >
          {resuming ? "续跑中…" : "从断点续跑（注入已执行步骤作为骨架）"}
        </button>
      )}
      <div className="island-label">审计事件（{events.length}）</div>
      {loading ? (
        <div className="island-skeleton h-40 rounded-lg ig-bg-panel" />
      ) : (
        <div className="island-panel-scroll space-y-1" style={{ maxHeight: 340 }}>
          {events.map((ev) => (
            <AuditEventRow key={ev.id} ev={ev} />
          ))}
          {events.length === 0 && <div className="py-6 text-center text-[11px] t-faint">无审计记录</div>}
        </div>
      )}
    </div>
  );
}

function TaskHeader({ task }: { task: TaskRowPayload }) {
  return (
    <div className="rounded-lg ig-bg-panel px-3 py-2.5">
      <div className="text-[12px] t-strong">{task.goal}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] t-muted">
        <span>状态：{statusLabel(task.status)}</span>
        {task.steps !== null && task.steps !== undefined && <span>步骤：{task.steps}</span>}
        {task.tokens !== null && task.tokens !== undefined && <span>token：{task.tokens.toLocaleString()}</span>}
        {task.finishedAt && <span>完成于：{new Date(task.finishedAt).toLocaleString("zh-CN")}</span>}
        {task.failureKind && task.status !== "COMPLETED" && <span className="text-red-300/70">归因：{task.failureKind}</span>}
      </div>
      {task.summary && (
        <div className="mt-1.5 line-clamp-3 text-[11px] t-body">{task.summary}</div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  step: "步骤", status: "状态", error: "错误", llm_usage: "用量",
  approval_pending: "待审批", approval_result: "审批结果", approval_decided: "审批决定",
  approval_mode_changed: "档位切换",
  task_result: "终态", evidence: "证据", perception: "感知",
};

function AuditEventRow({ ev }: { ev: AuditRowPayload }) {
  let detail = "";
  try {
    const d = JSON.parse(ev.detail) as Record<string, unknown>;
    const candidates: unknown[] = [d.resultSummary, d.message, d.status, d.decision, d.thought];
    if (d.promptTokens !== undefined) candidates.push(`${d.promptTokens}+${d.completionTokens} tok`);
    if (d.from !== undefined && d.to !== undefined) candidates.push(`${String(d.from)} → ${String(d.to)}`);
    const hit = candidates.find((c) => typeof c === "string" && c.length > 0);
    detail = (hit as string | undefined)?.slice(0, 160) ?? "";
    // 策略自动放行的行必须能一眼和人工决定区分开
    if (d.decidedBy === "policy") detail = `策略放行（L${String(d.level ?? "?")}）${detail ? " · " + detail : ""}`;
  } catch { /* ignore */ }
  return (
    <div className="flex items-center gap-2 rounded-md ig-bg-panel px-2.5 py-1.5">
      <span className="w-14 shrink-0 text-[9.5px] t-muted">{KIND_LABEL[ev.kind] ?? ev.kind}</span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] t-body">{detail || "(无摘要)"}</span>
      <span className="shrink-0 text-[9px] tabular-nums t-faint">
        {new Date(ev.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}
      </span>
    </div>
  );
}
