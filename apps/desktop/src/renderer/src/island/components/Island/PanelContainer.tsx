/**
 * PanelContainer.tsx — 面板容器（一级分组导航 + 上下文 chip 行 + 内容路由 + 二级视图栈）
 *
 * 导航分两级（2026-09 改造）：
 *   一级：4 组常驻（任务 / 自动 / 知识 / 系统），底部固定，不随面板增多而增长；
 *   二级：一级组内的上下文 chip 行，横向排布，不占竖向空间。
 *
 * 为什么改：改造前 11 项平铺需要 580px（11×46 + 组间 + 分隔线），而 520px 面板
 * 只有 456px 可用（520 − 顶栏 64），且导航区没有 overflow-y —— 底部「日志/设置/审计」
 * 落在窗口下缘之外，永远点不到。现在一级栏只需 4×44 + 3×4 + py 16 = 204px。
 *
 * 职责：根据 panelMode 渲染对应面板；viewStack 非空时渲染二级 push 视图。
 * 审批态时不渲染本容器（审批卡独占展开区，见 IslandShell）。
 */
import { useIslandStore } from "../../store/islandStore";
import { BackIcon, TabIcon } from "./TabIcons";
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

interface NavMode {
  readonly mode: PanelMode;
  readonly label: string;
}

interface NavGroup {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly modes: readonly NavMode[];
}

/**
 * 一级分组。硬约束：11 个 PanelMode 必须恰好出现一次，
 * 与 shared/schemas/panel-mode.ts 的 PANEL_MODES 保持一致
 * （task / schedule / stats / history / sop / mission / employee / settings / audit / log / evolution）。
 *
 * as const：让它成为定长元组，NAV_GROUPS[0] 在 noUncheckedIndexedAccess 下仍是非空类型。
 */
const NAV_GROUPS = [
  {
    key: "task",
    label: "任务",
    icon: "task",
    modes: [{ mode: "task", label: "任务" }],
  },
  {
    key: "auto",
    label: "自动",
    icon: "schedule",
    modes: [
      { mode: "schedule", label: "定时" },
      { mode: "stats", label: "统计" },
    ],
  },
  {
    key: "knowledge",
    label: "知识",
    icon: "mission",
    modes: [
      { mode: "history", label: "历史" },
      { mode: "sop", label: "SOP" },
      { mode: "mission", label: "任务库" },
      { mode: "employee", label: "员工" },
    ],
  },
  {
    key: "system",
    label: "系统",
    icon: "settings",
    modes: [
      { mode: "settings", label: "设置" },
      { mode: "audit", label: "审计" },
      { mode: "log", label: "日志" },
      { mode: "evolution", label: "演化" },
    ],
  },
] as const satisfies readonly NavGroup[];

/** 兜底分组（panelMode 必然是某一组的成员，此处仅为类型收敛） */
const DEFAULT_GROUP: NavGroup = NAV_GROUPS[0];

/** 竖向一级导航栏宽度 */
const NAV_WIDTH = 64;

export function PanelContainer() {
  const panelMode = useIslandStore((s) => s.panelMode);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);
  const viewStack = useIslandStore((s) => s.viewStack);
  const popView = useIslandStore((s) => s.popView);

  const topView = viewStack[viewStack.length - 1];
  const activeGroup =
    NAV_GROUPS.find((g) => g.modes.some((m) => m.mode === panelMode)) ?? DEFAULT_GROUP;

  return (
    /* 玻璃第 6 层压底落在这里，覆盖导航栏 + 内容列整行。
     * 只压内容列会让左侧导航裸露在壳体玻璃上，11px 的导航文字在白底文档背景下只有 3.06:1。
     * 设计规则：顶栏是玻璃展示区（不压底），其下全部压底保证可读。 */
    <div className="island-panel-glass island-expand-anim flex h-full flex-row">
      {/* 一级导航栏（4 组常驻） */}
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
            <BackIcon />
          </button>
        ) : (
          NAV_GROUPS.map((group) => {
            const active = group.key === activeGroup.key;
            return (
              <button
                key={group.key}
                data-interactive
                className={`island-nav-item island-nav-item--labeled ${active ? "island-nav-item--active" : ""}`}
                /* 已在组内时不跳转（组内切换交给 chip 行，避免把用户弹回组首项） */
                onClick={() => {
                  if (!active) setPanelMode(group.modes[0].mode);
                }}
                title={group.label}
              >
                <TabIcon name={group.icon} />
                <span className="island-nav-label">{group.label}</span>
              </button>
            );
          })
        )}
      </div>

      {/* 内容列：二级 chip 行 + 面板区（压底已在整行父级生效） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!topView && activeGroup.modes.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 border-b ig-border-line px-2 py-1.5">
            {activeGroup.modes.map((m) => (
              <button
                key={m.mode}
                data-interactive
                className={`island-chip ${panelMode === m.mode ? "island-chip--active" : ""}`}
                onClick={() => setPanelMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        <div className="island-panel-scroll min-h-0 flex-1">
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
    </div>
  );
}
