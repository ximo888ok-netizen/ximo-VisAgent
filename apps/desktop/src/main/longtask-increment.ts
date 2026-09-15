/**
 * longtask-increment.ts — 长期任务增量游标 + 无人值守轮次收敛（B-M1/B-M2，规划 §2.4/§3.5）
 *
 * 一壳三责：
 * 1. 增量游标：每轮触发读 job.checkpointRef 指向上轮检查点的 cursor → 任务 prompt
 *    注入「从游标 X 继续，本轮处理增量」→ 以继承行 seed 新任务首个检查点
 *    （done 基数单调前进，宿主/模型双写路径天然在其上 +1，复用 task_checkpoints/
 *    对账器，不重造）。本轮 COMPLETED 才把游标写回 job；失败轮不推进（下次触发
 *    从原位续跑）。
 * 2. 无人值守收敛（复用 mission 域收敛语义，规划 §3.5 表：轮询任务终态回写，
 *    检查点写 longtask 域表）：pump 轮询审计库任务状态；任务挂起等待人工审批时
 *    job 标 paused-out-of-scope（超范围不静默执行、不静默失败——审批卡与微信
 *    出站已由 orchestrator-notify 既有通道覆盖，这里只做记账与岛事件流提示）。
 * 3. 重启续跑（resumeRunningMissions 在 longtask 域的等价物）：convergeOrphanRounds
 *    按审计库终态一次性收敛崩溃遗留轮次——已完成推进游标，中断轮不推进并标记
 *    failed（job 本体持久化在 scheduler.json，天然保留，下次 cron 到点续跑）。
 *
 * 触发链携带（B-M1）：startTask meta 带 targetApp/longTask/jobId；grant 生效判定
 * 在 approval-policy（非交互 ∧ job 级有效 grant 命中 → auto(preauth)，B1 修正），
 * 本文件只负责把 jobId 递进去 + 把 job 语义组装成 goal。
 *
 * 装配点：bootstrap.ts 组合根（registerIsland 之后——preauth 表须已建）；
 * index.ts 的 scheduler.runJob 经 getJobIncrementRunner() 取用（null = 未装配回落旧链路）。
 * 本文件禁止 import electron（vitest node 环境直跑；通知/派发全部闭包注入）。
 */
import type { MigrationDb } from './db-migrations';
import { applyLongtaskJobSchema } from './longtask-db/job-migrations';
import type { CheckpointStore } from './checkpoint-store';
import type { CheckpointCursor } from '../shared/schemas/longtask';
import type { JobPatch, JobRunResult, ScheduledJob, Scheduler } from './scheduler';

/** 审计库任务状态中仍在跑的（非终态）集合——与 mission-runner 收敛口径一致 */
const TASK_NOT_FINISHED = new Set(['RUNNING', 'QUEUED', 'PAUSED', 'WAITING_APPROVAL']);
const TASK_SUCCEEDED = 'COMPLETED';
/** 收敛中会观察到的活动态（含挂起等待人工） */
const ROUND_ACTIVE: ScheduledJob['lastRunStatus'][] = ['running', 'paused-out-of-scope'];

