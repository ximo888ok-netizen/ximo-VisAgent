/**
 * StepDetailSheet.tsx — 步骤详情二级视图（参数 JSON + 执行截图证据）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";

export function StepDetailSheet({ stepIndex }: { stepIndex: number }) {
  const steps = useIslandStore((s) => s.steps);
  const taskId = useIslandStore((s) => s.currentTaskId);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const step = steps.find((s) => s.index === stepIndex);

  useEffect(() => {
    let mounted = true;
    setEvidence(null);
    if (!taskId || !step) return;
    setLoading(true);
    void window.islandAPI.replayImage(taskId, step.index)
      .then((res) => {
        if (mounted && res.ok) setEvidence(res.data.dataUrl);
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [taskId, step]);

  if (!step) {
    return <div className="px-5 py-4 text-[12px] t-muted">步骤 #{stepIndex} 不在当前会话中（重启后请到历史面板查看）</div>;
  }

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold t-strong">步骤 #{step.index} 详情</h3>
        <span className={`text-[10.5px] ${step.ok === false ? "text-red-300" : "text-emerald-300/80"}`}>
          {step.ok === false ? "失败" : step.ok ? "成功" : "—"}
          {step.durationMs !== undefined && ` · ${(step.durationMs / 1000).toFixed(1)}s`}
        </span>
      </div>

      {/* 思考 */}
      <section>
        <div className="island-label mb-1">Thought</div>
        <div className="rounded-lg ig-bg-panel px-3 py-2 text-[11.5px] leading-relaxed t-body">
          {step.thought || "(空)"}
        </div>
      </section>

      {/* 动作 */}
      {step.actionName && (
        <section>
          <div className="island-label mb-1">动作 · {step.actionName}{step.level !== undefined && ` · L${step.level}`}</div>
          <pre className="overflow-auto rounded-lg bg-black/30 px-3 py-2 text-[10.5px] leading-relaxed t-body" style={{ maxHeight: 120 }}>
            {JSON.stringify(step.args ?? {}, null, 2)}
          </pre>
        </section>
      )}

      {/* 结果 */}
      <section>
        <div className="island-label mb-1">结果</div>
        <div className={`rounded-lg px-3 py-2 text-[11.5px] leading-relaxed ${step.ok === false ? "bg-red-500/[0.07] text-red-200/85" : "ig-bg-panel t-body"}`}>
          {step.resultSummary || "(空)"}
        </div>
      </section>

      {/* 执行前证据截图 */}
      <section>
        <div className="island-label mb-1">执行前证据截图</div>
        {loading ? (
          <div className="island-skeleton h-40 rounded-lg ig-bg-panel" />
        ) : evidence ? (
          <img src={evidence} alt={`步骤 ${step.index} 执行前截图`} className="w-full rounded-lg border ig-border-line" />
        ) : (
          <div className="rounded-lg ig-bg-panel px-3 py-4 text-center text-[10.5px] t-faint">
            该步骤无证据截图（仅 L1 以上操作与审批前会留证）
          </div>
        )}
      </section>
    </div>
  );
}
