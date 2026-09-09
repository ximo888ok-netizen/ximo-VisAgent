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
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

/** 子任务状态 */
export const SubtaskStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_review',
  'done',
  'failed',
  'skipped',
]);

/** 子任务产物类型 */
export const ArtifactKindSchema = z.enum(['file', 'screenshot', 'data', 'text']);

/** 子任务产物行（与 mission_artifacts 表逐列对应） */
export const MissionArtifactRowSchema = z.object({
  id: z.string(),
  subtaskId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string(),
  label: z.string(),
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

export type MissionRowPayload = z.infer<typeof MissionRowSchema>;
export type SubtaskRowPayload = z.infer<typeof SubtaskRowSchema>;
export type MissionArtifactRowPayload = z.infer<typeof MissionArtifactRowSchema>;
export type MissionCreateRequest = z.infer<typeof MissionCreateSchema>;
export type SubtaskStatusUpdateRequest = z.infer<typeof SubtaskStatusUpdateSchema>;
export type ArtifactCreateRequest = z.infer<typeof ArtifactCreateSchema>;
export type CapabilityMatchRequest = z.infer<typeof CapabilityMatchSchema>;
export type CapabilityMatchResultPayload = z.infer<typeof CapabilityMatchResultSchema>;
