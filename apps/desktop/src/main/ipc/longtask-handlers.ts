/**
 * longtask-handlers.ts — 锚定长任务聚合态 IPC handler（A-M7，规划 §4.2/§4.4）
 *
 * 两通道：longtask:status（控制条 1s 轮询）与 longtask:checkpoints（恢复预览）。
 * handler 只做「Zod 复校 → runner 聚合 + 审计步数拼装 → {ok,data|error}」；
 * 进度/对账/看门狗逻辑全部在 longtask-runner 与 anchor-watchdog-host，这里不发明判定。
 */
import { ipcMain } from 'electron';
import {
  ISLAND_CHANNELS,
  LongTaskCheckpointSummarySchema,
  LongTaskQuerySchema,
  LongTaskStatusPayloadSchema,
} from '../../shared/island-contracts';
import type { LongTaskStatusPayload } from '../../shared/island-contracts';
import type { LongTaskRunner, LongTaskStatus } from '../longtask-runner';

export interface LongTaskHandlerDeps {
  runner: LongTaskRunner;
  /** 已用步数（审计里有实际动作的步骤，装配方经 orchestrator 提供，与重试骨架同口径） */
  stepsUsed(taskId: string): number;
}

let longTaskRegistered = false;

/** runner 聚合态 + 审计步数 → 通道契约（非锚定任务提前返回，零 DB 读取） */
export function buildLongTaskStatusPayload(st: LongTaskStatus, usedSteps: number): LongTaskStatusPayload {
  const budgetLeft: LongTaskStatusPayload['budgetLeft'] = {};
  if (st.durationLeftMs !== null) budgetLeft.durationMs = st.durationLeftMs;
  if (st.maxSteps !== null) budgetLeft.steps = Math.max(0, st.maxSteps - usedSteps);
  const hasBudget = budgetLeft.durationMs !== undefined || budgetLeft.steps !== undefined;
  return {
    anchored: st.anchored,
    ...(st.targetApp ? { targetApp: st.targetApp } : {}),
    ...(st.progress ? { progress: st.progress } : {}),
    summary: st.summary,
    redoCount: st.redoCount,
    ...(hasBudget ? { budgetLeft } : {}),
    ...(st.watchdogState ? { watchdogState: st.watchdogState } : {}),
    ...(st.pauseReason ? { pauseReason: st.pauseReason } : {}),
  };
}

export function registerLongTaskHandlers(deps: LongTaskHandlerDeps): void {
  if (longTaskRegistered) return;
  longTaskRegistered = true;

  ipcMain.handle(ISLAND_CHANNELS.longtaskStatus, async (_e, raw: unknown) => {
    const parsed = LongTaskQuerySchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid longtask:status payload' };
    try {
      const st = deps.runner.status(parsed.data.taskId);
      const payload = buildLongTaskStatusPayload(st, deps.stepsUsed(parsed.data.taskId));
      return { ok: true as const, data: LongTaskStatusPayloadSchema.parse(payload) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'longtask:status failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.longtaskCheckpoints, async (_e, raw: unknown) => {
    const parsed = LongTaskQuerySchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid longtask:checkpoints payload' };
    try {
      const rows = deps.runner.store.list(parsed.data.taskId).map((cp) => ({
        seq: cp.seq,
        kind: cp.kind,
        done: cp.cursor.done,
        ...(cp.cursor.total !== undefined ? { total: cp.cursor.total } : {}),
        unit: cp.cursor.unit,
        summary: cp.summary,
        artifactCount: cp.artifacts.length,
        createdAt: cp.createdAt,
      }));
      return { ok: true as const, data: LongTaskCheckpointSummarySchema.array().parse(rows) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'longtask:checkpoints failed' };
    }
  });
}
