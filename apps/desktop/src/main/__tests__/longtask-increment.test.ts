/**
 * longtask-increment.test.ts — B-M1/B-M2 回归钉死
 *
 * 1. 无人值守 demo job 零弹窗：非交互 + 岛不可见 + job 级有效 grant 命中 → auto(preauth)，
 *    requestUI 零调用（B1 修正经触发链打通的装配级证据）；未 ack 的 job grant 不豁免（负向）。
 * 2. 超范围必挂起负向：grant 不命中 → ask 挂起（requestUI 返回 null = 不执行也不静默失败）；
 *    pump 观察等待人工期间 job=paused-out-of-scope 并出站提示，批复后照常收敛。
 * 3. 每 2 分钟 demo job 3 连触发：seed 继承 + 「更大者才推进」→ 游标 1→2→3 单调前进，
 *    第 2/3 轮 goal 注入「从游标 X 继续，本轮处理增量」；轮未终态时再触发 = skipped-busy。
 * 4. 重启后 job 保留续跑：convergeOrphanRounds——中断轮游标原位标记失败；崩溃前已终态
 *    补推进游标；下一轮 goal 携带游标。失败轮不推进（终态 FAILED 即使写过检查点）。
 *
 * 真件：Scheduler(JSON 文件) / preauth-store / checkpoint-store（node:sqlite）；
 * 假件：派发/任务状态/挂起探针 + 步进 sleep（先让出一个宏任务再执行世界步，
 * 保证 scheduler.recordRun 的 running 记账先于 pump 收敛补丁落定）。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { MigrationDb } from '../db-migrations';
import { applyLongtaskCheckpointSchema } from '../longtask-db/checkpoint-migrations';
import { applyLongtaskPreauthSchema } from '../longtask-db/preauth-migrations';
import { createCheckpointStore } from '../checkpoint-store';
import { createPreauthStore } from '../preauth-store';
import { Scheduler, type ScheduledJob } from '../scheduler';
import { buildIncrementGoal, createJobIncrementRunner, type JobIncrementRunner } from '../longtask-increment';
import { createApprovalGate, type ApprovalGateOp } from '../orchestrator-approval';
import type { ScopePackage } from '../../shared/schemas/longtask';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean { return false; }
    show(): void { /* 测试环境无桌面 */ }
  },
}));
vi.mock('../windows/island', () => ({ publishStep: vi.fn() }));

function toMigrationDb(sync: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => sync.exec(sql),
    prepare: (sql) => {
      const st = sync.prepare(sql) as {
        run: (...p: (string | number | null)[]) => unknown;
        get: (...p: (string | number | null)[]) => unknown;
        all: (...p: (string | number | null)[]) => unknown[];
      };
      return {
        run: (...p) => st.run(...(p as (string | number | null)[])),
        get: (...p) => st.get(...(p as (string | number | null)[])),
        all: (...p) => st.all(...(p as (string | number | null)[])),
      };
    },
  };
}

const noopAudit = {
  insert: () => undefined,
  fromAgentEvent: (taskId: string, ev: Record<string, unknown>): AuditEvent =>
    ({ id: 'r', taskId, seq: 0, kind: String(ev.type ?? '') as AuditEvent['kind'], timestamp: 1, detail: ev }),
};

const scope: ScopePackage = {
  appId: 'app-kingdee',
  dirs: ['C:/发票/**'],
  opClasses: ['click', 'type_text', 'file_write'],
  sensitiveExcludes: ['删除'],
  budget: { maxDurationMs: 3_600_000, maxSteps: 600, maxTokens: 8_000_000 },
};

const delay0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface World {
  file: string;
  sched: Scheduler;
  runner: JobIncrementRunner;
  job: ScheduledJob;
  store: ReturnType<typeof createCheckpointStore>;
  grants: ReturnType<typeof createPreauthStore>;
  outcomes: Map<string, string>;
  pending: Set<string>;
  dispatched: Array<{ taskId: string; goal: string }>;
  notes: string[];
  steps: Array<() => void>;
}

