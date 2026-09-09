/**
 * CapabilityList.tsx — 能力卡列表（搜索 + 种子导入 + 创建）
 */
import { useState, useCallback } from 'react';
import { useIslandStore } from '../../../store/islandStore';
import { CapabilityCard } from './CapabilityCard';

export function CapabilityList() {
  const capabilities = useIslandStore((s) => s.capabilities);
  const loading = useIslandStore((s) => s.capabilitiesLoading);
  const loadCapabilities = useIslandStore((s) => s.loadCapabilities);
  const seedCapabilities = useIslandStore((s) => s.seedCapabilities);
  const matchCapabilities = useIslandStore((s) => s.matchCapabilities);
  const capMatchResult = useIslandStore((s) => s.capMatchResult);
  const capMatchLoading = useIslandStore((s) => s.capMatchLoading);

  const [query, setQuery] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [showMatch, setShowMatch] = useState(false);
  const [matchGoal, setMatchGoal] = useState('');

  const handleSearch = useCallback(() => {
    void loadCapabilities(query.trim() ? { query: query.trim() } : {});
  }, [query, loadCapabilities]);

  const handleSeed = async () => {
    setSeeding(true);
    const result = await seedCapabilities();
    setSeeding(false);
    if (result.imported > 0) {
      console.log(`[mission] 种子导入: ${result.imported} 张能力卡`);
    }
  };

  const handleMatch = async () => {
    if (!matchGoal.trim()) return;
    setShowMatch(true);
    void matchCapabilities(matchGoal.trim());
  };

  return (
    <div className="space-y-2">
      {/* 搜索栏 */}
      <div className="flex items-center gap-1.5">
        <input
          data-interactive
          className="island-input flex-1 text-[11px]"
          placeholder="搜索能力卡..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
        />
        <button
          data-interactive
          className="island-btn island-btn--ghost text-[10.5px]"
          onClick={handleSearch}
        >
          搜索
        </button>
        <button
          data-interactive
          className="island-btn island-btn--ghost text-[10.5px]"
          onClick={handleSeed}
          disabled={seeding}
        >
          {seeding ? '导入中...' : '重置种子'}
        </button>
      </div>

      {/* 能力匹配 */}
      <div className="rounded-xl ig-bg-panel px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <input
            data-interactive
            className="island-input flex-1 text-[10.5px]"
            placeholder="输入任务目标，匹配能力卡..."
            value={matchGoal}
            onChange={(e) => setMatchGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleMatch(); }}
          />
          <button
            data-interactive
            className="island-btn island-btn--ghost text-[10.5px]"
            onClick={handleMatch}
            disabled={capMatchLoading || !matchGoal.trim()}
          >
            {capMatchLoading ? '...' : '匹配'}
          </button>
        </div>
        {showMatch && capMatchResult && (
          <div className="mt-1.5 space-y-1">
            {capMatchResult.items.length === 0 ? (
              <div className="text-[10px] t-faint">无匹配能力卡</div>
            ) : (
              capMatchResult.items.map((item) => (
                <div key={item.capabilityId} className="flex items-center gap-2 text-[10px]">
                  <span className="t-strong">{item.title}</span>
                  <span className="t-faint">{(item.score * 100).toFixed(0)}%</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 能力卡列表 */}
      {loading && capabilities.length === 0 && (
        <div className="island-skeleton h-20 rounded-xl ig-bg-panel" />
      )}

      {capabilities.length === 0 && !loading && (
        <div className="py-8 text-center text-[11px] t-faint">
          还没有能力卡。点击「重置种子」导入预设能力集。
        </div>
      )}

      {capabilities.map((cap) => (
        <CapabilityCard key={cap.id} cap={cap} />
      ))}
    </div>
  );
}
