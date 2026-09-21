/**
 * StepStream.tsx — 步骤对话流（Agent 思考 + 动作结果 + 截图缩略图）
 */
import { useState, useCallback } from "react";
import type { StepDetailEvent } from "@shared/island-contracts";

export function StepStream({ steps }: { steps: StepDetailEvent[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <StepItem key={i} step={step} stepNum={i + 1} />
      ))}
    </div>
  );
}

function StepItem({ step, stepNum }: { step: StepDetailEvent; stepNum: number }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbLoading, setThumbLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadThumb = useCallback(async () => {
    if (thumbUrl || thumbLoading) return;
    setThumbLoading(true);
    try {
      const res = await window.islandAPI.replayImage(step.taskId, step.index);
      if (res.ok && res.data.dataUrl) setThumbUrl(res.data.dataUrl);
    } catch { /* 无截图静默 */ }
    setThumbLoading(false);
  }, [step.taskId, step.index, thumbUrl, thumbLoading]);

  return (
    <div className="island-fade-up flex gap-2.5" style={{ animationDelay: `${Math.min(stepNum * 30, 200)}ms` }}>
      <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full ig-bg-panel grid place-items-center text-[12px] t-muted">
        {stepNum}
      </div>
      <div className="flex-1 min-w-0">
        {step.thought && (
          <div className="text-[12px] leading-snug t-body">{step.thought}</div>
        )}
        {step.actionName && (
          <div className="mt-0.5 text-[12px] t-faint">
            <span style={{ color: step.ok === false ? "var(--c-error)" : "var(--c-thinking)" }}>
              {step.actionName}
            </span>
            {step.resultSummary && (
              <span className="ml-2 t-muted">{step.resultSummary}</span>
            )}
          </div>
        )}
        {/* 截图缩略图：点击展开异步加载证据截图 */}
        <button
          onClick={() => { setExpanded(!expanded); if (!expanded) void loadThumb(); }}
          className="mt-1 text-[11px] t-faint hover:t-muted transition-colors"
        >
          {expanded ? "▾ 收起截图" : "▸ 查看截图"}
        </button>
        {expanded && (
          <div className="mt-1.5">
            {thumbLoading ? (
              <div className="island-skeleton h-24 rounded-lg ig-bg-panel" />
            ) : thumbUrl ? (
              <img src={thumbUrl} alt={`步骤 ${step.index} 截图`} className="w-full rounded-lg border ig-border-line" />
            ) : (
              <div className="rounded-lg ig-bg-panel px-3 py-2 text-center text-[11px] t-faint">
                无证据截图
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
