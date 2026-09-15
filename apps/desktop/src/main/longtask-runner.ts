/**
 * longtask-runner.ts — 锚定长任务薄编排壳（规划 §3.5，A-M4 落点 / A-M7 装配完成）
 *
 * 不新建 runner 进程/状态机。本壳只做五件事（边界口诀见 §3.5 表）：
 * 1. 确保 longtask checkpoint 域建表（幂等版本戳迁移）；
 * 2. 持有对账器（checkpoint-store + longtask-reconcile 钩子装配）——
 *    写副作用工具的宿主自动登记经 orchestrator-executors / invokeAtom 流入；
 * 3. 经 custom-tools 注册 checkpoint 模型工具（Q5-C 双写的"模型显式"一路）；
 * 4. 锚定任务台账：orchestrator-launch 起跑时 attachWatchdog（句柄经
 *    anchor-watchdog-host.getAnchorWatchdog 取回），终态 untrack；
 * 5. 暴露 status() 给 UI 聚合「已锚定应用 + 进度 x/y + 剩余预算 + 看门狗态」
 *    （longtask:status 通道数据源，规划 §4.2/§4.4）。
 *
 * 单任务循环/三闸归 agent-core loop；任务生命周期/队列/审批归 orchestrator 家族；
 * mission 域 DAG/工件归 mission-runner——本壳一概不重复实现。
 *
 * 装配点（bootstrap.ts 组合根，勿在别处 new）：
 *   const longTaskRunner = createLongTaskRunner({
 *     db: audit.exposeDb(), customTools: orchestrator.customTools,
 *     currentTaskId: () => orchestrator.runningTaskIds[0] ?? null,
 *   });
 *   setLongTaskRunner(longTaskRunner);  // launch/IPC 侧经 getLongTaskRunner() 取用
 */
import type { MigrationDb } from './db-migrations';
import { applyLongtaskCheckpointSchema } from './longtask-db/checkpoint-migrations';
import { createCheckpointStore, type CheckpointStore } from './checkpoint-store';
import {
  buildPreview,
  probeArtifact,
  reconcileCheckpoint,
  runCheckpointTool,
  setCheckpointHooks,
  type ReconcileResult,
} from './longtask-reconcile';
import { CHECKPOINT_TOOL_ID, registerCheckpointTool, type CustomToolRuntime } from './custom-tools';
import { getAnchorWatchdog } from './anchor-watchdog-host';
import type { WatchdogReason, WatchdogState } from './anchor-watchdog';
import type { CheckpointPreview, TargetApp } from '../shared/schemas/longtask';

/** 起跑时登记的锚位台账（§4.2 控制条数据面；剩余时长在 status() 实时折算） */
export interface LongTaskLaunchMeta {
  targetApp?: TargetApp | null;
  /** 预算档位（与 BudgetGuard 同源；startedAt = guard 构造时刻） */
  budget?: { maxSteps: number; maxDurationMs: number; startedAt: number } | null;
}

/** UI 聚合用状态（§4.2 控制条数据面；budgetLeft.steps 由 handler 侧用审计步数补齐） */
export interface LongTaskStatus {
  /** 是否锚定任务（本壳台账在册；非锚定旧任务恒 false，零回归） */
  anchored: boolean;
  /** 锚定应用（「已锚定 [icon] 名称」展示源；未锚定 null） */
  targetApp: TargetApp | null;
  /** 最新检查点的业务游标；null=该任务尚无检查点（非锚定旧任务即此态） */
  progress: { done: number; total?: number; unit: string } | null;
  summary: string;
  /** 工件对账后的重做项数（0=断点仍新鲜） */
  redoCount: number;
  /** 看门狗态（未锚定/已终态 = null）与暂停原因（A-M7 横幅数据源） */
  watchdogState: WatchdogState | null;
  pauseReason: WatchdogReason;
  /** 剩余时长（ms，已扣除暂停冻结段）；未登记预算 = null */
  durationLeftMs: number | null;
  /** 档位步数上限（budgetLeft.steps = maxSteps - 已用步数，由 handler 补步骤数） */
  maxSteps: number | null;
}

