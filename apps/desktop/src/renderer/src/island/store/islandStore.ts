/**
 * islandStore.ts — 灵动岛主 store（编排层）
 *
 * 拆分说明：
 * - 面板/任务/配置/审计状态从 slice 文件合并
 * - 本文件只做合并导出 + 顶部条状态 + 审批状态
 */
import { create } from "zustand";
import type { AgentStatus, ApprovalRequest } from "@shared/island-contracts";
import type { PanelMode } from "@shared/island-contracts";
import { createTaskSlice, type TaskSliceState } from "./taskSlice";
import { createConfigSlice, type ConfigSliceState } from "./configSlice";
import { createAuditSlice, type AuditSliceState } from "./auditSlice";

export interface IslandLogEntry {
  id: number;
  ts: number;
  status: AgentStatus;
  text: string;
}

export type IslandView = "collapsed" | "expanded";

/** 面板高度映射 */
export const PANEL_HEIGHTS: Record<PanelMode, number> = {
  log: 360,
  task: 220,
  settings: 480,
  audit: 480,
} as const;

interface IslandState extends TaskSliceState, ConfigSliceState, AuditSliceState {
  // ---- 顶部条 ----
  status: AgentStatus;
  currentLog: IslandLogEntry | null;
  logs: IslandLogEntry[];
  view: IslandView;

  // ---- 面板模式 ----
  panelMode: PanelMode;
  /** 审批有最高优先级：有 approval 时强制展示，面板 tab 隐藏 */
  approval: ApprovalRequest | null;
  /** 记住审批弹出前的面板模式，审批结束后恢复 */
  prevPanelMode: PanelMode;

  // ---- actions ----
  setStatus(status: AgentStatus): void;
  pushStep(entry: IslandLogEntry): void;
  setPanelMode(mode: PanelMode): void;
  openApproval(request: ApprovalRequest, timeoutMs: number): void;
  resolveApproval(): void;
  reset(): void;
}

let entryId = 1;
let approvalTimer: number | undefined;

export const useIslandStore = create<IslandState>((set, get) => ({
  // ---- 顶部条 ----
  status: "idle",
  currentLog: null,
  logs: [],
  view: "collapsed",

  // ---- 面板 ----
  panelMode: "task",
  approval: null,
  prevPanelMode: "task",

  // ---- slices ----
  ...createTaskSlice(set, get),
  ...createConfigSlice(set, get),
  ...createAuditSlice(set, get),

  // ---- actions ----
  setStatus(status) {
    set({ status });
  },

  pushStep(entry) {
    set((s) => ({
      status: entry.status,
      currentLog: entry,
      logs: [...s.logs, entry].slice(-60),
    }));
  },

  setPanelMode(mode) {
    set({ panelMode: mode, view: "expanded" });
  },

  openApproval(request, timeoutMs) {
    if (approvalTimer !== undefined) window.clearTimeout(approvalTimer);
    approvalTimer = window.setTimeout(() => {
      approvalTimer = undefined;
      get().resolveApproval();
    }, timeoutMs);
    set((s) => ({
      approval: request,
      prevPanelMode: s.panelMode,
      view: "expanded",
    }));
  },

  resolveApproval() {
    if (approvalTimer !== undefined) {
      window.clearTimeout(approvalTimer);
      approvalTimer = undefined;
    }
    set({ approval: null });
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
      approval: null,
    });
  },
}));

/** UI 状态 -> 左侧状态文字 */
export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "就绪",
  thinking: "运行中",
  waiting_approval: "等待审批",
  error: "异常",
  stopped: "已停止",
};
