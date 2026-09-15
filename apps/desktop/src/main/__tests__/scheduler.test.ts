/**
 * scheduler.test.ts — B-M2 调度语义钉死（skipped-busy + 错过合并 + B 期载荷持久化）
 *
 * 纯 fs/JSON + 注入回调，不碰 electron/orchestrator：tick() 直接驱动（start 的
 * setInterval 路径不在此覆盖）。错过合并语义 = 用户确认参数（Q8）：多个错过的
 * 触发点合并为最近 1 次补跑，mergedInto 记「从哪个槽位并到哪一轮」供 UI 展示。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler, nextRunAt, type JobRunResult, type ScheduledJob } from '../scheduler';

const MIN = 60_000;

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-sched-'));
  return path.join(dir, 'scheduler.json');
}

function makeScheduler(callbacks: (job: ScheduledJob) => Promise<JobRunResult>, file = tempFile()) {
  return new Scheduler(file, { runJob: callbacks });
}

describe('错过合并（合并补跑 1 次，mergedInto 记账）', () => {
  let file: string;
  beforeEach(() => { file = tempFile(); });
  afterEach(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* 清理尽力 */ } });

  it('离线补跑：多个错过槽位只跑 1 次，mergedInto 记 fromAt/count，计划不堆积', async () => {
    const sched = makeScheduler(async () => ({ ok: true, status: 'started' }), file);
    const job = sched.create({ name: '日报', goal: '生成日报', cron: '*/30 * * * *' });
    const now = Date.now();
    // 模拟离线 3 小时：nextRunAt 停在 3h 前（重启后 load 会按 cron 重算，直接 patch 更确定）
    sched.patch(job.id, { nextRunAt: now - 185 * MIN });
    let calls = 0;
    const sched2 = makeScheduler(async () => { calls++; return { ok: true, status: 'started' }; }, file);
    await sched2.tick();
    expect(calls).toBe(1); // 合并为最近 1 次补跑，不逐槽堆积
    const after = sched2.get(job.id);
    expect(after?.mergedInto).toBeDefined();
    expect(after?.mergedInto!.count).toBeGreaterThanOrEqual(5); // 185min/30 ≈ 6 个槽，1 个本轮、≥5 个并入
    expect(after?.mergedInto!.fromAt).toBe(now - 185 * MIN);
    expect(after?.mergedInto!.intoAt).toBeLessThanOrEqual(now);
    expect(after?.nextRunAt).not.toBeNull();
    expect(after!.nextRunAt!).toBeGreaterThan(Date.now()); // 计划推进到未来，不残留旧槽
  });

  it('按时触发（仅 1 个槽位）：不写 mergedInto', async () => {
    const sched = makeScheduler(async () => ({ ok: true }), file);
    const job = sched.create({ name: '每分钟', goal: 'g', cron: '* * * * *' });
    await sched.tick(); // nextRunAt(创建时)=未来 → 不触发
    expect(sched.get(job.id)?.lastRunAt).toBeNull();
    sched.patch(job.id, { nextRunAt: Date.now() });
    await sched.tick();
    const after = sched.get(job.id);
    expect(after?.lastRunStatus).toBe('done');
    expect(after?.mergedInto).toBeUndefined();
  });
});

