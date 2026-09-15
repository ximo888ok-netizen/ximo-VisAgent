/**
 * LongTaskPanel.tsx — B-M3 长期任务管理面板（规划 §4.3，编排层）
 *
 * 结构：FR-012 四数卡（MetricsCards）+ 创建流（CreateForm，承接收口卡 convertDraft）
 * + job 列表（LongTaskJobRow ×N，详情抽屉 JobDetailDrawer）。
 * 数据：jobs/metrics 与 5s 轮询在 smartSlice（复用 longtask:status 轮询纪律，
 * 面板挂载开、卸载停）；断点游标经 longtask:checkpoints 按需取（useJobCursors）。
 * FR-011 四操作 = 暂停(toggle) · 编辑 cron(update) · 删除(delete) · 立即跑一次(run-now)，
 * 全部 ≤1s 回显：store 成功后拉权威列表刷新徽标，失败行内/toast 报错。
 */
import { useEffect, useState } from "react";
import type { ScheduledJobPayload } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { MetricsCards } from "./MetricsCards";
import { CreateForm } from "./CreateForm";
import { LongTaskJobRow } from "./LongTaskJobRow";
import { JobDetailDrawer } from "./JobDetailDrawer";
import { useJobCursors } from "./useJobCursors";

export function LongTaskPanel() {
  const jobs = useIslandStore((s) => s.jobs);
  const jobsLoading = useIslandStore((s) => s.jobsLoading);
  const jobsError = useIslandStore((s) => s.jobsError);
  const loadJobs = useIslandStore((s) => s.loadJobs);
  const loadMetrics = useIslandStore((s) => s.loadMetrics);
  const toggleJob = useIslandStore((s) => s.toggleJob);
  const deleteJob = useIslandStore((s) => s.deleteJob);
  const updateJobCron = useIslandStore((s) => s.updateJobCron);
  const runJobNow = useIslandStore((s) => s.runJobNow);
  const startLongTaskPoll = useIslandStore((s) => s.startLongTaskPoll);
  const stopLongTaskPoll = useIslandStore((s) => s.stopLongTaskPoll);
  const pushToast = useIslandStore((s) => s.pushToast);
  const convertDraft = useIslandStore((s) => s.convertDraft);
  const setConvertDraft = useIslandStore((s) => s.setConvertDraft);

  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runBusyId, setRunBusyId] = useState<string | null>(null);
  const cursors = useJobCursors(jobs);

  useEffect(() => {
    void loadJobs();
    void loadMetrics();
    startLongTaskPoll();
    return () => stopLongTaskPoll();
  }, [loadJobs, loadMetrics, startLongTaskPoll, stopLongTaskPoll]);

  // 「转为长期任务」入口（A-M7 收口卡）：草稿到达即打开本面板创建流并预填
  useEffect(() => {
    if (convertDraft) setCreating(true);
  }, [convertDraft]);

  const handleRunNow = (job: ScheduledJobPayload): void => {
    if (runBusyId) return;
    setRunBusyId(job.id);
    void runJobNow({ id: job.id }).then((res) => {
      setRunBusyId(null);
      if (!res.ok) {
        pushToast("error", `「${job.name}」触发失败：${res.error}`);
        return;
      }
      pushToast(
        res.data.status === "skipped-busy" ? "info" : "success",
        res.data.status === "skipped-busy" ? `「${job.name}」上轮仍在运行，本轮已跳过` : `「${job.name}」已触发，进入运行中`,
      );
    });
  };

  const handleSubmitCron = async (job: ScheduledJobPayload, cron: string): Promise<string | null> => {
    const res = await updateJobCron({ id: job.id, cron });
    if (!res.ok) return res.error;
    pushToast("success", `「${job.name}」排期已更新`);
    return null;
  };

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] t-strong font-medium">长期任务</span>
        {!creating && (
          <button data-interactive className="island-btn island-btn--primary h-6 px-2.5 text-[12px]" onClick={() => setCreating(true)}>
            + 新建
          </button>
        )}
      </div>

      <div className="island-panel-scroll min-h-0 flex-1 space-y-1.5 pr-1">
        <MetricsCards />

        {creating && (
          <CreateForm
            draft={convertDraft}
            onCreated={() => {
              setCreating(false);
              setConvertDraft(null);
            }}
          />
        )}

        {jobsLoading && jobs.length === 0 && (
          <>
            <div className="island-skeleton h-16 rounded-xl ig-bg-panel" />
            <div className="island-skeleton h-16 rounded-xl ig-bg-panel" />
          </>
        )}
        {jobsError && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="text-[12px] ig-fg-danger">长期任务加载失败：{jobsError}</span>
            <button data-interactive className="island-btn island-btn--ghost text-[12px]" onClick={() => void loadJobs()}>重试</button>
          </div>
        )}
        {!jobsLoading && !jobsError && jobs.length === 0 && !creating && (
          <div className="flex h-24 items-center justify-center text-[12px] t-faint">
            还没有长期任务 · 点「+ 新建」，或在任务收口卡点「转为长期任务」
          </div>
        )}

        {jobs.map((job) => (
          <LongTaskJobRow
            key={job.id}
            job={job}
            cursor={cursors[job.id] ?? null}
            busy={runBusyId !== null}
            detail={expandedId === job.id ? <JobDetailDrawer job={job} /> : null}
            onToggle={(enabled) => {
              void toggleJob(job.id, enabled);
              pushToast("info", `「${job.name}」已${enabled ? "恢复排期" : "暂停"}`);
            }}
            onRunNow={() => handleRunNow(job)}
            onDelete={() => {
              void deleteJob(job.id);
              pushToast("info", `「${job.name}」已删除`);
            }}
            onSubmitCron={(cron) => handleSubmitCron(job, cron)}
            onToggleDetail={() => setExpandedId((id) => (id === job.id ? null : job.id))}
          />
        ))}
      </div>
    </div>
  );
}
