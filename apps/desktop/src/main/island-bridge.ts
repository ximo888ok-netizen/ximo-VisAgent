/**
 * island-bridge.ts — 灵动岛桥接层（预算 <300 行）
 *
 * 职责：把 Agent Core 事件与审批请求，翻译成灵动岛 UI 契约，再经
 * windows/island.ts 推送；并把岛上的审批结论/急停信号映射回业务层。
 * 本模块只做翻译，不参与任何权限判断。
 */
import { desktopCapturer } from "electron";
import type { AgentEvent } from "@ximo-visagent/agent-core";
import type { TaskStatus } from "@ximo-visagent/shared-types";
import {
  createApprovalRequest,
  createStepEvent,
  type AgentStatus,
  type ApprovalDetailRow,
  type ApprovalParams,
  type ApprovalRequest,
} from "../shared/island-contracts";
import { ISLAND_CHANNELS } from "../shared/island-channels";
import { publishApprovalPending, publishStep, broadcastToIsland } from "./windows/island";

/** 审批截图失败时回退：1x1 透明 PNG */
const FALLBACK_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/* ------------------------------------------------------------------ */
/* 状态映射                                                             */
/* ------------------------------------------------------------------ */

const TASK_TO_ISLAND: Record<TaskStatus, AgentStatus> = {
  IDLE: "idle",
  PLANNING: "thinking",
  RUNNING: "thinking",
  PAUSED: "paused",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "idle",
  FAILED: "error",
  CANCELLED: "stopped",
  EMERGENCY_STOPPED: "stopped",
};

const STATUS_TEXT: Partial<Record<TaskStatus, string>> = {
  IDLE: "就绪",
  PLANNING: "正在规划任务…",
  RUNNING: "任务运行中",
  PAUSED: "已暂停（点击继续恢复）",
  WAITING_APPROVAL: "等待审批确认",
  COMPLETED: "任务已完成",
  FAILED: "任务执行失败",
  CANCELLED: "任务已取消",
  EMERGENCY_STOPPED: "已紧急停止",
};

/** TaskStatus → 岛状态位 */
export function mapStatus(status: TaskStatus): AgentStatus {
  return TASK_TO_ISLAND[status] ?? "thinking";
}

/* ------------------------------------------------------------------ */
/* 步骤事件 → 岛日志 + 步骤详情 + 用量事件                                */
/* ------------------------------------------------------------------ */

export function feedStep(event: AgentEvent, taskId: string): void {
  switch (event.type) {
    case "step": {
      const thought = (event.step.thought ?? "").replace(/\s+/g, " ").trim();
      publishStep(
        createStepEvent(
          "thinking",
          `第 ${event.step.index} 步：${thought || event.step.actionName || ""}`.trim(),
        ),
      );
      // 步骤详情（时间线/详情抽层用）
      broadcastToIsland(ISLAND_CHANNELS.stepDetail, {
        taskId,
        ...event.step,
        ts: Date.now(),
      });
      break;
    }
    case "status": {
      const text = STATUS_TEXT[event.status] ?? "任务运行中";
      publishStep(createStepEvent(mapStatus(event.status), text));
      break;
    }
    case "llm_usage": {
      broadcastToIsland(ISLAND_CHANNELS.usage, {
        taskId,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        ts: Date.now(),
      });
      break;
    }
    case "error": {
      publishStep(
        createStepEvent("error", (event.message ?? "任务异常").replace(/\s+/g, " ")),
      );
      break;
    }
    default:
      // approval_pending / approval_result / perception 由专用通道处理
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 审批请求装配                                                         */
/* ------------------------------------------------------------------ */

/** 标量值转字符串（长文本截断、对象跳过） */
function scalarString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.replace(/\s+/g, " ").slice(0, 240) || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // 对象/数组/函数不展示
}

/** 审批调用 → 岛可编辑参数表（仅标量） */
export function argsToParams(args: Record<string, unknown>): ApprovalParams {
  const out: ApprovalParams = {};
  for (const [k, v] of Object.entries(args)) {
    const s = scalarString(v);
    if (s !== null) out[k] = s;
  }
  return out;
}

/** 审批调用 → 关键信息行（原因 + 前几个可读参数） */
function argsToDetail(args: Record<string, unknown>, reason: string, appName?: string): ApprovalDetailRow[] {
  const rows: ApprovalDetailRow[] = [];
  if (appName) rows.push({ label: "目标窗口", value: appName });
  if (reason) rows.push({ label: "原因", value: reason });
  for (const [k, v] of Object.entries(args).slice(0, 4)) {
    const s = scalarString(v);
    if (s !== null) rows.push({ label: k, value: s });
  }
  return rows;
}

/**
 * 捕获整屏截图并压缩为 ≤600px JPEG dataURL（审批卡左侧预览）。
 * 失败回退 1x1 透明图，保证审批流程不被截图阻塞。
 */
export async function captureScreenshotDataUrl(): Promise<string> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 600, height: 400 },
      fetchWindowIcons: false,
    });
    const source = sources[0];
    if (!source) return FALLBACK_DATA_URL;
    const buf = source.thumbnail.toJPEG(72);
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return FALLBACK_DATA_URL;
  }
}

/** 装配完整审批请求并推送 */
export async function pushApprovalRequest(
  approvalId: string,
  op: { tool: string; args: Record<string, unknown>; reason: string; level?: number; approvalTimeoutMs?: number; appName?: string },
): Promise<void> {
  const request: ApprovalRequest = createApprovalRequest({
    approvalKey: approvalId,
    title: "审批操作确认",
    tool: op.tool,
    screenshot: await captureScreenshotDataUrl(),
    detail: argsToDetail(op.args, op.reason, op.appName),
    params: argsToParams(op.args),
    riskLevel: op.level ?? 2,
    expiresAt: op.approvalTimeoutMs ? Date.now() + op.approvalTimeoutMs : undefined,
  });
  publishApprovalPending(request);
}

/* ------------------------------------------------------------------ */
/* revised 参数回填：字符串 → 真实类型                                    */
/* ------------------------------------------------------------------ */

/** "3"→3、"true"→true、"{"a":1}"→对象；无法解析则原样字符串。
 *  BUG-12 修复：以原始 args 为基底，只覆盖用户修改的标量键，保留对象/数组参数。
 */
export function coerceArgs(params: ApprovalParams, originalArgs: Record<string, unknown> = {}): Record<string, unknown> {
  // 以原始参数为基底，只覆盖用户在 UI 上修改的标量键
  const out: Record<string, unknown> = { ...originalArgs };
  for (const [k, v] of Object.entries(params)) {
    const t = v.trim();
    if (/^-?\d+$/.test(t) && !/^0\d/.test(t)) out[k] = Number(t);
    else if (t === "true") out[k] = true;
    else if (t === "false") out[k] = false;
    else if (t === "null") out[k] = null;
    else if (t.startsWith("{") || t.startsWith("[")) {
      try {
        out[k] = JSON.parse(t);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}