describe('skipped-busy（上轮还在跑就跳过并记账）', () => {
  it('回调报 skipped-busy：记 skipped-busy、计划照常推进、不写 mergedInto', async () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true, status: 'skipped-busy' }), file);
    const job = sched.create({ name: '慢活', goal: 'g', cron: '*/30 * * * *' });
    sched.patch(job.id, { nextRunAt: Date.now() - 95 * MIN, lastRunStatus: 'running' });
    await sched.tick();
    const after = sched.get(job.id);
    expect(after?.lastRunStatus).toBe('skipped-busy');
    expect(after?.lastStatus).toContain('跳过');
    expect(after!.nextRunAt!).toBeGreaterThan(Date.now()); // 不排队堆积
    expect(after?.mergedInto).toBeUndefined();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('回调抛错：failed + 人话 lastStatus', async () => {
    const file = tempFile();
    const sched = makeScheduler(async () => { throw new Error('派发炸了'); }, file);
    const job = sched.create({ name: 'x', goal: 'g', cron: '* * * * *' });
    sched.patch(job.id, { nextRunAt: Date.now() });
    await sched.tick();
    expect(sched.get(job.id)?.lastRunStatus).toBe('failed');
    expect(sched.get(job.id)?.lastStatus).toContain('派发炸了');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('B 期载荷（targetApp/grantId/longTask/cursor 引用）持久化', () => {
  it('create 携带 B 期字段 → 重启（新实例读同一文件）原样保留', () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true }), file);
    const targetApp = { id: 'app1', name: '金蝶', exePath: 'C:/kingdee/kis.exe', iconRef: '', procFamily: ['kis.exe'] };
    const job = sched.create({
      name: '录发票', goal: '把今日发票录入', cron: '0 9 * * *',
      targetApp, grantId: 'g_aaaaaaaaaaaa', longTask: { maxSteps: 300 }, sourceTaskId: 't-src',
    });
    sched.patch(job.id, { checkpointRef: { taskId: 't1', seq: 7 }, lastTaskId: 't1', lastRunStatus: 'done' });
    const revived = makeScheduler(async () => ({ ok: true }), file);
    const j = revived.get(job.id);
    expect(j?.targetApp).toEqual(targetApp);
    expect(j?.grantId).toBe('g_aaaaaaaaaaaa');
    expect(j?.longTask).toEqual({ maxSteps: 300 });
    expect(j?.sourceTaskId).toBe('t-src');
    expect(j?.checkpointRef).toEqual({ taskId: 't1', seq: 7 });
    expect(j?.lastRunStatus).toBe('done');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('patch 合并语义：undefined 不写、未点名旧字段不动；未知 id 返回 false', () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true }), file);
    const job = sched.create({ name: 'x', goal: 'g', cron: '* * * * *' });
    sched.patch(job.id, { lastRunStatus: 'running', lastTaskId: 't9' });
    sched.patch(job.id, { lastRunStatus: 'done' });
    const j = sched.get(job.id);
    expect(j?.lastRunStatus).toBe('done');
    expect(j?.lastTaskId).toBe('t9');
    expect(j?.goal).toBe('g');
    expect(sched.patch('nope', { lastRunStatus: 'failed' })).toBe(false);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('既有语义回归钉死', () => {
  it('旧 job（无 B 期字段）触发链行为不变：成功记 lastStatus 成功、toggle/delete 照常', async () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true }), file);
    const job = sched.create({ name: '旧活', goal: 'g', cron: '* * * * *' });
    sched.patch(job.id, { nextRunAt: Date.now() });
    await sched.tick();
    const j = sched.get(job.id);
    expect(j?.lastStatus).toBe('成功');
    expect(j?.lastRunStatus).toBe('done'); // 即时完成语义（无 started 回报）
    expect(sched.toggle(job.id, false)).toBe(true);
    expect(sched.get(job.id)?.nextRunAt).toBeNull();
    expect(sched.delete(job.id)).toBe(true);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('nextRunAt 对齐分钟边界且不早于 from 的下一分钟', () => {
    const from = new Date();
    from.setSeconds(30, 0);
    const n = nextRunAt('* * * * *', from)!;
    expect(n).toBe(from.getMinutes() === 59
      ? new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours() + 1).getTime()
      : new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1).getTime());
  });
});