function makeWorld(cron = '*/2 * * * *'): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-increment-'));
  const file = path.join(dir, 'scheduler.json');
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskCheckpointSchema(db);
  applyLongtaskPreauthSchema(db);
  const store = createCheckpointStore(db);
  const grants = createPreauthStore(db);
  const w: Partial<World> = {
    file, store, grants,
    outcomes: new Map<string, string>(),
    pending: new Set<string>(),
    dispatched: [],
    notes: [],
    steps: [],
  };
  let seq = 0;
  const runner = createJobIncrementRunner({
    scheduler: {
      list: () => w.sched!.list(),
      get: (id) => w.sched!.get(id),
      patch: (id, c) => w.sched!.patch(id, c),
    },
    dispatch: async (job, goal) => {
      const taskId = `t${++seq}`;
      (w.dispatched as Array<{ taskId: string; goal: string }>).push({ taskId, goal });
      (w.outcomes as Map<string, string>).set(taskId, 'RUNNING');
      return { taskId };
    },
    getTaskOutcome: (id) => (w.outcomes as Map<string, string>).get(id) ?? null,
    hasPendingApproval: (id) => (w.pending as Set<string>).has(id),
    checkpoints: () => w.store!,
    db,
    notify: (t) => { (w.notes as string[]).push(t); },
    pollIntervalMs: 0,
    sleep: async () => {
      await delay0(); // 让出宏任务：recordRun 的 running 记账先落定
      const step = (w.steps as Array<() => void>).shift();
      if (step) step();
    },
  });
  const sched = new Scheduler(file, { runJob: (job) => runner.startRound(job) });
  const job = sched.create({ name: '发票增量录入', goal: '把今日发票录入金蝶', cron });
  Object.assign(w, { sched, runner, job });
  return w as World;
}

function appendCheckpoint(w: World, taskId: string, done: number): void {
  w.store.append({
    taskId,
    kind: 'host',
    cursor: { done, unit: '张发票' },
    artifacts: [{ path: `C:/发票/out/${done}.json`, contentHash: `h-${done}`, role: 'output' }],
    summary: `已录入 ${done} 张发票`,
  });
}

/** 触发一轮（steps 在 pump 每次轮询前执行一个；最后一个步必须把任务推到终态） */
async function tickRound(w: World, steps: Array<() => void>): Promise<void> {
  w.steps.push(...steps);
  w.sched.patch(w.job.id, { nextRunAt: Date.now() - 1000 });
  await w.sched.tick();
  await w.runner.idle();
}

function cleanup(w: World): void {
  try { fs.rmSync(path.dirname(w.file), { recursive: true, force: true }); } catch { /* 尽力 */ }
}

describe('buildIncrementGoal（游标注入文案）', () => {
  it('带上轮 done/total/lastItem，明示只处理增量且计数不归零', () => {
    const goal = buildIncrementGoal('录入发票', { done: 17, total: 30, unit: '张发票', lastItem: 'fp-17.xlsx' });
    expect(goal).toContain('【增量批次】');
    expect(goal).toContain('上轮已处理 17/30 张发票（最后一项: fp-17.xlsx）');
    expect(goal).toContain('第 18 张发票起的增量');
    expect(goal).toContain('不要归零重数');
  });
});

describe('无人值守 demo job 零弹窗（B1 修正 × job 级 grant 触发链）', () => {
  function jobGate(w: World, requestUI: (id: string, op: ApprovalGateOp) => Promise<{ action: 'reject' } | null>) {
    return createApprovalGate({
      audit: noopAudit,
      getConfigMode: () => 'auto',
      isE2E: false,
      timeoutMs: 1000,
      escalatedLevel: (op: ApprovalGateOp) => op.level ?? 2,
      announce: vi.fn(),
      auraRequest: vi.fn(),
      requestUI,
      islandVisible: () => false, // 无人值守：岛可以不在场
      grantRepo: {
        listActiveForTask: (taskId) => w.grants.listActiveForTask(taskId),
        listActiveForJob: (jobId) => w.grants.listActiveForJob(jobId),
      },
    }, { taskId: 't-round', interactive: false, jobId: w.job.id });
  }

  it('非交互 + job grant（acked∧active∧未过期）命中作用域 → auto(preauth)，requestUI 零调用', async () => {
    const w = makeWorld();
    const grant = w.grants.create({ scope });
    expect(w.grants.bindJob(grant.id, w.job.id)).toBe(true);
    expect(w.grants.ack(grant.id)).toBe(true);
    const requestUI = vi.fn(async () => null);
    const decision = await jobGate(w, requestUI)('ap-1', { tool: 'mouse_click', args: { x: 1, y: 2 }, reason: '点提交', level: 2, appName: '金蝶KIS' });
    expect(requestUI).not.toHaveBeenCalled(); // 零弹窗
    expect(decision?.action).toBe('approve');
    // 走的确实是 job 一路：task 绑定为空
    expect(w.grants.listActiveForTask('t-round')).toHaveLength(0);
    expect(w.grants.listActiveForJob(w.job.id)).toHaveLength(1);
    cleanup(w);
  });

  it('负向：job grant 未 ack → 即使 autonomous 之外来源齐备也照常 ask（弹窗挂起）', async () => {
    const w = makeWorld();
    const grant = w.grants.create({ scope });
    w.grants.bindJob(grant.id, w.job.id); // 不 ack
    const requestUI = vi.fn(async () => null);
    await jobGate(w, requestUI)('ap-1', { tool: 'mouse_click', args: {}, reason: 'r', level: 2 });
    expect(requestUI).toHaveBeenCalledTimes(1);
    cleanup(w);
  });
});

