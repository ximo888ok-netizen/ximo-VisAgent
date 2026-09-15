/**
 * JobDetailDrawer.tsx — job 详情抽屉（近 5 轮：收口闸 / 游标 / 耗时）
 *
 * 数据拼装纪律：
 * - 轮次骨架 = job.runHistory（scheduler 记账，≤5 条）；旧 job 无历史时合成当前轮。
 * - 每轮 gate = 审计 task_gate_report（queryAudit 现成通道，不新增）；
 *   游标 = longtask:checkpoints 最新行；耗时 = tasks 行 finishedAt-createdAt
 *   （近 5 轮必在 queryTasks(200) 窗口内；窗口外显示「—」，不猜数）。
 * 展开时才拉取（一轮 ≤3 个只读 IPC），失败静默降级为「—」。
 */
import { useEffect, useState } from "react";
import type { JobRoundPayload, LongTaskCheckpointSummary, ScheduledJobPayload } from "@shared/island-contracts";
import { GATE_LABELS } from "../../common/labels";
import { RECENT_ROUNDS } from "./constants";
import { atText, cursorText, durationText, roundDurationMs, roundGate } from "./lib";

interface RoundDetail {
  cursor: LongTaskCheckpointSummary | null;
  gate: string | null;
  durationMs: number | null;
}

interface TaskRowLite { createdAt: number; finishedAt: number | null }

function roundsOf(job: ScheduledJobPayload): JobRoundPayload[] {
  if (job.runHistory && job.runHistory.length > 0) return job.runHistory.slice(-RECENT_ROUNDS);
  // 旧 job（runHistory 未积累）：用当前轮字段合成一行，抽屉不空转
  if (job.lastTaskId || job.lastRunAt) {
    return [{
      taskId: job.lastTaskId ?? "",
      at: job.lastRunAt ?? Date.now(),
      status: job.lastRunStatus === "running" || job.lastRunStatus === "paused-out-of-scope" ? "started" : job.lastRunStatus ?? "done",
      ...(job.lastRunStatus === "running" || job.lastRunStatus === "paused-out-of-scope" ? {} : { endedAt: job.lastRunAt ?? undefined }),
    }];
  }
  return [];
}

export function JobDetailDrawer({ job }: { job: ScheduledJobPayload }) {
  const [details, setDetails] = useState<Record<string, RoundDetail>>({});
  const rounds = roundsOf(job);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = roundsOf(job);
      const taskIds = [...new Set(snapshot.map((r) => r.taskId).filter((id) => id !== ""))];
      if (taskIds.length === 0) {
        setDetails({});
        return;
      }
      const auditLists = await Promise.all(
        taskIds.map(async (id) => {
          const res = await window.islandAPI.queryAudit({ taskId: id, limit: 50 });
          return res.ok ? res.data : [];
        }),
      );
      const cpLists = await Promise.all(
        taskIds.map(async (id) => {
          const res = await window.islandAPI.longTaskCheckpoints({ taskId: id });
          return res.ok ? res.data : [];
        }),
      );
      const tasksRes = await window.islandAPI.queryTasks({ limit: 200 });
      const taskBy = new Map<string, TaskRowLite>(
        (tasksRes.ok ? tasksRes.data : []).map((t) => [t.taskId, { createdAt: t.createdAt, finishedAt: t.finishedAt }]),
      );
      const next: Record<string, RoundDetail> = {};
      taskIds.forEach((id, i) => {
        const auditRows = auditLists[i] ?? [];
        const cps = cpLists[i] ?? [];
        const task = taskBy.get(id);
        // 耗时首选 tasks 行（finishedAt-createdAt）；窗口外回退审计首末事件跨度（近似值）
        const durationMs = task && task.finishedAt !== null
          ? task.finishedAt - task.createdAt
          : roundDurationMs(auditRows);
        next[id] = {
          cursor: cps[0] ?? null,
          gate: roundGate(auditRows),
          durationMs,
        };
      });
      if (!cancelled) setDetails(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [job]);

  return (
    <div className="island-fade-up mt-1.5 rounded-lg ig-bg-panel-hover px-2.5 py-2 text-[11px]">
      {job.goal && <div className="mb-1 line-clamp-2 t-muted" title={job.goal}>目标：{job.goal}</div>}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 items-center">
        <span className="t-faint">近 {rounds.length} 轮</span>
        <span className="t-faint">游标</span>
        <span className="t-faint">耗时</span>
        <span className="t-faint">收口闸</span>
        {rounds.map((r, i) => {
          const d = details[r.taskId];
          const live = r.status === "started" && r.endedAt === undefined;
          return (
            <div key={`${r.taskId}-${i}`} className="contents">
              <span className="min-w-0 truncate t-num">
                {atText(r.at)}
                {live && job.lastRunStatus === "paused-out-of-scope" && <span className="ig-tag ig-tone-warning ml-1 rounded px-1">等待批复</span>}
                {live && job.lastRunStatus === "running" && <span className="ig-tag ig-tone-info ml-1 rounded px-1">运行中</span>}
                {r.status === "skipped-busy" && <span className="t-faint ml-1">· 跳过（上轮在跑）</span>}
              </span>
              <span className="truncate t-num" title={d?.cursor?.summary}>{cursorText(d?.cursor ?? null) ?? "—"}</span>
              <span className="t-num">{live ? "进行中" : durationText(d?.durationMs ?? null)}</span>
              <span className="truncate">{d?.gate ? GATE_LABELS[d.gate] ?? d.gate : "—"}</span>
            </div>
          );
        })}
      </div>
      {rounds.length === 0 && <div className="t-faint">尚未跑过任何一轮 · 点「跑一次」立即验证</div>}
    </div>
  );
}
