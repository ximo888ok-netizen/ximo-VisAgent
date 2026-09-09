/**
 * StepStream.tsx — 步骤对话流（Agent 思考 + 动作结果）
 */
import type { StepDetailEvent } from "@shared/island-contracts";

export function StepStream({ steps }: { steps: StepDetailEvent[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="island-fade-up flex gap-2.5" style={{ animationDelay: `${Math.min(i * 30, 200)}ms` }}>
          <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full ig-bg-panel grid place-items-center text-[10px] t-muted">
            {i + 1}
          </div>
          <div className="flex-1 min-w-0">
            {step.thought && (
              <div className="text-[11px] leading-snug t-body">{step.thought}</div>
            )}
            {step.actionName && (
              <div className="mt-0.5 text-[10px] t-faint">
                <span style={{ color: step.ok === false ? "#f87171" : "#3fe0a0" }}>
                  {step.actionName}
                </span>
                {step.resultSummary && (
                  <span className="ml-2 t-muted">{step.resultSummary}</span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
