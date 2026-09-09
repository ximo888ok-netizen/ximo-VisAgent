/**
 * EvolutionPanel.tsx — 演化面板编排层
 *
 * Tab 切换：世界模型 | 宪法门
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { MetaGateTab } from "./Evolution/MetaGateTab";
import { WorldModelInline } from "./Evolution/WorldModelInline";

type EvoTab = "worldmodel" | "meta";

const TABS: { key: EvoTab; label: string }[] = [
  { key: "worldmodel", label: "世界模型" },
  { key: "meta", label: "宪法门" },
];

export function EvolutionPanel() {
  const envFacts = useIslandStore((s) => s.envFacts);
  const loadEnvFacts = useIslandStore((s) => s.loadEnvFacts);
  const [tab, setTab] = useState<EvoTab>("worldmodel");

  useEffect(() => {
    void loadEnvFacts();
  }, [loadEnvFacts]);

  return (
    <div className="flex h-full flex-col px-4 py-3">
      {/* Tab 切换 */}
      <div className="mb-2 flex gap-1 overflow-x-auto island-panel-scroll">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-interactive
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] transition ${
              tab === t.key ? "ig-bg-panel-hover t-strong" : "t-muted hover:t-body"
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className="island-panel-scroll min-h-0 flex-1">
        {tab === "worldmodel" && <WorldModelInline envFacts={envFacts} />}
        {tab === "meta" && <MetaGateTab />}
      </div>
    </div>
  );
}

