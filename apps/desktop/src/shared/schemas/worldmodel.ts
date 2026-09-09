/**
 * 世界模型域 schema（v3 P8）：环境事实行 / 添加 / 搜索
 */
import { z } from "zod";

export const EnvFactRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['app', 'login', 'path', 'workflow', 'preference', 'ui-convention', 'fact']),
  content: z.string(),
  confidence: z.number(),
  timesObserved: z.number().int(),
  sourceTaskId: z.string().nullable(),
  lastVerifiedAt: z.number().nullable(),
  createdAt: z.number(),
  enabled: z.boolean(),
});
export type EnvFactRowPayload = z.infer<typeof EnvFactRowSchema>;

export const WorldModelAddSchema = z.object({
  kind: z.enum(['app', 'login', 'path', 'workflow', 'preference', 'ui-convention', 'fact']),
  content: z.string().min(1).max(300),
});
export type WorldModelAddRequest = z.infer<typeof WorldModelAddSchema>;

export const WorldModelSearchSchema = z.object({
  query: z.string().max(200).optional(),
  kind: z.enum(['app', 'login', 'path', 'workflow', 'preference', 'ui-convention', 'fact']).optional(),
});
export type WorldModelSearchRequest = z.infer<typeof WorldModelSearchSchema>;

/** worldmodelSearch 返回：命中事实列表（排序与裁剪由主进程决定） */
export type WorldModelSearchResult = { items: EnvFactRowPayload[] };

/** worldmodelScan 返回：本次扫描新增和更新的事实条数 */
export type WorldModelScanResult = { added: number; updated: number };
