/**
 * PanelContainer.tsx — 面板容器（Tab 切换 + 面板内容路由）
 *
 * 职责：根据 panelMode 渲染对应面板，管理 Tab 条交互。
 * 审批态时不渲染 Tab（审批卡独占展开区）。
 */
import { useIslandStore } from "../../store/islandStore";
import { LogPanel } from "../Panel/LogPanel";
import { TaskPanel } from "../Panel/TaskPanel";
import { SettingsPanel } from "../Panel/SettingsPanel";
import { AuditPanel } from "../Panel/AuditPanel";
import type { PanelMode } from "@shared/island-contracts";

const TABS: { mode: PanelMode; label: string; icon: string }[] = [
  { mode: "task", label: "任务", icon: "task" },
  { mode: "log", label: "日志", icon: "log" },
  { mode: "settings", label: "设置", icon: "settings" },
  { mode: "audit", label: "审计", icon: "audit" },
];

export function PanelContainer({ height }: { height: number }) {
  const panelMode = useIslandStore((s) => s.panelMode);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);

  const tabHeight = 32;
  const contentHeight = height - tabHeight - 1;

  return (
    <div className="island-expand-anim" style={{ height }}>
      {/* Tab 条 */}
      <div className="island-tabs" style={{ height: tabHeight }}>
        {TABS.map((tab) => {
          const active = panelMode === tab.mode;
          return (
            <button
              key={tab.mode}
              data-interactive
              className={`island-tab ${active ? "island-tab--active" : ""}`}
              onClick={() => setPanelMode(tab.mode)}
            >
              <TabIcon name={tab.icon} />
              <span className="ml-1.5">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* 面板内容 */}
      <div
        className="island-panel-scroll island-panel-enter"
        style={{ height: contentHeight }}
      >
        {panelMode === "task" && <TaskPanel />}
        {panelMode === "log" && <LogPanel />}
        {panelMode === "settings" && <SettingsPanel />}
        {panelMode === "audit" && <AuditPanel />}
      </div>
    </div>
  );
}

/** Tab 图标（SVG 内联，小尺寸） */
function TabIcon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    style: { display: "inline-block", verticalAlign: "-2px" },
  } as const;
  switch (name) {
    case "task":
      return (
        <svg {...common}>
          <path d="M3 4h10M3 8h7M3 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "log":
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h6M5 8.5h4M5 11h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "audit":
      return (
        <svg {...common}>
          <path d="M2.5 3.5h8.5v9h-8.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M11.5 5.5h2v5.5a1.5 1.5 0 01-1.5 1.5 1.5 1.5 0 01-1.5-1.5V5.5h1z" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 6.5h4.5M4.5 8.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}
