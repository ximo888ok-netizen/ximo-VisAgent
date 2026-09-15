/**
 * 任务域 schema：任务提交/排队/终态推送/步骤详情/用量/暂停恢复/断点续跑
 */
import { z } from "zod";
import { CheckpointPreviewSchema, LongTaskOptionsSchema, TargetAppSchema } from "./longtask";

/**
 * 规划 §2.1/§4.4：targetApp/longTask 均为可选扩展——不带 chip 的请求
 * 解析结果与现状逐字段一致（旧 e2e 零回归红线）。主进程按此 schema 复校。
 */
export const StartTaskSchema = z.object({
  goal: z.string().min(1, "任务描述不能为空").max(2000, "任务描述过长（上限 2000 字符）"),
  targetApp: TargetAppSchema.optional(),
  longTask: LongTaskOptionsSchema.optional(),
  /** A-M6：授权卡已 ack 的 grant；主进程复校三生效条件后才绑任务 */
  grantId: z.string().regex(/^g_[0-9a-f]{12}$/, "grantId 形态非法").optional(),
});
export type StartTaskRequest = z.infer<typeof StartTaskSchema>;

export const TaskStartedSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string(),
  /** 已加入排队（单并发，前方还有任务） */
  queued: z.boolean().optional(),
  /** 排队位次（前方任务数，0=立即执行） */
  queuedIndex: z.number().int().min(0).optional(),
});
export type TaskStartedResult = z.infer<typeof TaskStartedSchema>;

/**
 * startTask 应答（规划 §4.1-5）：失败分支可带 targetAppMissing=true，
 * 表示主进程 existsSync(exePath) 预检不通过 → 任务未起跑，渲染层把 chip 标红。
 */
export type StartTaskResult =
  | { ok: true; data: TaskStartedResult }
  | { ok: false; error: string; targetAppMissing?: boolean };

export const CancelTaskSchema = z.object({
  taskId: z.string().min(1),
});

/** 任务终态推送 payload（main -> renderer）；A-M7 收口卡扩展字段全部可选（零回归） */
export const TaskFinishedSchema = z.object({
  taskId: z.string().min(1),
  status: z.string(),
  finalAnswer: z.string(),
  steps: z.number().int(),
  totalTokens: z.number().int(),
  /** 触发闸（FR-006 收口口径）：预算/停滞/断言/模型完成/宿主异常；缺省 = 未标注的旧链路 */
  gate: z.enum([
    "budget-steps", "budget-duration", "budget-tokens",
    "stall", "assertion", "task_done", "error",
  ]).optional(),
  /** 未完成清单（最新检查点工件对账出的重做项，"路径（原因）"人话形态；上限对齐 CheckpointArtifact.path 1024+后缀） */
  remaining: z.array(z.string().max(1100)).max(50).optional(),
  /** 锚定应用（「转为长期任务」B 期入口的 payload 源） */
  targetApp: TargetAppSchema.optional(),
});
export type TaskFinishedPayload = z.infer<typeof TaskFinishedSchema>;

/** 任务开始执行推送 payload（main -> renderer，排队转执行时同步 UI） */
export const TaskStartedEventSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string(),
  ts: z.number().int().nonnegative(),
});
export type TaskStartedEvent = z.infer<typeof TaskStartedEventSchema>;

export const ActiveTaskInfoSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string(),
});
/** 运行中/排队中任务快照（渲染层重载后恢复状态） */
export const ActiveTasksSchema = z.object({
  running: z.array(ActiveTaskInfoSchema),
  queued: z.array(ActiveTaskInfoSchema),
});
export type ActiveTasksPayload = z.infer<typeof ActiveTasksSchema>;

// ---------------------------------------------------------------------------
// R1：步骤详情 / 用量 / 暂停恢复
// ---------------------------------------------------------------------------

export const StepDetailEventSchema = z.object({
  taskId: z.string(),
  index: z.number().int(),
  thought: z.string(),
  actionName: z.string().nullable(),
  resultSummary: z.string(),
  args: z.record(z.string(), z.unknown()).nullable().optional(),
  level: z.number().int().min(0).max(3).optional(),
  ok: z.boolean().optional(),
  durationMs: z.number().int().optional(),
  ts: z.number().int(),
});
export type StepDetailEvent = z.infer<typeof StepDetailEventSchema>;

export const UsageEventSchema = z.object({
  taskId: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  ts: z.number().int(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const PauseTaskSchema = z.object({ taskId: z.string().min(1) });
export const ResumeTaskSchema = z.object({ taskId: z.string().min(1) });

// ---------------------------------------------------------------------------
// 断点续跑
// ---------------------------------------------------------------------------

export const ResumeInterruptedSchema = z.object({ taskId: z.string().min(1) });
export type ResumeInterruptedRequest = z.infer<typeof ResumeInterruptedSchema>;

/** 可续跑的中断任务（listInterrupted 返回项；checkpoint=A-M4 工件对账预览，仅长任务有） */
export const InterruptedTaskSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  steps: z.number().int(),
  status: z.string(),
  checkpoint: CheckpointPreviewSchema.optional(),
});
export type InterruptedTaskInfo = z.infer<typeof InterruptedTaskSchema>;
