/**
 * 配置域 schema：LLM / 安全规则 / Agent 配置 / 审批档位 / 连通性测试
 */
import { z } from "zod";
import { WeChatBotConfigSchema } from "./wechat";

export const LLMConfigSchema = z.object({
  provider: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  enabled: z.boolean(),
});
export type LLMConfigPayload = z.infer<typeof LLMConfigSchema>;

export const SafetyRuleSchema = z.object({
  id: z.string().min(1).max(80),
  appPattern: z.string().optional(),
  domainPattern: z.string().optional(),
  levelOverride: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean(),
});
export type SafetyRulePayload = z.infer<typeof SafetyRuleSchema>;

export const AgentConfigSchema = z.object({
  textLLM: LLMConfigSchema,
  visionLLM: LLMConfigSchema,
  maxSteps: z.number().int().min(1).max(500).default(120),
  maxTaskMinutes: z.number().int().min(1).max(600),
  approvalTimeoutSec: z.number().int().min(10).max(600),
  maxRetries: z.number().int().min(0).max(10),
  emergencyHotkey: z.string(),
  /** DeepSeek 思考强度：'off' 关闭思考；low/high/max 对应 reasoning_effort（缺省=模型默认 high） */
  thinkingEffort: z.enum(["off", "low", "high", "max"]).optional(),
  /** 思考四档（qwen/glm 生效）：auto=评分制弹性 / daily=恒关 / long=前2步关后恒开 / deep=恒开 */
  thinkingMode: z.enum(["auto", "daily", "long", "deep"]).optional(),
});
export type AgentConfigPayload = z.infer<typeof AgentConfigSchema>;

/** 审批档位（与 shared-types 的 ApprovalMode 联合一致） */
export const ApprovalModeSchema = z.enum(["manual", "auto", "autonomous"]);
export type ApprovalModePayload = z.infer<typeof ApprovalModeSchema>;

export const AppConfigSchema = z.object({
  agent: AgentConfigSchema,
  safetyRules: z.array(SafetyRuleSchema),
  workspaceDir: z.string(),
  audioEnabled: z.boolean(),
  memoryEnabled: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  schedulerEnabled: z.boolean().optional(),
  auraIntensity: z.enum(["off", "subtle", "full"]).optional(),
  approvalMode: ApprovalModeSchema.optional(),
  wechatBot: WeChatBotConfigSchema.optional(),
});
export type AppConfigPayload = z.infer<typeof AppConfigSchema>;

/** 更新配置：分项，全部 optional */
export const UpdateConfigSchema = z.object({
  agent: AgentConfigSchema.partial().optional(),
  safetyRules: z.array(SafetyRuleSchema).optional(),
  workspaceDir: z.string().optional(),
  audioEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  schedulerEnabled: z.boolean().optional(),
  auraIntensity: z.enum(["off", "subtle", "full"]).optional(),
  approvalMode: ApprovalModeSchema.optional(),
  /** 切入 autonomous 的显式风险确认（主进程强校验，缺了会被拒绝并返回具体错误） */
  approvalModeAck: z.boolean().optional(),
}).refine(
  (v) =>
    v.agent !== undefined || v.safetyRules !== undefined || v.workspaceDir !== undefined ||
    v.audioEnabled !== undefined ||
    v.memoryEnabled !== undefined || v.autoRetry !== undefined || v.schedulerEnabled !== undefined
    || v.auraIntensity !== undefined || v.approvalMode !== undefined,
  { message: "至少提供一项要更新的配置" },
);
export type UpdateConfigRequest = z.infer<typeof UpdateConfigSchema>;

// ---------------------------------------------------------------------------
// 连通性测试
// ---------------------------------------------------------------------------

export const TestLlmSchema = z.object({
  which: z.enum(["textLLM", "visionLLM"]),
});
export type TestLlmWhich = z.infer<typeof TestLlmSchema>["which"];

export const TestLlmResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().optional(),
  reply: z.string().optional(),
  error: z.string().optional(),
});
export type TestLlmResult = z.infer<typeof TestLlmResultSchema>;
