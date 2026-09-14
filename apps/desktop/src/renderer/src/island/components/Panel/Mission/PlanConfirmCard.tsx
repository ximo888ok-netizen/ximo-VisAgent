/**
 * PlanConfirmCard.tsx — 计划确认卡（人在环关键闸，mission-plan §4.3）
 *
 * awaiting_confirm 的 Mission：展示 plan_json 子任务计划（标题/依赖/风险），
 * 「确认执行」走 mission-confirm（确认前主进程绝不派发）；「驳回」收卡停等。
 * 交互从审批场景出发：一眼看懂确认什么（逐条计划）、影响什么（确认后立即派发），
 * 确认按钮两步武装防误点；风险 L2/L3 与能力缺口显式标色。
 */
import { useEffect, useState } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import { MissionPlanSchema } from '@shared/island-contracts';
import type { MissionRowPayload } from '@shared/island-contracts';

const RISK_STYLE: Record<string, { label: string; className: string }> = {
  L0: { label: 'L0 低风险', className: 'ig-tag ig-tone-success' },
  L1: { label: 'L1 低风险', className: 'ig-tag ig-tone-info' },
  L2: { label: 'L2 高风险', className: 'ig-tag ig-tone-warning' },
  L3: { label: 'L3 高风险', className: 'ig-tag ig-tone-danger' },
};

/** 两步确认的武装有效期：超时自动解除，避免放置后被顺手点掉 */
const ARM_WINDOW_MS = 6000;

export function PlanConfirmCard({ mission }: { mission: MissionRowPayload }) {
  const [plan, setPlan] = useState<ReturnType<typeof parsePlan>>('invalid');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmMission = useIslandStore((s) => s.confirmMission);
  const dismissed = useIslandStore((s) => s.planDismissedIds.includes(mission.id));
  const dismiss = useIslandStore((s) => s.dismissPlanConfirm);
  const restore = useIslandStore((s) => s.restorePlanConfirm);
  const pushToast = useIslandStore((s) => s.pushToast);

  useEffect(() => {
    setPlan(parsePlan(mission.planJson));
  }, [mission.planJson]);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => window.clearTimeout(t);
  }, [armed]);

  if (dismissed) {
    return (
      <div className="rounded-xl ig-bg-panel px-3 py-2.5 space-y-1.5 border-t ig-border-line">
        <div className="text-[12px] t-muted">
          已驳回执行计划：Mission「{mission.goal}」停等「待确认」，不会派发任何子任务。
        </div>
        <button
          data-interactive
          className="island-btn island-btn--ghost text-[11px] h-6 px-2"
          onClick={() => restore(mission.id)}
        >
          重新查看计划
        </button>
      </div>
    );
  }

  const handleConfirmClick = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    const fail = await confirmMission(mission.id);
    setBusy(false);
    setArmed(false);
    if (fail) setError(fail);
    else pushToast('success', '计划已确认，开始按依赖顺序派发子任务');
  };

  return (
    <div className="rounded-xl ig-alert ig-tone-warning px-3 py-2.5 space-y-2 border-t ig-border-line">
      <div className="flex items-center gap-2">
        <span className="text-[13px] t-strong font-medium">计划确认 · 人工闸</span>
        <span className="ig-tag ig-tone-warning rounded-full px-1.5 py-0.5 text-[11px]">待你确认</span>
      </div>
      <div className="text-[11px] t-muted">
        确认后 Mission「{mission.goal}」立即按依赖顺序派发下列子任务（动作级审批照走）；不确认则绝不执行。
      </div>

      {plan === 'invalid' ? (
        <div className="text-[12px] ig-fg-warning">计划数据无法解析，请勿确认，先到任务详情核对。</div>
      ) : (
        <ol className="space-y-1.5">
          {plan.subtasks.map((st, idx) => {
            const risk = st.risk ? RISK_STYLE[st.risk] : undefined;
            const deps = st.dependsOn
              .map((depId) => plan.subtasks.find((n) => n.id === depId)?.goal ?? depId)
              .join('、');
            return (
              <li key={st.id} className="rounded-lg ig-bg-panel px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] t-faint t-num">#{idx + 1}</span>
                  <span className="text-[12px] t-strong">{st.goal}</span>
                  {risk && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[11px] ${risk.className}`}>{risk.label}</span>
                  )}
                  {!st.capabilityId && (
                    <span className="ig-tag ig-tone-danger rounded-full px-1.5 py-0.5 text-[11px]">能力缺口</span>
                  )}
                </div>
                {deps && <div className="mt-0.5 text-[11px] t-faint">依赖：{deps}</div>}
              </li>
            );
          })}
        </ol>
      )}

      {error && (
        <div className="ig-alert ig-tone-danger rounded-lg px-2 py-1.5 text-[11px] ig-fg-danger">
          确认失败：{error}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          data-interactive
          disabled={busy || plan === 'invalid'}
          className={`island-btn text-[12px] ${armed ? 'island-btn--danger' : 'island-btn--primary'}`}
          onClick={() => void handleConfirmClick()}
        >
          {busy ? '提交中…' : armed ? '再点一次：确认并开始执行' : '确认执行'}
        </button>
        <button
          data-interactive
          disabled={busy}
          className="island-btn island-btn--ghost text-[12px]"
          onClick={() => dismiss(mission.id)}
        >
          驳回（不执行）
        </button>
        {armed && !busy && (
          <span className="text-[11px] ig-fg-danger">高危操作，再点一次生效</span>
        )}
      </div>
    </div>
  );
}

function parsePlan(planJson: string | null) {
  if (!planJson) return 'invalid' as const;
  try {
    return MissionPlanSchema.parse(JSON.parse(planJson));
  } catch {
    return 'invalid' as const;
  }
}
