/**
 * PanelContainer.tsx — 面板容器（竖向侧边栏导航 + 内容路由 + 二级视图栈）
 *
 * 职责：根据 panelMode 渲染对应面板；viewStack 非空时渲染二级 push 视图。
 * 审批态时不渲染导航（审批卡独占展开区）。
 */
import { useIslandStore } from "../../store/islandStore";
import { TabIcon } from "./TabIcons";
import { LogPanel } from "../Panel/LogPanel";
import { TaskPanel } from "../Panel/Task/TaskPanel";
import { SettingsPanel } from "../Panel/SettingsPanel";
import { AuditPanel } from "../Panel/AuditPanel";
import { EvolutionPanel } from "../Panel/EvolutionPanel";
import { HistoryPanel } from "../Panel/HistoryPanel";
import { SopPanel } from "../Panel/SopPanel";
import { StatsPanel } from "../Panel/StatsPanel";
import { SchedulePanel } from "../Panel/SchedulePanel";
import { EmployeePanel } from "../Panel/Employee/EmployeePanel";
import { MissionPanel } from "../Panel/Mission/MissionPanel";
import { StepDetailSheet } from "../Panel/Task/StepDetailSheet";
import { TaskDetailSheet } from "../Panel/History/TaskDetailSheet";
import { ReplayPlayer } from "../Panel/History/ReplayPlayer";
import { SopRunSheet } from "../Panel/Sop/SopRunSheet";
import type { PanelMode } from "@shared/island-contracts";

/** 导航分组：工作区 / 库 / 系统（面板增多后分组呈现） */
const TAB_GROUPS: { mode: PanelMode; label: string; icon: string }[][] = [
  [
    { mode: "task", label: "任务", icon: "task" },
  ],
  [
    { mode: "history", label: "历史", icon: "history" },
    { mode: "sop", label: "SOP", icon: "sop" },
    { mode: "schedule", label: "定时", icon: "schedule" },
    { mode: "stats", label: "统计", icon: "stats" },
  ],
  [
    { mode: "evolution", label: "演化", icon: "evolution" },
    { mode: "employee", label: "员工", icon: "employee" },
    { mode: "mission", label: "任务库", icon: "mission" },
    { mode: "log", label: "日志", icon: "log" },
    { mode: "settings", label: "设置", icon: "settings" },
    { mode: "audit", label: "审计", icon: "audit" },
  ],
];

/** 竖向导航栏宽度（含文字标签后加宽） */
const NAV_WIDTH = 64;

export function PanelContainer() {
  const panelMode = useIslandStore((s) => s.panelMode);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);
  const viewStack = useIslandStore((s) => s.viewStack);
  const popView = useIslandStore((s) => s.popView);

  const topView = viewStack[viewStack.length - 1];

  return (
    <div className="island-expand-anim h-full flex flex-row">
      {/* 竖向导航栏 */}
      <div
        className="island-nav-bar flex flex-col items-center gap-1 border-r ig-border-line py-2"
        style={{ width: NAV_WIDTH, flexShrink: 0 }}
      >
        {topView ? (
          /* 二级视图时显示返回按钮 */
          <button
            data-interactive
            className="island-nav-item island-nav-item--active"
            onClick={popView}
            title="返回"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          TAB_GROUPS.map((group, gi) => (
            <div key={gi} className="flex flex-col items-center gap-1">
              {gi > 0 && <span className="my-1 h-px w-5 ig-bg-panel-hover" />}
              {group.map((tab) => {
                const active = panelMode === tab.mode;
                return (
                  <button
                    key={tab.mode}
                    data-interactive
                    className={`island-nav-item island-nav-item--labeled ${active ? "island-nav-item--active" : ""}`}
                    onClick={() => setPanelMode(tab.mode)}
                    title={tab.label}
                  >
                    <TabIcon name={tab.icon} />
                    <span className="island-nav-label">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* 面板内容区 */}
      <div className="island-panel-scroll flex-1 min-h-0 min-w-0">
        {topView ? (
          <div key={viewStack.length} className="island-view-push h-full">
            {topView.kind === "stepDetail" && <StepDetailSheet stepIndex={topView.stepIndex} />}
            {topView.kind === "taskDetail" && <TaskDetailSheet taskId={topView.taskId} />}
            {topView.kind === "replay" && <ReplayPlayer taskId={topView.taskId} />}
            {topView.kind === "sopRun" && <SopRunSheet sopId={topView.sopId} />}
            {topView.kind === "evidence" && <AuditPanel />}
          </div>
        ) : (
          <div key={panelMode} className="island-panel-enter h-full">
            {panelMode === "task" && <TaskPanel />}
            {panelMode === "history" && <HistoryPanel />}
            {panelMode === "sop" && <SopPanel />}
            {panelMode === "schedule" && <SchedulePanel />}
            {panelMode === "stats" && <StatsPanel />}
            {panelMode === "log" && <LogPanel />}
            {panelMode === "settings" && <SettingsPanel />}
            {panelMode === "audit" && <AuditPanel />}
            {panelMode === "evolution" && <EvolutionPanel />}
            {panelMode === "employee" && <EmployeePanel />}
            {panelMode === "mission" && <MissionPanel />}
          </div>
        )}
      </div>
    </div>
  );
}
