/**
 * islandStore.ts — 灵动岛主 store（编排层）
 *
 * 拆分说明：
 * - 面板/任务/配置/审计/运行态/SOP 状态从 slice 文件合并
 * - 本文件只做合并导出 + 顶部条状态 + 审批状态 + 二级视图栈
 */
import { create } from "zustand";
import type { AgentStatus, ApprovalRequest, TaskFinishedPayload } from "@shared/island-contracts";
import type { PanelMode } from "@shared/island-contracts";
import { createTaskSlice, type TaskSliceState } from "./taskSlice";
import { createConfigSlice, type ConfigSliceState } from "./configSlice";
import { createAuditSlice, type AuditSliceState } from "./auditSlice";
import { createRunSlice, type RunSliceState } from "./runSlice";
import { createSopSlice, type SopSliceState } from "./sopSlice";
import { createUiSlice, type UiSliceState } from "./uiSlice";
import { createSmartSlice, type SmartSliceState } from "./smartSlice";
import { createExperienceSlice, type ExperienceSliceState } from "./experienceSlice";
import { createMissionSlice, type MissionSliceState } from "./missionSlice";

export interface IslandLogEntry {
  id: number;
  ts: number;
  status: AgentStatus;
  text: string;
}

export type IslandView = "collapsed" | "expanded";

/** 二级 push 视图（面板内导航，带返回） */
export type SecondaryView =
  | { kind: "stepDetail"; stepIndex: number }
  | { kind: "taskDetail"; taskId: string }
  | { kind: "replay"; taskId: string }
  | { kind: "sopRun"; sopId: string }
  | { kind: "evidence"; auditRowId: string };

/** 面板高度映射（三档：收拢 64 / 标准 ~360-480 / 深度 ≤600） */
export const PANEL_HEIGHTS: Record<PanelMode, number> = {
  task: 360,
  history: 520,
  sop: 520,
  schedule: 520,
  stats: 520,
  log: 360,
  settings: 520,
  audit: 520,
  evolution: 520,
  employee: 520,
  mission: 520,
} as const;

interface IslandState extends TaskSliceState, ConfigSliceState, AuditSliceState, RunSliceState, SopSliceState, UiSliceState, SmartSliceState, ExperienceSliceState, MissionSliceState {
  // ---- 顶部条 ----
  status: AgentStatus;
  currentLog: IslandLogEntry | null;
  logs: IslandLogEntry[];
  view: IslandView;

  // ---- 面板模式 ----
  panelMode: PanelMode;
  /** 二级视图栈（LIFO，空则显示面板一级内容） */
  viewStack: SecondaryView[];
  /** 审批有最高优先级：有 approval 时强制展示，面板 tab 隐藏 */
  approval: ApprovalRequest | null;
  /** 审批超时已挂起（不自欺：卡片保留，等待人工） */
  approvalExpired: boolean;
  /** 记住审批弹出前的面板模式，审批结束后恢复 */
  prevPanelMode: PanelMode;

  // ---- actions ----
  setStatus(status: AgentStatus): void;
  pushStep(entry: IslandLogEntry): void;
  /** BUG-09 修复：组合 taskSlice 终态写入 + runSlice 运行态清理 */
  setTaskFinished(payload: TaskFinishedPayload): void;
  setPanelMode(mode: PanelMode): void;
  pushView(view: SecondaryView): void;
  popView(): void;
  openApproval(request: ApprovalRequest, timeoutMs: number): void;
  resolveApproval(): void;
  reset(): void;
}

let approvalTimer: number | undefined;

export const useIslandStore = create<IslandState>((set, get) => {
  // taskSlice 实现只创建一次；setTaskFinished 需要引用它做终态+运行态的组合写入
  const taskSlice = createTaskSlice(set, get);
  return {
  // ---- 顶部条 ----
  status: "idle",
  currentLog: null,
  logs: [],
  view: "collapsed",

  // ---- 面板 ----
  panelMode: "task",
  viewStack: [],
  approval: null,
  approvalExpired: false,
  prevPanelMode: "task",

  // ---- slices ----
  ...taskSlice,
  ...createConfigSlice(set, get),
  ...createAuditSlice(set, get),
  ...createRunSlice(set),
  ...createSopSlice(set),
  ...createUiSlice(set),
  ...createSmartSlice(set, get),
  ...createExperienceSlice(set),
  ...createMissionSlice(set),

  // ---- actions ----
  setStatus(status) {
    set({ status });
    // PAUSED 联动运行态标记
    if (status === "paused") get().setTaskPaused(true);
    else if (status === "thinking") get().setTaskPaused(false);
  },

  pushStep(entry) {
    // BUG-10 修复：pushStep 联动 taskPaused（与 setStatus 同逻辑）
    if (entry.status === "paused") get().setTaskPaused(true);
    else if (entry.status === "thinking") get().setTaskPaused(false);
    set((s) => ({
      status: entry.status,
      currentLog: entry,
      logs: [...s.logs, entry].slice(-60),
    }));
  },

  setTaskFinished(payload) {
    // BUG-09 修复：组合 taskSlice 终态写入 + runSlice 运行态清理
    // 先调 taskSlice 的实现（终态写入），再调 runSlice 的运行态清理
    taskSlice.setTaskFinished(payload);
    get().onTaskFinishedRuntime(payload);
  },

  setPanelMode(mode) {
    set({ panelMode: mode, view: "expanded", viewStack: [] });
  },

  pushView(view) {
    set((s) => ({ viewStack: [...s.viewStack, view] }));
  },

  popView() {
    set((s) => ({ viewStack: s.viewStack.slice(0, -1) }));
  },

  openApproval(request, timeoutMs) {
    if (approvalTimer !== undefined) window.clearTimeout(approvalTimer);
    approvalTimer = window.setTimeout(() => {
      approvalTimer = undefined;
      // P1-3 修复：超时不收起、不拒绝 —— 标记挂起，卡片保留等人工
      set({ approvalExpired: true });
    }, timeoutMs);
    set((s) => ({
      approval: request,
      approvalExpired: false,
      prevPanelMode: s.panelMode,
      view: "expanded",
    }));
  },

  resolveApproval() {
    if (approvalTimer !== undefined) {
      window.clearTimeout(approvalTimer);
      approvalTimer = undefined;
    }
    set({ approval: null, approvalExpired: false });
  },

  reset() {
    if (approvalTimer !== undefined) {
      window.clearTimeout(approvalTimer);
      approvalTimer = undefined;
    }
    set({
      status: "idle",
      currentLog: null,
      logs: [],
      view: "collapsed",
      panelMode: "task",
      viewStack: [],
      approval: null,
      approvalExpired: false,
    });
  },
  };
});
