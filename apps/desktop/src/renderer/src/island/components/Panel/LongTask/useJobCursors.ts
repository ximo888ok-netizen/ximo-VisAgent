/**
 * useJobCursors.ts — job → 断点游标摘要（读自 longtask:checkpoints）
 *
 * 断点摘要「已处理 1400/2000 行」的唯一数据源是检查点 cursor（规划 §4.3）：
 * 取 job.checkpointRef.taskId（缺省回落 lastTaskId）最新 seq 行。
 * jobSig 聚合「id + 游标锚任务 + 上轮状态」：收敛（running→done）后重取游标，
 * 其余噪声字段（lastRunAt 等）不触发重复 IPC；job 列表本体经 ref 读取，
 * effect 依赖只认 jobSig（exhaustive-deps 合规）。
 */
import { useEffect, useRef, useState } from "react";
import type { LongTaskCheckpointSummary, ScheduledJobPayload } from "@shared/island-contracts";

function cursorTaskIdOf(job: ScheduledJobPayload): string | null {
  return job.checkpointRef?.taskId ?? job.lastTaskId ?? null;
}

export function useJobCursors(jobs: ScheduledJobPayload[]): Record<string, LongTaskCheckpointSummary | null> {
  const [cursors, setCursors] = useState<Record<string, LongTaskCheckpointSummary | null>>({});
  const jobsRef = useRef<ScheduledJobPayload[]>(jobs);
  const jobSig = jobs.map((j) => `${j.id}:${cursorTaskIdOf(j) ?? "-"}:${j.lastRunStatus ?? "-"}`).join("|");

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, LongTaskCheckpointSummary | null> = {};
      await Promise.all(
        jobsRef.current.map(async (job) => {
          const taskId = cursorTaskIdOf(job);
          if (!taskId) {
            next[job.id] = null;
            return;
          }
          const res = await window.islandAPI.longTaskCheckpoints({ taskId });
          next[job.id] = res.ok && res.data.length > 0 ? res.data[0] ?? null : null;
        }),
      );
      if (!cancelled) setCursors(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobSig]);

  return cursors;
}
