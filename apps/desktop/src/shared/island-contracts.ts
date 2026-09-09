/**
 * island-contracts.ts
 * ============================================================================
 * 「灵动岛 DynamicIsland」前后端唯一数据契约（核心 schema）。
 *
 * 拆分说明：
 * - ISLAND_CHANNELS → island-channels.ts
 * - 面板/任务/配置/审计 schema → island-panel-schemas.ts
 * - 本文件保留 Agent 状态、步骤事件、审批三大核心契约。
 *
 * 频道前缀约定：所有 island:* 频道仅与灵动岛窗口通信。
 * ============================================================================
 */
import { z } from "zod";

// 重新导出拆分模块，保持调用方 import 不变。
// 用 export * 而非手抄名单：island-panel-schemas 已是 ./schemas/* 的聚合门面，
// 手抄名单会让新增的 schema/类型静默丢失（正是本次要消灭的双份维护）。
export { ISLAND_CHANNELS } from "./island-channels";
export * from "./island-panel-schemas";

/* ---------------------------------------------------------------------------
 * Agent 运行状态
 * ------------------------------------------------------------------------- */
export const AGENT_STATUS = [
  "idle",
  "thinking",
  "paused",
  "waiting_approval",
  "error",
  "stopped",
] as const;

export type AgentStatus = (typeof AGENT_STATUS)[number];

export const AgentStatusSchema = z.enum(AGENT_STATUS);

/** 主进程 -> 渲染进程：单条 ReAct 步骤 */
export const AgentStepEventSchema = z.object({
  ts: z.number().int().nonnegative().default(() => Date.now()),
  status: AgentStatusSchema,
  text: z.string().min(1).max(2000),
});

export type AgentStepEvent = z.infer<typeof AgentStepEventSchema>;

/* ---------------------------------------------------------------------------
 * 审批
 * ------------------------------------------------------------------------- */

export const ApprovalDecisionSchema = z.enum([
  "approved",
  "rejected",
  "revised",
]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalDetailRowSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(240),
});
export type ApprovalDetailRow = z.infer<typeof ApprovalDetailRowSchema>;

export const ApprovalParamsSchema = z.record(z.string(), z.string());
export type ApprovalParams = z.infer<typeof ApprovalParamsSchema>;

export const ApprovalRequestSchema = z.object({
  approvalKey: z.string().min(1).max(128),
  title: z.string().min(1).max(120),
  tool: z.string().min(1).max(120),
  screenshot: z.string().startsWith("data:image").max(900_000),
  detail: z.array(ApprovalDetailRowSchema).max(8).default([]),
  params: ApprovalParamsSchema.default({}),
  // F4.1: 风险级别与过期时间
  riskLevel: z.number().int().min(0).max(3).default(2),
  expiresAt: z.number().int().positive().optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResultSchema = z.object({
  approvalKey: z.string().min(1).max(128),
  decision: ApprovalDecisionSchema,
  params: ApprovalParamsSchema.optional(),
  note: z.string().max(500).optional(),
});

export type ApprovalResult = z.infer<typeof ApprovalResultSchema>;

/* ---------------------------------------------------------------------------
 * 渲染 -> 主进程请求
 * ------------------------------------------------------------------------- */

export const EmergencyStopRequestSchema = z.object({
  reason: z.string().max(200).optional(),
});

export type EmergencyStopRequest = z.infer<typeof EmergencyStopRequestSchema>;

/* ---------------------------------------------------------------------------
 * 构造器
 * ------------------------------------------------------------------------- */

export function createStepEvent(
  status: AgentStatus,
  text: string,
): AgentStepEvent {
  return AgentStepEventSchema.parse({ status, text });
}

export function createApprovalRequest(
  input: Omit<ApprovalRequest, "detail" | "params"> & {
    detail?: ApprovalDetailRow[];
    params?: ApprovalParams;
  },
): ApprovalRequest {
  return ApprovalRequestSchema.parse(input);
}
