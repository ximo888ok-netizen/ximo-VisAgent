/**
 * ReplayPlayer.tsx — 任务回放播放器（逐帧步骤截图 + 字幕 + 进度条 + 倍速）
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { AuditRowPayload } from "@shared/island-contracts";

interface ReplayStep {
  index: number;
  thought: string;
  actionName: string | null;
  resultSummary: string;
}

export function ReplayPlayer({ taskId }: { taskId: string }) {
  const [steps, setSteps] = useState<ReplayStep[]>([]);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  // 拉取该任务的 step 事件
  useEffect(() => {
    let mounted = true;
    void window.islandAPI.queryAudit({ taskId, limit: 500 }).then((res) => {
      if (!mounted || !res.ok) return;
      const stepEvents = res.data
        .filter((ev: AuditRowPayload) => ev.kind === "step")
        .sort((a, b) => a.seq - b.seq)
        .map((ev) => {
          try {
            const d = JSON.parse(ev.detail) as Record<string, unknown>;
            return {
              index: Number(d.step ?? 0),
              thought: String(d.thought ?? ""),
              actionName: d.actionName ? String(d.actionName) : null,
              resultSummary: String(d.resultSummary ?? ""),
            } satisfies ReplayStep;
          } catch {
            return null;
          }
        })
        .filter((s): s is ReplayStep => s !== null && s.index > 0);
      setSteps(stepEvents);
      setCur(0);
    });
    return () => { mounted = false; };
  }, [taskId]);

  const step = useMemo(() => steps[cur], [steps, cur]);

  // 拉取当前步骤截图
  useEffect(() => {
    if (!step) return;
    let mounted = true;
    setLoading(true);
    setFrame(null);
    void window.islandAPI.replayImage(taskId, step.index)
      .then((res) => {
        if (mounted && res.ok) setFrame(res.data.dataUrl);
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [taskId, step]);

  // 播放循环
  const tick = useCallback(() => {
    setCur((c) => {
      if (c + 1 >= steps.length) { setPlaying(false); return c; }
      return c + 1;
    });
  }, [steps.length]);

  useEffect(() => {
    if (!playing) { if (timerRef.current) window.clearInterval(timerRef.current); return; }
    timerRef.current = window.setInterval(tick, 1400 / speed);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [playing, speed, tick]);

  return (
    <div className="flex h-full flex-col px-4 py-3">
      {/* 画面（C：加载骨架） */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border ig-border-line bg-black/40">
        {frame ? (
          <img src={frame} alt={`步骤 ${step?.index ?? ""} 截图`} className="h-full w-full object-contain" draggable={false} />
        ) : steps.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] t-faint">无可回放步骤</div>
        ) : (
          <div className="island-skeleton flex h-full w-full items-center justify-center ig-bg-panel">
            <span className="text-[11px] t-faint">
              {loading ? "加载步骤截图…" : "该步骤无截图"}
            </span>
          </div>
        )}
        {/* 字幕 */}
        {step && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6">
            <div className="flex items-center gap-2">
              <span className="rounded ig-bg-panel-hover px-1.5 py-0.5 text-[10px] font-semibold t-strong">#{step.index}</span>
              <span className="text-[10.5px] t-body">{step.actionName ?? "思考"}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10px] t-muted">{step.resultSummary || step.thought}</div>
          </div>
        )}
      </div>

      {/* 控制条 */}
      <div className="mt-2 flex items-center gap-2">
        <button
          data-interactive
          className="island-btn island-btn--ghost h-7 px-2.5 text-[11px]"
          disabled={steps.length === 0}
          onClick={() => (playing ? setPlaying(false) : (setCur(0), setPlaying(true)))}
        >
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <button
          data-interactive
          className="island-btn island-btn--ghost h-7 px-2 text-[11px]"
          disabled={cur === 0}
          onClick={() => setCur((c) => Math.max(0, c - 1))}
        >
          ◀
        </button>
        <button
          data-interactive
          className="island-btn island-btn--ghost h-7 px-2 text-[11px]"
          disabled={cur >= steps.length - 1}
          onClick={() => setCur((c) => Math.min(steps.length - 1, c + 1))}
        >
          ▶
        </button>
        {/* 进度条 */}
        <input
          type="range"
          min={0}
          max={Math.max(0, steps.length - 1)}
          value={cur}
          data-interactive
          onChange={(e) => setCur(Number(e.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full ig-bg-panel-hover accent-[#2e7cf6]"
        />
        <span className="shrink-0 text-[10px] tabular-nums t-muted">
          {steps.length === 0 ? "0/0" : `${cur + 1}/${steps.length}`}
        </span>
        <button
          data-interactive
          className="island-btn island-btn--ghost h-7 px-2 text-[10px]"
          onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 0.5 : 1))}
        >
          {speed}x
        </button>
      </div>
    </div>
  );
}
