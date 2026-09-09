/**
 * CapabilityCard.tsx — 单张能力卡（展开/收起详情 + 编辑）
 */
import { useState } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import type { CapabilityCardPayload } from '@shared/island-contracts';

const STATUS_LABEL: Record<string, string> = {
  active: '启用',
  retired: '退役',
};

const STATUS_COLOR: Record<string, string> = {
  active: '#3fe0a0',
  retired: '#6b7280',
};

export function CapabilityCard({ cap }: { cap: CapabilityCardPayload }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const updateCapability = useIslandStore((s) => s.updateCapability);

  const handleToggleStatus = async () => {
    await updateCapability({
      id: cap.id,
      status: cap.status === 'active' ? 'retired' : 'active',
    });
  };

  if (editing) {
    return (
      <CapabilityEditForm
        cap={cap}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] t-strong font-medium">{cap.title}</span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[9px]"
          style={{ background: `${STATUS_COLOR[cap.status]}20`, color: STATUS_COLOR[cap.status] }}
        >
          {STATUS_LABEL[cap.status] ?? cap.status}
        </span>
        <span className="text-[9px] t-faint">{cap.source === 'seed' ? '种子' : '蒸馏'}</span>
        <button
          data-interactive
          className="ml-auto text-[10px] t-muted hover:t-body"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '详情'}
        </button>
        <button
          data-interactive
          className="text-[10px] text-blue-300/70 hover:text-blue-300"
          onClick={() => setEditing(true)}
        >
          编辑
        </button>
      </div>

      <div className="mt-0.5 text-[10px] t-muted line-clamp-2">{cap.description}</div>

      {cap.tools.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {cap.tools.map((tool, i) => (
            <span key={i} className="rounded ig-bg-panel-hover px-1.5 py-0.5 text-[9px] t-faint">
              {tool}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t ig-border-line pt-2 text-[10px]">
          {cap.precondition && (
            <div>
              <span className="t-faint">前置条件: </span>
              <span className="t-muted">{cap.precondition}</span>
            </div>
          )}
          {cap.acceptance && (
            <div>
              <span className="t-faint">验收标准: </span>
              <span className="t-muted">{cap.acceptance}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span className="t-faint">使用 {cap.usageCount} 次</span>
            <span className="t-faint">失败 {cap.failCount} 次</span>
            <button
              data-interactive
              className="ml-auto text-[10px] t-muted hover:t-body"
              onClick={handleToggleStatus}
            >
              {cap.status === 'active' ? '退役' : '启用'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CapabilityEditForm({ cap, onDone }: { cap: CapabilityCardPayload; onDone: () => void }) {
  const updateCapability = useIslandStore((s) => s.updateCapability);
  const [title, setTitle] = useState(cap.title);
  const [description, setDescription] = useState(cap.description);
  const [precondition, setPrecondition] = useState(cap.precondition);
  const [acceptance, setAcceptance] = useState(cap.acceptance);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await updateCapability({
      id: cap.id,
      title,
      description,
      precondition,
      acceptance,
    });
    setSaving(false);
    onDone();
  };

  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] t-strong font-medium">编辑能力卡</span>
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
        placeholder="标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        data-interactive
        className="island-input w-full text-[10.5px] resize-none"
        rows={2}
        placeholder="描述"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        data-interactive
        className="island-input w-full text-[10.5px]"
        placeholder="前置条件"
        value={precondition}
        onChange={(e) => setPrecondition(e.target.value)}
      />
      <input
        data-interactive
        className="island-input w-full text-[10.5px]"
        placeholder="验收标准"
        value={acceptance}
        onChange={(e) => setAcceptance(e.target.value)}
      />
      <button
        data-interactive
        className="island-btn island-btn--primary w-full text-[10.5px]"
        onClick={handleSave}
        disabled={saving || !title.trim()}
      >
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  );
}