export interface LongTaskRunnerDeps {
  /** 与 audit/mission/longtask 共库的 SQLite 连接（ZODB.exposeDb()） */
  db: MigrationDb;
  /** 复用 orchestrator 的自定义工具运行时：checkpoint 工具经 toolSchemas() 下发给模型 */
  customTools: CustomToolRuntime;
  /** 单并发恒 1：写检查点时刻的活动任务即当前任务（排队/未运行返回 null） */
  currentTaskId: () => string | null;
}

export interface LongTaskRunner {
  status(taskId: string): LongTaskStatus;
  /** §3.6 恢复预览（InterruptedBanner/后续 B 期增量共用同一对账口径） */
  preview(taskId: string): ReconcileResult | null;
  checkpointPreview(taskId: string): CheckpointPreview | undefined;
  store: CheckpointStore;
  /** A-M7 接线：起跑装配后登记锚位台账；看门狗句柄届时经 getAnchorWatchdog 解析 */
  attachWatchdog(taskId: string, meta?: LongTaskLaunchMeta): void;
  /** 任务终态清账（launch finally 调用） */
  untrack(taskId: string): void;
  /** 热重载/测试清理用：摘钩子并下线 checkpoint 工具 */
  dispose(): void;
}

export function createLongTaskRunner(deps: LongTaskRunnerDeps): LongTaskRunner {
  applyLongtaskCheckpointSchema(deps.db);
  const store = createCheckpointStore(deps.db);

  setCheckpointHooks({ store, currentTaskId: deps.currentTaskId });
  registerCheckpointTool(deps.customTools, runCheckpointTool);

  const latestCursorOf = (taskId: string) => store.latest(taskId);
  /** 锚定台账（taskId → 起跑元数据）：终态 untrack，容量天然受单并发约束 */
  const tracked = new Map<string, LongTaskLaunchMeta>();

  return {
    status(taskId) {
      const meta = tracked.get(taskId);
      if (!meta) {
        return {
          anchored: false, targetApp: null, progress: null, summary: '',
          redoCount: 0, watchdogState: null, pauseReason: '', durationLeftMs: null, maxSteps: null,
        };
      }
      const cp = latestCursorOf(taskId);
      const reconciled = cp ? reconcileCheckpoint(cp, probeArtifact) : null;
      const total = cp?.cursor.total;
      const watchdog = getAnchorWatchdog(taskId);
      let durationLeftMs: number | null = null;
      if (meta.budget) {
        const elapsed = Date.now() - meta.budget.startedAt - (watchdog?.pausedMs() ?? 0);
        durationLeftMs = Math.max(0, meta.budget.maxDurationMs - elapsed);
      }
      return {
        anchored: true,
        targetApp: meta.targetApp ?? null,
        progress: cp
          ? {
            done: cp.cursor.done,
            ...(total !== undefined ? { total } : {}),
            unit: cp.cursor.unit,
          }
          : null,
        summary: cp?.summary ?? '',
        redoCount: reconciled?.redoItems.length ?? 0,
        watchdogState: watchdog?.state() ?? null,
        pauseReason: watchdog?.reason() ?? '',
        durationLeftMs,
        maxSteps: meta.budget?.maxSteps ?? null,
      };
    },
    preview(taskId) {
      return reconcileCheckpoint(latestCursorOf(taskId), probeArtifact);
    },
    checkpointPreview(taskId) {
      return buildPreview(latestCursorOf(taskId));
    },
    store,
    attachWatchdog(taskId, meta) {
      tracked.set(taskId, { targetApp: meta?.targetApp ?? null, budget: meta?.budget ?? null });
    },
    untrack(taskId) {
      tracked.delete(taskId);
    },
    dispose() {
      setCheckpointHooks(null);
      deps.customTools.unregister(CHECKPOINT_TOOL_ID);
      tracked.clear();
    },
  };
}

/* A-M7 组合根持有的单例（bootstrap 装配；launch/IPC 经 getLongTaskRunner 取用）。
 * 未装配（e2e 早期/selftest 纯逻辑路径）返回 null，调用侧全部静默降级。 */
let runnerInstance: LongTaskRunner | null = null;

export function setLongTaskRunner(runner: LongTaskRunner | null): void {
  runnerInstance = runner;
}

export function getLongTaskRunner(): LongTaskRunner | null {
  return runnerInstance;
}