describe('B-M3 编辑 cron / 立即跑一次 / 轮次历史（FR-011）', () => {
  it('updateCron：合法表达式重算 nextRunAt；非法抛错、不存在返回 false；停用 job 保持 null', () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true, status: 'started' }), file);
    const job = sched.create({ name: '改期', goal: 'g', cron: '0 9 * * *' });
    expect(sched.updateCron(job.id, '30 18 * * 1-5')).toBe(true);
    const j = sched.get(job.id);
    expect(j?.cron).toBe('30 18 * * 1-5');
    expect(j!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(() => sched.updateCron(job.id, 'not a cron')).toThrow(/无效的 cron/);
    expect(sched.updateCron('nope', '0 9 * * *')).toBe(false);
    sched.toggle(job.id, false);
    expect(sched.updateCron(job.id, '0 8 * * *')).toBe(true);
    expect(sched.get(job.id)?.nextRunAt).toBeNull();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('runNow：走触发链记 running 且不清排期；不存在返回错误；抛错转 failed', async () => {
    const file = tempFile();
    let calls = 0;
    const sched = makeScheduler(async () => { calls++; return { ok: true, status: 'started' }; }, file);
    const job = sched.create({ name: '手跑', goal: 'g', cron: '0 9 * * *' });
    const before = sched.get(job.id)!.nextRunAt!;
    const res = await sched.runNow(job.id);
    expect(res).toEqual({ ok: true, status: 'started' });
    expect(calls).toBe(1);
    const j = sched.get(job.id);
    expect(j?.lastRunStatus).toBe('running');
    expect(j?.lastStatus).toBe('运行中');
    expect(j?.nextRunAt).toBe(before); // 立即跑一次不打乱既有排期
    expect((await sched.runNow('ghost')).ok).toBe(false);
    const boom = makeScheduler(async () => { throw new Error('派发炸了'); }, file);
    const r2 = await boom.runNow(job.id);
    expect(r2.ok).toBe(false);
    expect(boom.get(job.id)?.lastRunStatus).toBe('failed');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('runHistory：起跑记 started 开放行 → 收敛补丁定格终态 + endedAt；skipped 记一次性行；封顶 5', async () => {
    const file = tempFile();
    const sched = makeScheduler(async () => ({ ok: true, status: 'started' }), file);
    const job = sched.create({ name: '轮次', goal: 'g', cron: '*/30 * * * *' });
    // 第一轮起跑（模拟 startRound 已写 lastTaskId + running）
    sched.patch(job.id, { lastTaskId: 'r1', lastRunStatus: 'running', lastStatus: '运行中' });
    sched.patch(job.id, { nextRunAt: Date.now() });
    await sched.tick();
    let h = sched.get(job.id)!.runHistory!;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ taskId: 'r1', status: 'started' });
    expect(h[0]!.endedAt).toBeUndefined();
    // 收敛写回终态 → 开放行定格
    sched.patch(job.id, { lastRunStatus: 'done', lastStatus: '成功' });
    h = sched.get(job.id)!.runHistory!;
    expect(h[0]!.status).toBe('done');
    expect(h[0]!.endedAt).toBeTypeOf('number');
    // 上轮未终态时再触发 → 另起 r2 + 一条 skipped-busy 一次性行
    const busy = makeScheduler(async () => ({ ok: true, status: 'skipped-busy' }), file);
    busy.patch(job.id, { lastTaskId: 'r2', lastRunStatus: 'running' });
    busy.patch(job.id, { nextRunAt: Date.now() });
    await busy.tick();
    h = busy.get(job.id)!.runHistory!;
    expect(h[h.length - 1]!.status).toBe('skipped-busy');
    expect(h[h.length - 1]!.endedAt).toBeTypeOf('number');
    // 连续补 6 轮：封顶 5 条，旧行滚出
    for (let i = 3; i <= 8; i++) {
      busy.patch(job.id, { lastTaskId: `r${i}`, lastRunStatus: 'running' });
      await busy.runNow(job.id);
    }
    h = busy.get(job.id)!.runHistory!;
    expect(h).toHaveLength(5);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
