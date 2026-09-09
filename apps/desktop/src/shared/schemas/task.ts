/**
 * 任务域 schema：任务提交/排队/终态推送/步骤详情/用量/暂停恢复/断点续跑
 */
import { z } from "zod";

export const StartTaskSchema = z.object({
  goal: z.string().min(1, "任务描述不能为空").max(2000, "任务描述过长（上限 2000 字符）"),
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

export const CancelTaskSchema = z.object({
  taskId: z.string().min(1),
});

/** 任务终态推送 payload（main -> renderer） */
export const TaskFinishedSchema = z.object({
  taskId: z.string().min(1),
  status: z.string(),
  finalAnswer: z.string(),
  steps: z.number().int(),
  totalTokens: z.number().int(),
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

/** 可续跑的中断任务（listInterrupted 返回项） */
export const InterruptedTaskSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  steps: z.number().int(),
  status: z.string(),
});
export type InterruptedTaskInfo = z.infer<typeof InterruptedTaskSchema>;
