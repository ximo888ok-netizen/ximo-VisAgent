/**
 * 审计域 schema：任务查询 / 审计事件查询 / 导出
 */
import { z } from "zod";

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
  steps: z.number().nullable().optional(),
  tokens: z.number().nullable().optional(),
  failureKind: z.string().nullable().optional(),
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
