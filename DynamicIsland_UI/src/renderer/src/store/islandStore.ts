import { create } from "zustand";
import type { AgentStatus, ApprovalRequest } from "../../shared/island-contracts";

export interface IslandLogEntry {
  id: number;
  ts: number;
  status: AgentStatus;
  text: string;
}

export type IslandView = "collapsed" | "expanded";

interface IslandState {
  status: AgentStatus;
  currentLog: IslandLogEntry | null;
  logs: IslandLogEntry[];
  view: IslandView;
  approval: ApprovalRequest | null;

  setStatus(status: AgentStatus): void;
  pushStep(entry: IslandLogEntry): void;
  /** 收到 approval:pending：展开并启动 timeoutMs 自动回缩 */
  openApproval(request: ApprovalRequest, timeoutMs: number): void;
  /** 用户已操作（发送结论）或超时：收起面板 */
  resolveApproval(): void;
  reset(): void;
}

let entryId = 1;
/** 审批超时定时器（模块级句柄，避免闭包过期） */
let approvalTimer: number | undefined;

export const useIslandStore = create<IslandState>((set, get) => ({
  status: "idle",
  currentLog: null,
  logs: [],
  view: "collapsed",
  approval: null,

  setStatus(status) {
    set({ status });
  },

  pushStep(entry) {
    set((s) => ({
      status: entry.status,
      currentLog: entry,
      // 仅保留最近 60 条，防止极端情况内存增长
      logs: [...s.logs, entry].slice(-60),
    }));
  },

  openApproval(request, timeoutMs) {
    if (approvalTimer !== undefined) {
      window.clearTimeout(approvalTimer);
    }
    // 超时未操作 -> 自动回缩（仅收 UI，不改 Agent 状态机）
    approvalTimer = window.setTimeout(() => {
      approvalTimer = undefined;
      get().resolveApproval();
    }, timeoutMs);

    set({ approval: request, view: "expanded" });
  },

  resolveApproval() {
    if (approvalTimer !== undefined) {
      window.clearTimeout(approvalTimer);
      approvalTimer = undefined;
    }
    set({ approval: null, view: "collapsed" });
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
      approval: null,
    });
  },
}));

/** UI 状态 -> 左侧状态文字（短词，中性无 AI 味） */
export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "就绪",
  thinking: "运行中",
  waiting_approval: "等待审批",
  error: "异常",
  stopped: "已停止",
};
