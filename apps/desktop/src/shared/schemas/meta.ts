/**
 * 元层（宪法门）域 schema：状态查询 / 提案行 / 待办队列 / 人工决定 / 启停
 */
import { z } from "zod";

export const MetaStatusSchema = z.object({});

export const MetaProposalRowSchema = z.object({
  id: z.string(),
  action: z.string(),
  targetId: z.string(),
  reason: z.string(),
  payloadJson: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed']),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type MetaProposalRowPayload = z.infer<typeof MetaProposalRowSchema>;

export const MetaPendingSchema = z.object({
  status: z.enum(['pending', 'executed', 'rejected', 'failed', 'all']).default('pending').optional(),
  limit: z.number().int().min(1).max(200).default(50).optional(),
});
export type MetaPendingRequest = z.infer<typeof MetaPendingSchema>;

export const MetaDecideSchema = z.object({
  proposalId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(300).optional(),
});
export type MetaDecideRequest = z.infer<typeof MetaDecideSchema>;

export const MetaEnableSchema = z.object({ enabled: z.boolean() });
export type MetaEnableRequest = z.infer<typeof MetaEnableSchema>;

/** metaStatus / metaEnable 的返回（主进程 meta-gate.ts 的 MetaStatus 契约形态） */
export const MetaStatusResultSchema = z.object({
  enabled: z.boolean(),
  lastViolation: z.string().nullable().optional(),
  disabledAt: z.number().nullable().optional(),
  pending: z.number().int().min(0),
});
export type MetaStatusResult = z.infer<typeof MetaStatusResultSchema>;

/** metaPending 返回：提案列表 + 门状态（主进程以 { items, ...metaStatus() } 展开） */
export type MetaPendingResult = { items: MetaProposalRowPayload[] } & MetaStatusResult;
