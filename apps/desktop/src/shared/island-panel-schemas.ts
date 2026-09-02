/**
 * island-panel-schemas.ts — 面板模式新增的 Zod schema 与类型
 *
 * 面板四态：log / task / settings / audit
 * 审批（approval）是特殊态，有自己的 ApprovalRequest 推送，不走面板 tab。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 面板模式
// ---------------------------------------------------------------------------

export const PANEL_MODES = ["log", "task", "settings", "audit"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

// ---------------------------------------------------------------------------
// 任务管理
// ---------------------------------------------------------------------------

export const StartTaskSchema = z.object({
  goal: z.string().min(1).max(2000),
});
export type StartTaskRequest = z.infer<typeof StartTaskSchema>;

export const TaskStartedSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string(),
});
export type TaskStartedResult = z.infer<typeof TaskStartedSchema>;

export const CancelTaskSchema = z.object({
  taskId: z.string().min(1),
});

/** 任务终态推送 payload（main -> renderer） */
export const TaskFinishedSchema = z.object({
  taskId: z.string().min(1),
  status: z.string(),
  finalAnswer: z.string(),
  steps: z.number().int(),
  totalTokens: z.number().int(),
});
export type TaskFinishedPayload = z.infer<typeof TaskFinishedSchema>;

// ---------------------------------------------------------------------------
// 配置管理
// ---------------------------------------------------------------------------

export const LLMConfigSchema = z.object({
  provider: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  enabled: z.boolean(),
});

export const SafetyRuleSchema = z.object({
  id: z.string().min(1).max(80),
  appPattern: z.string().optional(),
  domainPattern: z.string().optional(),
  levelOverride: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean(),
});

export const AgentConfigSchema = z.object({
  textLLM: LLMConfigSchema,
  visionLLM: LLMConfigSchema,
  maxTaskMinutes: z.number().int().min(1).max(600),
  approvalTimeoutSec: z.number().int().min(10).max(600),
  maxRetries: z.number().int().min(0).max(10),
  emergencyHotkey: z.string(),
});

export const AppConfigSchema = z.object({
  agent: AgentConfigSchema,
  safetyRules: z.array(SafetyRuleSchema),
  workspaceDir: z.string(),
  audioEnabled: z.boolean(),
  browserEnabled: z.boolean().optional(),
});
export type AppConfigPayload = z.infer<typeof AppConfigSchema>;

/** 更新配置：三选一分项，全部 optional */
export const UpdateConfigSchema = z.object({
  agent: AgentConfigSchema.partial().optional(),
  safetyRules: z.array(SafetyRuleSchema).optional(),
  workspaceDir: z.string().optional(),
}).refine(
  (v) => v.agent !== undefined || v.safetyRules !== undefined || v.workspaceDir !== undefined,
  { message: "至少提供一项要更新的配置" },
);
export type UpdateConfigRequest = z.infer<typeof UpdateConfigSchema>;

// ---------------------------------------------------------------------------
// 审计查询
// ---------------------------------------------------------------------------

export const QueryTasksSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50).optional(),
});
export type QueryTasksRequest = z.infer<typeof QueryTasksSchema>;

export const TaskRowSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  status: z.string(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  summary: z.string(),
});
export type TaskRowPayload = z.infer<typeof TaskRowSchema>;

export const QueryAuditSchema = z.object({
  taskId: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200).optional(),
});
export type QueryAuditRequest = z.infer<typeof QueryAuditSchema>;

export const AuditRowSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.string(),
  timestamp: z.number(),
  seq: z.number(),
  detail: z.string(),
});
export type AuditRowPayload = z.infer<typeof AuditRowSchema>;

export const ExportCsvResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
});
export type ExportCsvResult = z.infer<typeof ExportCsvResultSchema>;
