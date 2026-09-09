/**
 * MissionList.tsx — 任务列表（创建 + 列表 + 详情）
 */
import { useState } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import { MissionDetail } from './MissionDetail';
import type { MissionRowPayload } from '@shared/island-contracts';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队中',
  running: '执行中',
  paused: '暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_COLOR: Record<string, string> = {
  draft: '#8b8b8b',
  queued: '#fbbf24',
  running: '#3b82f6',
  paused: '#f87171',
  completed: '#3fe0a0',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

const PRIORITY_LABEL: Record<string, string> = {
  low: '低',
  normal: '中',
  high: '高',
  urgent: '紧急',
};

export function MissionList() {
  const missions = useIslandStore((s) => s.missions);
  const loading = useIslandStore((s) => s.missionsLoading);
  const loadMissions = useIslandStore((s) => s.loadMissions);
  const createMission = useIslandStore((s) => s.createMission);
  const loadMissionDetail = useIslandStore((s) => s.loadMissionDetail);

  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleSelect = async (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
    if (selectedId !== id) {
      void loadMissionDetail(id);
    }
  };

  if (showCreate) {
    return (
      <MissionCreateForm
        onDone={() => setShowCreate(false)}
        onCreate={async (goal, subtasks) => {
          const id = await createMission({
            goal,
            origin: 'manual',
            priority: 'normal',
            subtasks: subtasks.map((t) => ({
              title: t,
              instruction: '',
              capabilityId: null,
            })),
          });
          if (id) {
            setShowCreate(false);
            void loadMissions();
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <button
        data-interactive
        className="island-btn island-btn--primary w-full text-[10.5px]"
        onClick={() => setShowCreate(true)}
      >
        + 新建任务
      </button>

      {loading && missions.length === 0 && (
        <div className="island-skeleton h-16 rounded-xl ig-bg-panel" />
      )}

      {missions.length === 0 && !loading && (
        <div className="py-8 text-center text-[11px] t-faint">
          还没有任务。点击「新建任务」创建第一个任务。
        </div>
      )}

      {missions.map((m) => (
        <MissionRow
          key={m.id}
          mission={m}
          expanded={selectedId === m.id}
          onSelect={() => handleSelect(m.id)}
        />
      ))}

      {selectedId && <MissionDetail missionId={selectedId} />}
    </div>
  );
}

function MissionRow({ mission, expanded, onSelect }: {
  mission: MissionRowPayload;
  expanded: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] t-strong font-medium line-clamp-1">{mission.goal}</span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[9px] flex-shrink-0"
          style={{ background: `${STATUS_COLOR[mission.status]}20`, color: STATUS_COLOR[mission.status] }}
        >
          {STATUS_LABEL[mission.status] ?? mission.status}
        </span>
        <button
          data-interactive
          className="ml-auto text-[10px] t-muted hover:t-body"
          onClick={onSelect}
        >
          {expanded ? '收起' : '详情'}
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[9px] t-faint">
        <span>{PRIORITY_LABEL[mission.priority] ?? mission.priority}</span>
        <span>{new Date(mission.createdAt).toLocaleString()}</span>
      </div>
    </div>
  );
}

function MissionCreateForm({ onDone, onCreate }: {
  onDone: () => void;
  onCreate: (goal: string, subtasks: string[]) => Promise<void>;
}) {
  const [goal, setGoal] = useState('');
  const [subtaskText, setSubtaskText] = useState('');
  const [saving, setSaving] = useState(false);

  const subtasks = subtaskText.split('\n').map((s) => s.trim()).filter(Boolean);

  const handleCreate = async () => {
    if (!goal.trim() || subtasks.length === 0) return;
    setSaving(true);
    await onCreate(goal.trim(), subtasks);
    setSaving(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] t-strong font-medium">新建任务</span>
        <button
          data-interactive
          className="ml-auto text-[10px] t-muted hover:t-body"
          onClick={onDone}
        >
          取消
        </button>
      </div>
      <input
        data-interactive
        className="island-input w-full text-[10.5px]"
        placeholder="任务目标（如：整理本周销售数据到 Excel）"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <textarea
        data-interactive
        className="island-input w-full text-[10.5px] resize-none"
        rows={4}
        placeholder={'子任务（每行一个）\n如：\n打开销售数据 Excel\n筛选本周数据\n填充汇总公式'}
        value={subtaskText}
        onChange={(e) => setSubtaskText(e.target.value)}
      />
      <div className="text-[9px] t-faint">{subtasks.length} 个子任务</div>
      <button
        data-interactive
        className="island-btn island-btn--primary w-full text-[10.5px]"
        onClick={handleCreate}
        disabled={saving || !goal.trim() || subtasks.length === 0}
      >
        {saving ? '创建中...' : '创建任务'}
      </button>
    </div>
  );
}