describe('超范围必挂起（不静默执行、不静默失败）', () => {
  it('gate：作用域外写入 / 敏感排除命中 → ask 挂起等人工（无决定即无放行）', async () => {
    const w = makeWorld();
    const grant = w.grants.create({ scope });
    w.grants.bindJob(grant.id, w.job.id);
    w.grants.ack(grant.id);
    const requestUI = vi.fn(async () => null); // 无人应答：挂起
    const gate = createApprovalGate({
      audit: noopAudit,
      getConfigMode: () => 'autonomous',
      isE2E: false, timeoutMs: 1000,
      escalatedLevel: (op: ApprovalGateOp) => op.level ?? 2,
      announce: vi.fn(), auraRequest: vi.fn(), requestUI, islandVisible: () => true,
      grantRepo: {
        listActiveForTask: (taskId) => w.grants.listActiveForTask(taskId),
        listActiveForJob: (jobId) => w.grants.listActiveForJob(jobId),
      },
    }, { taskId: 't-ask', interactive: false, jobId: w.job.id });
    // file_write 在 opClasses 里但目录在作用域外 → miss → ask
    const d1 = await gate('ap-1', { tool: 'file_write', args: { path: 'C:/Windows/system.ini' }, reason: '写系统文件', level: 2 });
    expect(d1).toBeNull();
    // 命中作用域但按钮文本触敏感排除 → 强制 ask（不可被作用域覆盖）
    const d2 = await gate('ap-2', { tool: 'mouse_click', args: { x: 1, y: 2 }, reason: 'r', level: 2, appName: '删除全部记录' });
    expect(d2).toBeNull();
    expect(requestUI).toHaveBeenCalledTimes(2);
    cleanup(w);
  });

  it('pump：等待人工期间 job=paused-out-of-scope + 出站提示；批复后回到 running 并正常收敛', async () => {
    const w = makeWorld();
    const seen: Array<ScheduledJob['lastRunStatus']> = [];
    await tickRound(w, [
      () => w.pending.add('t1'),                      // 超范围动作挂起等人工
      () => { seen.push(w.sched.get(w.job.id)?.lastRunStatus); },
      () => { w.pending.delete('t1'); },              // 人工批复
      () => w.outcomes.set('t1', 'COMPLETED'),
    ]);
    expect(seen).toEqual(['paused-out-of-scope']);
    expect(w.notes.some((n) => n.includes('挂起等待人工审批'))).toBe(true);
    expect(w.sched.get(w.job.id)?.lastRunStatus).toBe('done');
    cleanup(w);
  });
});

describe('3 连触发游标单调前进 + skipped-busy + 失败轮不推进', () => {
  it('done 1→2→3 严格前进；goal 注入上轮游标；轮在跑时再触发 = skipped-busy', async () => {
    const w = makeWorld();
    const done = () => {
      const ref = w.sched.get(w.job.id)?.checkpointRef;
      return ref ? w.store.latest(ref.taskId)?.cursor.done ?? -1 : -1;
    };
    // 轮 1（首轮：无游标不注入）
    await tickRound(w, [() => appendCheckpoint(w, 't1', 1), () => w.outcomes.set('t1', 'COMPLETED')]);
    expect(w.dispatched[0]?.goal).toBe('把今日发票录入金蝶');
    expect(done()).toBe(1);
    // 轮 2：注入「从游标 1 继续」+ seed 继承行
    await tickRound(w, [() => appendCheckpoint(w, 't2', 2), () => w.outcomes.set('t2', 'COMPLETED')]);
    expect(w.dispatched[1]?.goal).toContain('【增量批次】');
    expect(w.dispatched[1]?.goal).toContain('上轮已处理 1');
    expect(w.store.list('t2').find((cp) => cp.summary.includes('游标继承'))?.cursor.done).toBe(1);
    expect(done()).toBe(2);
    // 轮 3 起跑后（未终态）再触发：skipped-busy，不重复派发
    w.sched.patch(w.job.id, { nextRunAt: Date.now() - 1000 });
    await w.sched.tick();
    const busy = await w.runner.startRound(w.sched.get(w.job.id)!);
    expect(busy).toEqual({ ok: true, status: 'skipped-busy' });
    expect(w.dispatched).toHaveLength(3);
    // 轮 3 收敛：done=3
    w.steps.push(() => appendCheckpoint(w, 't3', 3));
    await delay0();
    w.outcomes.set('t3', 'COMPLETED');
    await w.runner.idle();
    expect(done()).toBe(3);
    expect(w.sched.get(w.job.id)?.lastRunStatus).toBe('done');
    cleanup(w);
  });

  it('失败轮即使写了检查点也不推进游标；完成但零检查点的轮保持原位', async () => {
    const w = makeWorld();
    await tickRound(w, [() => appendCheckpoint(w, 't1', 4), () => w.outcomes.set('t1', 'COMPLETED')]);
    const ref1 = w.sched.get(w.job.id)?.checkpointRef;
    await tickRound(w, [() => appendCheckpoint(w, 't2', 9), () => w.outcomes.set('t2', 'FAILED')]);
    expect(w.sched.get(w.job.id)?.checkpointRef).toEqual(ref1);
    expect(w.sched.get(w.job.id)?.lastRunStatus).toBe('failed');
    expect(w.sched.get(w.job.id)?.lastStatus).toContain('游标不推进');
    await tickRound(w, [() => w.outcomes.set('t3', 'COMPLETED')]);
    expect(w.sched.get(w.job.id)?.checkpointRef).toEqual(ref1);
    expect(w.sched.get(w.job.id)?.lastRunStatus).toBe('done');
    cleanup(w);
  });
});

