/**
 * mission.ts — Mission / Subtask / Artifact zod schema（单一来源）
 *
 * 与 shared-types Mission / Subtask / MissionArtifact 接口对应。
 * 所有 IPC 载荷验证、DB 行序列化都引用这里的 schema。
 */
import { z } from 'zod';

/** 任务优先级 */
export const MissionPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

/** 任务来源 */
export const MissionOriginSchema = z.enum(['manual', 'scheduled', 'sop', 'api']);

/** 任务状态 */
export const MissionStatusSchema = z.enum([
  'draft',
  'planning',
  'queued',
  'awaiting_confirm',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

/** 子任务风险预估（规划侧标注，执行侧以 SafetyClassifier 为准） */
export const SubtaskRiskSchema = z.enum(['L0', 'L1', 'L2', 'L3']);

/** 子任务状态 */
export const SubtaskStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_review',
  'done',
  'failed',
  'skipped',
]);

/** 人工对暂停 Mission 的处置决定（失败不自动重试，只由人裁决） */
export const MissionResolveDecisionSchema = z.enum(['retry', 'skip', 'abort']);

/** 子任务产物类型 */
export const ArtifactKindSchema = z.enum(['file', 'screenshot', 'data', 'text']);

/** 子任务产物行（与 mission_artifacts 表逐列对应） */
export const MissionArtifactRowSchema = z.object({
  id: z.string(),
  subtaskId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string(),
  label: z.string(),
  contentHash: z.string().nullable(),
  stale: z.boolean(),
  createdAt: z.number().int(),
});

/** 子任务行（与 subtasks 表逐列对应，不含 join 出来的 artifacts） */
export const SubtaskRowSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  capabilityId: z.string().nullable(),
  title: z.string(),
  instruction: z.string(),
  status: SubtaskStatusSchema,
  order: z.number().int(),
  dependsOn: z.array(z.string()),
  risk: SubtaskRiskSchema.nullable(),
  attempts: z.number().int(),
  taskId: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  reviewNote: z.string(),
});

/** 任务行（与 missions 表逐列对应，不含 join 出来的 subtasks） */
export const MissionRowSchema = z.object({
  id: z.string(),
  goal: z.string(),
  origin: MissionOriginSchema,
  priority: MissionPrioritySchema,
  status: MissionStatusSchema,
  planJson: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
});

/** 创建任务请求 */
export const MissionCreateSchema = z.object({
  goal: z.string().min(1).max(500),
  origin: MissionOriginSchema.default('manual'),
  priority: MissionPrioritySchema.default('normal'),
  subtasks: z.array(z.object({
    capabilityId: z.string().nullable().default(null),
    title: z.string().min(1).max(200),
    instruction: z.string().max(2000).default(''),
  })).min(1),
});

/** 子任务状态更新请求 */
export const SubtaskStatusUpdateSchema = z.object({
  subtaskId: z.string(),
  status: SubtaskStatusSchema,
  reviewNote: z.string().max(1000).optional(),
});

/** 子任务产物登记请求 */
export const ArtifactCreateSchema = z.object({
  subtaskId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string().min(1).max(500),
  label: z.string().max(200).default(''),
  contentHash: z.string().max(128).optional(),
});

/** 能力匹配请求：给定任务目标，返回候选能力卡 */
export const CapabilityMatchSchema = z.object({
  missionGoal: z.string().min(1).max(500),
});

/** 能力匹配返回：候选能力卡列表（含匹配分数） */
export const CapabilityMatchResultSchema = z.object({
  items: z.array(z.object({
    capabilityId: z.string(),
    score: z.number(),
    title: z.string(),
  })),
});

/** 规划产物结构（planJson 入库前的 zod 校验；执行以 subtasks 表为准，plan 是归档快照） */
export const MissionPlanSchema = z.object({
  subtasks: z.array(z.object({
    id: z.string().min(1).max(64),
    goal: z.string().min(1).max(200),
    capabilityId: z.string().max(120).nullable().default(null),
    dependsOn: z.array(z.string()).default([]),
    risk: SubtaskRiskSchema.optional(),
  })).min(1).max(8),
});

/** 保存规划产物请求：入库 planJson 并进入 awaiting_confirm（计划确认闸，§4.3） */
export const MissionPlanSaveSchema = z.object({
  missionId: z.string().min(1),
  planJson: z.string().min(2).max(20_000),
});

/** 人工确认计划请求：awaiting_confirm → running（确认前绝不派发） */
export const MissionConfirmSchema = z.object({
  missionId: z.string().min(1),
});

/** 暂停 Mission 的人工处置请求（子任务失败后 重试/跳过/终止） */
export const MissionResolveSchema = z.object({
  missionId: z.string().min(1),
  decision: MissionResolveDecisionSchema,
});

export type MissionRowPayload = z.infer<typeof MissionRowSchema>;
export type SubtaskRowPayload = z.infer<typeof SubtaskRowSchema>;
export type MissionArtifactRowPayload = z.infer<typeof MissionArtifactRowSchema>;
export type MissionCreateRequest = z.infer<typeof MissionCreateSchema>;
export type SubtaskStatusUpdateRequest = z.infer<typeof SubtaskStatusUpdateSchema>;
export type ArtifactCreateRequest = z.infer<typeof ArtifactCreateSchema>;
export type CapabilityMatchRequest = z.infer<typeof CapabilityMatchSchema>;
export type CapabilityMatchResultPayload = z.infer<typeof CapabilityMatchResultSchema>;
export type SubtaskRisk = z.infer<typeof SubtaskRiskSchema>;
export type MissionPlanPayload = z.infer<typeof MissionPlanSchema>;
export type MissionPlanSaveRequest = z.infer<typeof MissionPlanSaveSchema>;
export type MissionConfirmRequest = z.infer<typeof MissionConfirmSchema>;
export type MissionResolveRequest = z.infer<typeof MissionResolveSchema>;
export type MissionResolveDecision = z.infer<typeof MissionResolveDecisionSchema>;
