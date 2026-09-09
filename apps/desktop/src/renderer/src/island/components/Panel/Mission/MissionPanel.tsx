/**
 * MissionPanel.tsx — 任务知识库面板（能力卡 + 任务双 Tab）
 *
 * 编排层：顶部 Tab 切换 → 能力卡列表 / 任务列表
 */
import { useEffect, useState } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import { CapabilityList } from './CapabilityList';
import { MissionList } from './MissionList';

type Tab = 'capabilities' | 'missions';

export function MissionPanel() {
  const [tab, setTab] = useState<Tab>('capabilities');
  const loadCapabilities = useIslandStore((s) => s.loadCapabilities);
  const loadMissions = useIslandStore((s) => s.loadMissions);

  useEffect(() => {
    if (tab === 'capabilities') {
      void loadCapabilities();
    } else {
      void loadMissions();
    }
  }, [tab, loadCapabilities, loadMissions]);

  return (
    <div className="flex h-full flex-col px-4 py-3">
      {/* Tab 切换 */}
      <div className="mb-3 flex items-center gap-1.5">
        <TabButton active={tab === 'capabilities'} onClick={() => setTab('capabilities')}>
          能力卡
        </TabButton>
        <TabButton active={tab === 'missions'} onClick={() => setTab('missions')}>
          任务
        </TabButton>
      </div>

      {/* 内容区 */}
      <div className="island-panel-scroll min-h-0 flex-1">
        {tab === 'capabilities' && <CapabilityList />}
        {tab === 'missions' && <MissionList />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      data-interactive
      className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
        active ? 'ig-bg-panel-hover t-strong' : 't-muted hover:t-body'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