describe('重启后 job 保留续跑（convergeOrphanRounds）', () => {
  it('中断轮游标原位标失败；崩溃前已终态补推进；下一轮 goal 携带游标', async () => {
    const w = makeWorld('0 9 * * *');
    // 模拟遗留态：轮 rX 在跑时进程死亡（job 持久化在 scheduler.json）
    w.sched.patch(w.job.id, { lastTaskId: 'rX', lastRunStatus: 'running' });
    // ---- 重启：新 Scheduler 读同一文件 + 新 runner ----
    const outcomes2 = new Map<string, string>(); // 审计库里 rX 仍是 RUNNING（崩溃残留）
    const sync = new DatabaseSync(':memory:');
    const db = toMigrationDb(sync);
    applyLongtaskCheckpointSchema(db);
    const store2 = createCheckpointStore(db);
    const notes2: string[] = [];
    const mkRunner = (sched: Scheduler): { runner: JobIncrementRunner; goals: string[] } => {
      const goals: string[] = [];
      const runner = createJobIncrementRunner({
        scheduler: { list: () => sched.list(), get: (id) => sched.get(id), patch: (id, c) => sched.patch(id, c) },
        dispatch: async (job, goal) => { goals.push(goal); outcomes2.set(`n-${job.id}`, 'RUNNING'); return { taskId: `n-${job.id}` }; },
        getTaskOutcome: (id) => outcomes2.get(id) ?? null,
        hasPendingApproval: () => false,
        checkpoints: () => store2,
        db,
        notify: (t) => { notes2.push(t); },
        pollIntervalMs: 0,
        sleep: delay0,
      });
      return { runner, goals };
    };
    const revived = new Scheduler(w.file, { runJob: async () => ({ ok: true }) });
    expect(revived.get(w.job.id)?.name).toBe('发票增量录入'); // job 保留
    const r1 = mkRunner(revived);
    r1.runner.convergeOrphanRounds();
    const after = revived.get(w.job.id)!;
    expect(after.lastRunStatus).toBe('failed'); // 中断轮不推进
    expect(after.checkpointRef).toBeUndefined();
    expect(notes2.some((n) => n.includes('重启打断'))).toBe(true);
    // 崩溃前实际已完成的轮（审计库 COMPLETED + rY 已写检查点）：收敛补推进游标
    store2.append({ taskId: 'rY', kind: 'host', cursor: { done: 5, unit: '份' }, artifacts: [{ path: 'C:/rep/5.pdf', contentHash: 'h5', role: 'output' }], summary: '已汇总 5 份' });
    revived.patch(w.job.id, { lastTaskId: 'rY', lastRunStatus: 'running' });
    outcomes2.set('rY', 'COMPLETED');
    r1.runner.convergeOrphanRounds();
    const settled = revived.get(w.job.id)!;
    expect(settled.lastRunStatus).toBe('done');
    expect(settled.checkpointRef).toEqual({ taskId: 'rY', seq: 1 });
    // 续跑：新一轮触发 goal 携带游标 5（rY#1 是最新检查点）
    await r1.runner.startRound(revived.get(w.job.id)!);
    expect(r1.goals[0]).toContain('【增量批次】');
    expect(r1.goals[0]).toContain('上轮已处理 5');
    outcomes2.set(`n-${w.job.id}`, 'COMPLETED');
    await r1.runner.idle();
    cleanup(w);
  });
});