/** 依赖注入面（全部闭包，单测不碰 Electron/网络；job 读写走 Scheduler 窄面） */
export interface JobIncrementDeps {
  scheduler: Pick<Scheduler, 'list' | 'get' | 'patch'>;
  /** 无人值守派发：调用方闭包负责 interactive=false + targetApp/longTask/jobId 下传 */
  dispatch(job: ScheduledJob, goal: string): Promise<{ taskId: string }>;
  /** 审计库任务状态（orchestrator.getTaskStatus）；null = 查无此任务，按终态保守处理 */
  getTaskOutcome(taskId: string): string | null;
  /** 当前是否有挂起中的人工审批（超范围挂起徽标数据源，orchestrator.hasPendingApproval） */
  hasPendingApproval(taskId: string): boolean;
  /** task_checkpoints 仓储（longtask-runner 装配后可用；null = 游标功能未装配，轮次照跑不注入） */
  checkpoints(): CheckpointStore | null;
  /** 需要迁移的共库连接（bootstrap 注入 auditDb.exposeDb()；单测可注入内存库） */
  db: MigrationDb;
  /** 出站提示（岛事件流 logInfo；审批卡+微信出站走既有 orchestrator-notify 通道，不重复发） */
  notify(text: string): void;
  pollIntervalMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface JobIncrementRunner {
  /** 一次到点触发：busy 跳过 → 读游标注入 prompt → 派发 → seed 继承 → 起收敛 pump */
  startRound(job: ScheduledJob): Promise<JobRunResult>;
  /** 重启对账：崩溃遗留轮次按审计库终态一次性收敛（游标只在 COMPLETED 轮推进） */
  convergeOrphanRounds(): void;
  /** 等待全部收敛循环退出（单测确定性 + 退出前清理） */
  idle(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 增量批次 prompt 注入（规划 §2.4「从断点续跑」）：游标基数写进目标，
 * 明确「只处理增量、已完成不重做、检查点从基数继续累加」。
 */
export function buildIncrementGoal(goal: string, cursor: CheckpointCursor): string {
  const total = cursor.total ? `/${cursor.total}` : '';
  const last = cursor.lastItem ? `（最后一项: ${cursor.lastItem}）` : '';
  return [
    goal,
    '',
    `【增量批次】上轮已处理 ${cursor.done}${total} ${cursor.unit}${last}。`,
    `从游标继续，本轮只处理第 ${cursor.done + 1} ${cursor.unit}起的增量，已完成部分一律不重做；`,
    `登记进度/检查点时从 ${cursor.done} 之后累加计数，不要归零重数。`,
  ].join('\n');
}

/** 上轮游标解析：checkpointRef.taskId 的最新检查点 cursor（ref 缺失/表未装配 → null = 首轮） */
function previousCursor(store: CheckpointStore | null, ref: ScheduledJob['checkpointRef']): CheckpointCursor | null {
  if (!store || !ref) return null;
  try {
    return store.latest(ref.taskId)?.cursor ?? null;
  } catch (err) {
    console.warn('[longtask-increment] 游标读取失败（按首轮处理）:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 游标继承 seed：新任务首行检查点以旧 cursor 为基数（artifacts 空=不参与对账，只锚基数） */
function seedCursor(store: CheckpointStore | null, taskId: string, ref: ScheduledJob['checkpointRef'], cursor: CheckpointCursor): void {
  if (!store) return;
  try {
    store.append({
      taskId,
      kind: 'host',
      cursor,
      artifacts: [],
      summary: ref ? `增量游标继承（上轮 ${ref.taskId}#${ref.seq}）` : '增量游标继承',
    });
  } catch (err) {
    // seed 失败只降级为本轮从零计数（不炸任务链）；写回时仍按「更大者才推进」守护单调
    console.warn('[longtask-increment] 游标 seed 写入失败（本轮基数不继承）:', err instanceof Error ? err.message : err);
  }
}

export function createJobIncrementRunner(deps: JobIncrementDeps): JobIncrementRunner {
  applyLongtaskJobSchema(deps.db);
  const pollMs = deps.pollIntervalMs ?? 2_000;
  const sleep = deps.sleep ?? defaultSleep;
  const active = new Map<string, Promise<void>>();

  /** 轮次终态收敛：COMPLETED 且新游标严格前进才推进 checkpointRef；失败/中断轮不动游标 */
  function settleRound(jobId: string, taskId: string, outcome: string | null): void {
    const job = deps.scheduler.get(jobId);
    if (!job || job.lastTaskId !== taskId) return; // 已被新一轮覆盖，旧 pump 静默退出
    if (outcome === TASK_SUCCEEDED) {
      const cp = deps.checkpoints()?.latest(taskId) ?? null;
      const oldDone = previousCursor(deps.checkpoints(), job.checkpointRef)?.done ?? -1;
      const changes: JobPatch = { lastRunStatus: 'done', lastStatus: '成功' };
      // 单调前进钉死：本轮无检查点（纯阅读型批次）或 done 未超过基数 → 保持原 ref
      if (cp && cp.cursor.done > oldDone) {
        changes.checkpointRef = { taskId, seq: cp.seq };
        changes.lastStatus = `成功（游标 ${cp.cursor.done} ${cp.cursor.unit}）`;
      }
      deps.scheduler.patch(jobId, changes);
    } else {
      deps.scheduler.patch(jobId, {
        lastRunStatus: 'failed',
        lastStatus: `失败: 任务结束于 ${outcome ?? '未知状态'}（游标不推进，下轮从原位续跑）`,
      });
    }
    deps.notify(`长期任务「${job.name}」本轮${outcome === TASK_SUCCEEDED ? '完成' : '未成功'}，游标${outcome === TASK_SUCCEEDED ? '已前进' : '保持原位'}。`);
  }

  /** 超范围挂起观察：任务在等人工审批时标 paused-out-of-scope；批复恢复后回到 running */
  function observeSuspension(jobId: string, taskId: string, waiting: boolean): void {
    const job = deps.scheduler.get(jobId);
    if (!job || job.lastTaskId !== taskId) return;
    if (waiting && job.lastRunStatus !== 'paused-out-of-scope') {
      deps.scheduler.patch(jobId, {
        lastRunStatus: 'paused-out-of-scope',
        lastStatus: '挂起：超范围动作等待人工审批（岛/微信审批卡已推送）',
      });
      deps.notify(`长期任务「${job.name}」触发作用域外操作，已挂起等待人工审批（不自动执行，也不静默跳过）。`);
    } else if (!waiting && job.lastRunStatus === 'paused-out-of-scope') {
      deps.scheduler.patch(jobId, { lastRunStatus: 'running', lastStatus: '运行中' });
    }
  }

  function startPump(jobId: string, taskId: string): void {
    if (active.has(jobId)) return;
    const p = (async () => {
      for (;;) {
        // 先睡后查：给触发记账（scheduler.recordRun 写 running）落定，避免收敛补丁被覆写
        await sleep(pollMs);
        if (!deps.scheduler.get(jobId)) return; // job 已删除
        const outcome = deps.getTaskOutcome(taskId);
        if (outcome === null || !TASK_NOT_FINISHED.has(outcome)) {
          settleRound(jobId, taskId, outcome);
          return;
        }
        observeSuspension(jobId, taskId, deps.hasPendingApproval(taskId));
      }
    })().catch((err: Error) => {
      console.error('[longtask-increment] pump crashed', jobId, err);
    }).finally(() => active.delete(jobId));
    active.set(jobId, p);
  }

  return {
    async startRound(job) {
      // skipped-busy 判定：本轮触发时上轮还没收敛到终态 → 跳过并记账（不排队堆积）
      if (job.lastTaskId && ROUND_ACTIVE.includes(job.lastRunStatus)) {
        const prev = deps.getTaskOutcome(job.lastTaskId);
        if (prev !== null && TASK_NOT_FINISHED.has(prev)) {
          return { ok: true, status: 'skipped-busy' };
        }
      }
      const store = deps.checkpoints();
      const cursor = previousCursor(store, job.checkpointRef);
      const goal = cursor ? buildIncrementGoal(job.goal, cursor) : job.goal;
      let taskId: string;
      try {
        taskId = (await deps.dispatch(job, goal)).taskId;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '派发失败' };
      }
      if (cursor) seedCursor(store, taskId, job.checkpointRef, cursor);
      deps.scheduler.patch(job.id, { lastTaskId: taskId, lastRunStatus: 'running', lastStatus: '运行中' });
      startPump(job.id, taskId);
      return { ok: true, status: 'started' };
    },
    convergeOrphanRounds() {
      for (const job of deps.scheduler.list()) {
        if (!job.lastTaskId || !ROUND_ACTIVE.includes(job.lastRunStatus)) continue;
        const outcome = deps.getTaskOutcome(job.lastTaskId);
        if (outcome !== null && !TASK_NOT_FINISHED.has(outcome)) {
          // 崩溃前任务已到终态（收敛没跑完）：按真实终态补收敛，COMPLETED 照常推进游标
          settleRound(job.id, job.lastTaskId, outcome);
          continue;
        }
        // 本进程没有循环在等它（mission-runner 同款裁决）：中断轮不推进游标，
        // 标记失败等待下次 cron 从原位续跑；job 本体在 scheduler.json，重启天然保留
        deps.scheduler.patch(job.id, {
          lastRunStatus: 'failed',
          lastStatus: '重启中断：上轮未收敛到终态，游标保持原位，下次触发从断点续跑',
        });
        deps.notify(`长期任务「${job.name}」上次运行被重启打断，游标未推进，将在下次触发时从断点续跑。`);
      }
    },
    async idle() {
      while (active.size > 0) {
        await Promise.allSettled([...active.values()]);
      }
    },
  };
}

/* 组合根持有的单例（bootstrap 装配；index.ts runJob 经 getJobIncrementRunner 取用）。
 * 未装配（e2e 早期/selftest 纯逻辑路径）返回 null，调用侧回落旧触发链。 */
let incrementInstance: JobIncrementRunner | null = null;

export function setJobIncrementRunner(runner: JobIncrementRunner | null): void {
  incrementInstance = runner;
}

export function getJobIncrementRunner(): JobIncrementRunner | null {
  return incrementInstance;
}
