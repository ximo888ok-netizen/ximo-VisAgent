/**
 * JobCard.tsx — 单条定时任务卡（开关 + 二次确认删除 + 下次/上次运行）
 */
import { useState } from "react";
import type { ScheduledJobPayload } from "@shared/island-contracts";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function JobCard({ job, onToggle, onDelete, onViewSop }: {
  job: ScheduledJobPayload;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onViewSop: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const next = job.nextRunAt ? formatTime(job.nextRunAt) : "—";
  const last = job.lastRunAt ? `${formatTime(job.lastRunAt)} · ${job.lastStatus ?? ""}` : "从未运行";

  return (
    <div data-interactive className="group rounded-lg ig-bg-panel px-3 py-2 transition hover:ig-bg-panel-hover">
      <div className="flex items-center gap-2">
        <button
          data-interactive
          className={`island-toggle shrink-0 ${job.enabled ? "island-toggle--on" : ""}`}
          onClick={() => onToggle(!job.enabled)}
          title={job.enabled ? "点击暂停" : "点击启用"}
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] t-strong" title={job.name}>{job.name}</span>
        <span className="shrink-0 font-mono text-[9.5px] t-faint">{job.cron}</span>
        <button
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] transition ${confirming ? "bg-red-500/20 text-red-300 opacity-100" : "t-faint opacity-0 group-hover:opacity-100 hover:text-red-300"}`}
          onClick={() => {
            if (confirming) onDelete();
            else setConfirming(true);
            window.setTimeout(() => setConfirming(false), 3000);
          }}
        >
          {confirming ? "确认?" : "✕"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[9.5px] t-faint">
        <button className="min-w-0 flex-1 truncate text-left hover:t-body" onClick={onViewSop} disabled={!job.sopId} title={job.goal || "自定义目标"}>
          {job.goal || "自定义目标"}
        </button>
        <span className="shrink-0">
          {job.enabled ? `下次 ${next}` : "已暂停"} · {last}
        </span>
      </div>
    </div>
  );
}
