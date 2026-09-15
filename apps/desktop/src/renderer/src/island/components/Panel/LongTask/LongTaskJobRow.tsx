/**
 * LongTaskJobRow.tsx — 长期任务单行（规划 §4.3 / FR-011）
 *
 * 行 = 名称 + cron 人话 + 下次触发 + 上次状态徽标（含「超范围·等待批复」「错过合并
 * 补跑」两类标注）+ 断点摘要（读自 checkpoints cursor）+ 迷你时间条（纯 CSS）；
 * 操作组 = 暂停/恢复 · 编辑 cron · 立即跑一次 · 删除（二次确认）。
 * 编辑 cron 的校验走主进程复校（scheduler.updateCron 抛错 → 行内回显），保存成功
 * 由 store 拉权威列表即时回显（≤1s）。详情抽屉由面板注入（detail）。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { LongTaskCheckpointSummary, ScheduledJobPayload } from "@shared/island-contracts";
import { CRON_PRESETS } from "./constants";
import { cursorText, humanizeCron, missedLabel, nextRunText, progressPct, runBadge } from "./lib";

function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`ig-tag shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ${tone === "muted" ? "" : `ig-tone-${tone}`}`}>
      {label}
    </span>
  );
}

/** 迷你时间条（纯 CSS，不引图表库）：每轮一段刻度按终态着色；进行中的一段用游标填充比例 */
function MiniTimeline({ job, cursor }: { job: ScheduledJobPayload; cursor: LongTaskCheckpointSummary | null }) {
  const rounds = job.runHistory ?? [];
  const segCount = Math.max(rounds.length, cursor ? 1 : 0);
  if (segCount === 0) return null;
  const pct = progressPct(cursor);
  const running = job.lastRunStatus === "running" || job.lastRunStatus === "paused-out-of-scope";
  return (
    <div className="mt-1 flex h-1.5 items-stretch gap-[2px]" title={`${cursorText(cursor) ?? "尚无游标"} · 近 ${rounds.length} 轮`}>
      {Array.from({ length: Math.min(segCount, 5) }).map((_, i) => {
        const round = rounds[i];
        const base = !round
          ? "ig-bg-panel-hover"
          : round.status === "failed"
            ? "ig-bg-danger"
            : round.status === "done"
              ? "ig-bg-success"
              : "ig-bg-info";
        const isLast = i === segCount - 1;
        return (
          <div key={i} className={`relative min-w-0 flex-1 overflow-hidden rounded-full ${base}`}>
            {isLast && running && pct > 0 && pct < 100 && (
              <div className="absolute inset-y-0 right-0 rounded-full ig-bg-panel-hover" style={{ width: `${100 - pct}%` }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 内联 cron 编辑器：预设 chip + 表达式输入 + 人话预览；保存走主进程复校 */
function CronEditor({ job, onSubmit, onClose }: {
  job: ScheduledJobPayload;
  onSubmit: (cron: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(job.cron);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!value.trim()) {
      setError("请填写 cron 表达式");
      return;
    }
    setBusy(true);
    const err = await onSubmit(value.trim());
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="island-fade-up mt-1.5 rounded-lg ig-bg-panel-hover px-2 py-1.5">
      <div className="mb-1 flex flex-wrap gap-1">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            data-interactive
            className={`rounded-full px-1.5 py-0.5 text-[11px] ${value === p.cron ? "ig-bg-panel t-strong" : "t-muted hover:t-body"}`}
            onClick={() => { setValue(p.cron); setError(null); }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          data-interactive
          autoFocus
          className="island-input flex-1 font-mono text-[12px]"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") onClose(); }}
        />
        <span className="shrink-0 text-[11px] t-faint">{humanizeCron(value)}</span>
        <button data-interactive className="island-btn island-btn--primary h-6 px-2 text-[11px]" disabled={busy} onClick={() => void save()}>
          {busy ? "…" : "保存"}
        </button>
        <button data-interactive className="island-btn island-btn--ghost h-6 px-2 text-[11px]" onClick={onClose}>
          取消
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] ig-fg-danger">{error}</div>}
    </div>
  );
}

export function LongTaskJobRow({ job, cursor, busy, detail, onToggle, onRunNow, onDelete, onSubmitCron, onToggleDetail }: {
  job: ScheduledJobPayload;
  cursor: LongTaskCheckpointSummary | null;
  busy: boolean;
  detail: ReactNode;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
  onSubmitCron: (cron: string) => Promise<string | null>;
  onToggleDetail: () => void;
}) {
  const now = Date.now();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const badge = runBadge(job.lastRunStatus, job.enabled);
  const missed = missedLabel(job.mergedInto, now);
  const cursorSummary = cursorText(cursor);

  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2 transition hover:ig-bg-panel-hover">
      <div className="flex items-center gap-2">
        <button
          data-interactive
          className={`island-toggle shrink-0 ${job.enabled ? "island-toggle--on" : ""}`}
          title={job.enabled ? "暂停" : "恢复"}
          onClick={() => onToggle(!job.enabled)}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] t-strong" title={job.goal || job.name}>{job.name}</span>
        {job.targetApp && <span className="ig-tag ig-tone-info shrink-0 rounded-full px-1.5 py-0.5 text-[11px]">锚定 · {job.targetApp.name}</span>}
        <Badge label={badge.label} tone={badge.tone} />
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px] t-faint">
        <span className="min-w-0 truncate" title={job.cron}>{humanizeCron(job.cron)}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0 t-num">{job.enabled ? nextRunText(job.nextRunAt, now) : "已停用"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button data-interactive className="island-btn island-btn--ghost h-5 px-1.5 text-[11px]" disabled={busy} onClick={onRunNow} title="立即跑一次（不打乱排期）">
            {busy ? "触发中…" : "跑一次"}
          </button>
          <button data-interactive className="island-btn island-btn--ghost h-5 px-1.5 text-[11px]" onClick={() => setEditing((v) => !v)}>
            编辑
          </button>
          <button data-interactive className="island-btn island-btn--ghost h-5 px-1.5 text-[11px]" onClick={onToggleDetail}>
            {detail ? "收起" : "详情"}
          </button>
          <button
            data-interactive
            className={`island-btn h-5 px-1.5 text-[11px] ${confirming ? "island-btn--danger" : "island-btn--ghost"}`}
            onClick={() => { if (confirming) onDelete(); else setConfirming(true); }}
          >
            {confirming ? "确认?" : "删除"}
          </button>
        </span>
      </div>

      {(cursorSummary || missed) && (
        <div className="mt-1 space-y-1 text-[11px]">
          {cursorSummary && <div className="t-muted">{cursorSummary}</div>}
          {missed && <div className="ig-tag ig-tone-warning inline-block rounded-full px-1.5 py-0.5">{missed}</div>}
        </div>
      )}
      <MiniTimeline job={job} cursor={cursor} />

      {editing && <CronEditor job={job} onSubmit={onSubmitCron} onClose={() => setEditing(false)} />}
      {detail}
    </div>
  );
}
