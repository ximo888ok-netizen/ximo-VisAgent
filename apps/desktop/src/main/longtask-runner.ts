/**
 * longtask-runner.ts — 锚定长任务薄编排壳（规划 §3.5，A-M4 落点）
 *
 * 不新建 runner 进程/状态机。本壳只做四件事（边界口诀见 §3.5 表）：
 * 1. 确保 longtask checkpoint 域建表（幂等版本戳迁移）；
 * 2. 持有对账器（checkpoint-store + longtask-reconcile 钩子装配）——
 *    写副作用工具的宿主自动登记经 orchestrator-executors → setCheckpointHooks 流入；
 * 3. 经 custom-tools 注册 checkpoint 模型工具（Q5-C 双写的"模型显式"一路）；
 * 4. 暴露 status()/preview() 给 UI 聚合「进度 x/y + 剩余预算」。
 *
 * 单任务循环/三闸归 agent-core loop；任务生命周期/队列/审批归 orchestrator 家族；
 * mission 域 DAG/工件归 mission-runner——本壳一概不重复实现。
 * 看门狗（A-M3 的 anchor-watchdog-host 句柄）后续经 attachWatchdog 挂接，见文末槽位。
 *
 * 装配点（bootstrap.ts 组合根，勿在别处 new）：
 *   const longTaskRunner = createLongTaskRunner({
 *     db: audit.exposeDb(), customTools: orchestrator.customTools,
 *     currentTaskId: () => orchestrator.runningTaskIds[0] ?? null,
 *   });
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
import type { CheckpointPreview } from '../shared/schemas/longtask';

/** UI 聚合用状态（§4.2 控制条数据面；剩余预算由调用方与 orchestrator 侧拼装） */
export interface LongTaskStatus {
  /** 最新检查点的业务游标；null=该任务尚无检查点（非锚定旧任务即此态） */
  progress: { done: number; total?: number; unit: string } | null;
  summary: string;
  /** 工件对账后的重做项数（0=断点仍新鲜） */
  redoCount: number;
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
  /** 热重载/测试清理用：摘钩子并下线 checkpoint 工具 */
  dispose(): void;
}

export function createLongTaskRunner(deps: LongTaskRunnerDeps): LongTaskRunner {
  applyLongtaskCheckpointSchema(deps.db);
  const store = createCheckpointStore(deps.db);

  setCheckpointHooks({ store, currentTaskId: deps.currentTaskId });
  registerCheckpointTool(deps.customTools, runCheckpointTool);

  const latestCursorOf = (taskId: string) => store.latest(taskId);

  return {
    status(taskId) {
      const cp = latestCursorOf(taskId);
      if (!cp) {
        return { progress: null, summary: '', redoCount: 0 };
      }
      const reconciled = reconcileCheckpoint(cp, probeArtifact);
      const total = cp.cursor.total;
      return {
        progress: {
          done: cp.cursor.done,
          ...(total !== undefined ? { total } : {}),
          unit: cp.cursor.unit,
        },
        summary: cp.summary,
        redoCount: reconciled?.redoItems.length ?? 0,
      };
    },
    preview(taskId) {
      return reconcileCheckpoint(latestCursorOf(taskId), probeArtifact);
    },
    checkpointPreview(taskId) {
      return buildPreview(latestCursorOf(taskId));
    },
    store,
    dispose() {
      setCheckpointHooks(null);
      deps.customTools.unregister(CHECKPOINT_TOOL_ID);
    },
  };
}

/* A-M3 挂接槽位（勿在此发明逻辑）：orchestrator-launch 在 targetApp 存在时构造
 * anchor-watchdog-host，把句柄交给本壳持有并随任务终态 stop()——
 * 届时以 `attachWatchdog(host)` 方法扩展，行预算已按 §3.5 预留。 */
