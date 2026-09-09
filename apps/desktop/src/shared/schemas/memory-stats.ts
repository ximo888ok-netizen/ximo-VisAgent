/**
 * 记忆 / 统计 / 定时 / 会话域 schema（island-smart-handlers 对应面板）
 */
import { z } from "zod";

/** 记忆条目（工作事实，自动提炼自完成任务） */
export const MemoryRowSchema = z.object({
  id: z.string(),
  /** fact=工作事实 / preference=用户偏好 */
  kind: z.enum(["fact", "preference"]),
  content: z.string(),
  sourceTaskId: z.string().nullable(),
  createdAt: z.number(),
  useCount: z.number(),
  lastUsedAt: z.number().nullable(),
  enabled: z.boolean(),
});
export type MemoryRowPayload = z.infer<typeof MemoryRowSchema>;

export const MemoryToggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type MemoryToggleRequest = z.infer<typeof MemoryToggleSchema>;

export const MemoryDeleteSchema = z.object({ id: z.string().min(1) });
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteSchema>;

/** 任务统计 */
export const StatsResultSchema = z.object({
  totalTasks: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  interrupted: z.number().int(),
  successRate: z.number(),
  totalTokens: z.number().int(),
  avgTokens: z.number().int(),
  /** 人工干预次数（审批决定数：批准/拒绝/改参） */
  interventions: z.number().int(),
  failureKinds: z.array(z.object({ kind: z.string(), count: z.number().int() })),
  days: z.number().int(),
});
export type StatsResultPayload = z.infer<typeof StatsResultSchema>;

export const StatsQuerySchema = z.object({
  days: z.number().int().min(1).max(365).default(30).optional(),
});
export type StatsQueryRequest = z.infer<typeof StatsQuerySchema>;

/** 定时任务 */
export const ScheduledJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 关联 SOP 模板（优先）；无模板时用 goal 直跑 */
  sopId: z.string().nullable(),
  goal: z.string(),
  /** 5 字段 cron: 分 时 日 月 周 */
  cron: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  /** lastStatus: 成功/失败/从未 */
  lastStatus: z.string().nullable(),
  createdAt: z.number(),
});
export type ScheduledJobPayload = z.infer<typeof ScheduledJobSchema>;

export const SchedulerCreateSchema = z.object({
  name: z.string().min(1).max(80),
  sopId: z.string().optional(),
  goal: z.string().max(2000).optional(),
  cron: z.string().min(1).max(60),
});
export type SchedulerCreateRequest = z.infer<typeof SchedulerCreateSchema>;

export const SchedulerToggleSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });
export type SchedulerToggleRequest = z.infer<typeof SchedulerToggleSchema>;

export const SchedulerDeleteSchema = z.object({ id: z.string().min(1) });
export type SchedulerDeleteRequest = z.infer<typeof SchedulerDeleteSchema>;

/** 会话上下文信息 */
export const ConversationInfoSchema = z.object({
  turns: z.number().int(),
  hasContext: z.boolean(),
});
export type ConversationInfoPayload = z.infer<typeof ConversationInfoSchema>;
