/**
 * MissionResolveBar.tsx — 暂停 Mission 的人工处置条（mission-plan §4.3 失败停等）
 *
 * paused 且有失败子任务时展示「重试 / 跳过 / 终止」，全部走 mission-resolve 通道：
 * retry 重开失败子任务 / skip 跳过放行下游 / abort 终止整个 Mission。
 * 失败不自动重试是执行侧不变量——这里就是那个人。终止不可逆，两步武装防误点。
 */
import { useEffect, useState } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import type { MissionResolveDecision, SubtaskRowPayload } from '@shared/island-contracts';

const ABORT_ARM_WINDOW_MS = 6000;

export function MissionResolveBar({ missionId, failed }: {
  missionId: string;
  failed: SubtaskRowPayload[];
}) {
  const [busy, setBusy] = useState(false);
  const [abortArmed, setAbortArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveMission = useIslandStore((s) => s.resolveMission);
  const pushToast = useIslandStore((s) => s.pushToast);

  useEffect(() => {
    if (!abortArmed) return;
    const t = window.setTimeout(() => setAbortArmed(false), ABORT_ARM_WINDOW_MS);
    return () => window.clearTimeout(t);
  }, [abortArmed]);

  if (failed.length === 0) return null;

  const act = async (decision: MissionResolveDecision) => {
    setBusy(true);
    setError(null);
    const fail = await resolveMission(missionId, decision);
    setBusy(false);
    if (fail) {
      setError(fail);
      return;
    }
    pushToast('success', decision === 'retry' ? '已重试失败子任务' : decision === 'skip' ? '已跳过失败子任务，继续执行' : 'Mission 已终止');
  };

  const handleAbort = () => {
    if (!abortArmed) {
      setAbortArmed(true);
      return;
    }
    void act('abort');
  };

  return (
    <div className="rounded-xl ig-alert ig-tone-danger px-3 py-2.5 space-y-2 border-t ig-border-line">
      <div className="text-[12px] t-strong font-medium">子任务失败 · Mission 已停等人工</div>
      <div className="text-[11px] t-muted">
        {failed.map((f) => f.title).join('、')}
      </div>
      <div className="text-[11px] t-faint">失败不会自动重试：重试＝重开该子任务；跳过＝放弃它并放行下游；终止＝整个 Mission 作废。</div>

      {error && (
        <div className="ig-alert ig-tone-warning rounded-lg px-2 py-1.5 text-[11px] ig-fg-warning">
          处置失败：{error}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          data-interactive
          disabled={busy}
          className="island-btn island-btn--primary text-[12px]"
          onClick={() => void act('retry')}
        >
          重试
        </button>
        <button
          data-interactive
          disabled={busy}
          className="island-btn island-btn--ghost text-[12px]"
          onClick={() => void act('skip')}
        >
          跳过
        </button>
        <button
          data-interactive
          disabled={busy}
          className={`island-btn text-[12px] ml-auto ${abortArmed ? 'island-btn--danger' : 'island-btn--ghost ig-fg-danger'}`}
          onClick={handleAbort}
        >
          {abortArmed ? '再点一次：确认终止' : '终止'}
        </button>
      </div>
    </div>
  );
}
