/**
 * SOP 域 schema：模板 CRUD / 运行 / 回放截图 / 规则模拟 / 导入导出 / 相似推荐 / 教学录制
 */
import { z } from "zod";

export const SopRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  goalTemplate: z.string(),
  stepsJson: z.string(),
  variablesJson: z.string().default("[]"),
  runCount: z.number().int(),
  lastRunAt: z.number().nullable(),
  createdAt: z.number(),
});
export type SopRowPayload = z.infer<typeof SopRowSchema>;

export const SaveSopSchema = z.object({
  taskId: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
});
export type SaveSopRequest = z.infer<typeof SaveSopSchema>;

export const RunSopSchema = z.object({
  sopId: z.string().min(1),
  goal: z.string().min(1).max(2000),
  // M8: SOP 变量键值对，用于 {{key}} 占位符替换
  variables: z.record(z.string(), z.string()).optional(),
});
export type RunSopRequest = z.infer<typeof RunSopSchema>;

export const DeleteSopSchema = z.object({ sopId: z.string().min(1) });

export const ReplayImageSchema = z.object({
  taskId: z.string().min(1),
  stepIndex: z.number().int().min(1),
});

export const SimulateRuleSchema = z.object({
  tool: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  appName: z.string().max(240).optional(),
  domain: z.string().max(240).optional(),
});
export type SimulateRuleRequest = z.infer<typeof SimulateRuleSchema>;

export const SimulateRuleResultSchema = z.object({
  level: z.number().int().min(0).max(3),
  reason: z.string(),
  disposition: z.string(),
});
export type SimulateRuleResult = z.infer<typeof SimulateRuleResultSchema>;

export const SopExportSchema = z.object({ sopId: z.string().min(1) });
export type SopExportRequest = z.infer<typeof SopExportSchema>;

export const SopImportSchema = z.object({ json: z.string().min(2).max(200_000) });
export type SopImportRequest = z.infer<typeof SopImportSchema>;

/** SOP 相似推荐 */
export const RecommendSopSchema = z.object({ goal: z.string().min(2).max(2000) });
export type RecommendSopRequest = z.infer<typeof RecommendSopSchema>;

export const RecommendResultSchema = z.object({
  sopId: z.string(),
  name: z.string(),
  score: z.number(),
});
export type RecommendResultPayload = z.infer<typeof RecommendResultSchema>;

/** 教学模式录制 → 保存 SOP */
export const SaveSopStepsSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  steps: z.array(z.string().min(1).max(500)).min(1).max(200),
});
export type SaveSopStepsRequest = z.infer<typeof SaveSopStepsSchema>;
