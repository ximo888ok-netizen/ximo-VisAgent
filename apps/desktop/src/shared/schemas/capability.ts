/**
 * capability.ts — 能力卡 zod schema（单一来源）
 *
 * 与 shared-types CapabilityCard 接口对应。
 * 所有 IPC 载荷验证、DB 行序列化都引用这里的 schema。
 */
import { z } from 'zod';

/** 能力卡状态 */
export const CapabilityStatusSchema = z.enum(['active', 'retired']);

/** 能力卡来源 */
export const CapabilitySourceSchema = z.enum(['seed', 'distilled']);

/** 完整能力卡行（与 capabilities 表逐列对应） */
export const CapabilityCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  precondition: z.string(),
  acceptance: z.string(),
  visualAnchors: z.array(z.string()),
  status: CapabilityStatusSchema,
  source: CapabilitySourceSchema,
  usageCount: z.number().int(),
  failCount: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/** 创建能力卡请求（id 由主进程生成或调用方指定） */
export const CapabilityCreateSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  tools: z.array(z.string()).default([]),
  precondition: z.string().max(1000).default(''),
  acceptance: z.string().max(1000).default(''),
  visualAnchors: z.array(z.string()).default([]),
});

/** 更新能力卡请求（部分字段） */
export const CapabilityUpdateSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  tools: z.array(z.string()).optional(),
  precondition: z.string().max(1000).optional(),
  acceptance: z.string().max(1000).optional(),
  visualAnchors: z.array(z.string()).optional(),
  status: CapabilityStatusSchema.optional(),
});

/** 能力卡搜索请求 */
export const CapabilitySearchSchema = z.object({
  query: z.string().max(200).optional(),
  status: CapabilityStatusSchema.optional(),
  source: CapabilitySourceSchema.optional(),
});

export type CapabilityCardPayload = z.infer<typeof CapabilityCardSchema>;
export type CapabilityCreateRequest = z.infer<typeof CapabilityCreateSchema>;
export type CapabilityUpdateRequest = z.infer<typeof CapabilityUpdateSchema>;
export type CapabilitySearchRequest = z.infer<typeof CapabilitySearchSchema>;
