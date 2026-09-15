/**
 * MissionDetail.tsx — 任务详情（子任务列表 + 产物 + 状态操作）
 */
import { useIslandStore } from '../../../store/islandStore';
import { PlanConfirmCard } from './PlanConfirmCard';
import { MissionResolveBar } from './MissionResolveBar';
import type { SubtaskRowPayload, MissionArtifactRowPayload } from '@shared/island-contracts';

const SUBTASK_STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  awaiting_review: '待审核',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
};

/** 状态徽标统一走 ig-tag 语义色族（与长期任务徽标同一语言，停用/跳过取中性态） */
const SUBTASK_STATUS_TONE: Record<string, string> = {
  pending: 'ig-tone-muted',
  running: 'ig-tone-info',
  awaiting_review: 'ig-tone-warning',
  done: 'ig-tone-success',
  failed: 'ig-tone-danger',
  skipped: 'ig-tone-muted',
};

export function MissionDetail({ missionId }: { missionId: string }) {
  const detail = useIslandStore((s) => s.missionDetail);
  const loading = useIslandStore((s) => s.missionDetailLoading);
  const updateSubtaskStatus = useIslandStore((s) => s.updateSubtaskStatus);

  if (loading && !detail) {
    return <div className="island-skeleton h-24 rounded-xl ig-bg-panel" />;
  }

  if (!detail || detail.mission.id !== missionId) {
    return null;
  }

  const failedSubtasks = detail.subtasks.filter((st) => st.status === 'failed');

  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5 space-y-2 border-t ig-border-line">
      {/* 人在环闸：待确认计划卡 / 失败停等处置条 */}
      {detail.mission.status === 'awaiting_confirm' && <PlanConfirmCard mission={detail.mission} />}
      {detail.mission.status === 'paused' && failedSubtasks.length > 0 && (
        <MissionResolveBar missionId={detail.mission.id} failed={failedSubtasks} />
      )}

      <div className="text-[12px] t-strong font-medium">子任务 ({detail.subtasks.length})</div>

      {detail.subtasks.map((st, idx) => (
        <SubtaskRow
          key={st.id}
          subtask={st}
          index={idx}
          onUpdateStatus={async (status) => {
            await updateSubtaskStatus({ subtaskId: st.id, status });
          }}
        />
      ))}
    </div>
  );
}

function SubtaskRow({ subtask, index, onUpdateStatus }: {
  subtask: SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] };
  index: number;
  onUpdateStatus: (status: SubtaskRowPayload['status']) => Promise<void>;
}) {
  return (
    <div className="rounded-lg ig-bg-panel-hover px-2.5 py-2 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[12px] t-faint">#{index + 1}</span>
        <span className="text-[12px] t-strong line-clamp-1">{subtask.title}</span>
        <span
          className={`ig-tag ${SUBTASK_STATUS_TONE[subtask.status] ?? 'ig-tone-muted'} shrink-0 rounded-full px-1.5 py-0.5 text-[11px]`}
        >
          {SUBTASK_STATUS_LABEL[subtask.status] ?? subtask.status}
        </span>
      </div>

      {subtask.instruction && (
        <div className="text-[12px] t-muted line-clamp-2">{subtask.instruction}</div>
      )}

      {subtask.capabilityId && (
        <div className="text-[11px] t-faint">能力卡: {subtask.capabilityId}</div>
      )}

      {/* 产物 */}
      {subtask.artifacts && subtask.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {subtask.artifacts.map((art) => (
            <span key={art.id} className="rounded ig-bg-panel px-1.5 py-0.5 text-[11px] t-faint">
              {art.label || art.path}
            </span>
          ))}
        </div>
      )}

      {/* 审核备注 */}
      {subtask.reviewNote && (
        <div className="text-[11px] t-muted">备注: {subtask.reviewNote}</div>
      )}

      {/* 状态操作 */}
      <div className="flex items-center gap-1">
        {subtask.status === 'pending' && (
          <button
            data-interactive
            className="island-btn island-btn--ghost text-[11px] px-1.5 py-0.5"
            onClick={() => void onUpdateStatus('running')}
          >
            开始
          </button>
        )}
        {(subtask.status === 'running' || subtask.status === 'awaiting_review') && (
          <>
            <button
              data-interactive
              className="island-btn island-btn--ghost text-[11px] px-1.5 py-0.5"
              onClick={() => void onUpdateStatus('done')}
            >
              完成
            </button>
            <button
              data-interactive
              className="island-btn island-btn--ghost text-[11px] px-1.5 py-0.5 ig-fg-danger"
              onClick={() => void onUpdateStatus('failed')}
            >
              失败
            </button>
            <button
              data-interactive
              className="island-btn island-btn--ghost text-[11px] px-1.5 py-0.5"
              onClick={() => void onUpdateStatus('skipped')}
            >
              跳过
            </button>
          </>
        )}
      </div>
    </div>
  );
}
