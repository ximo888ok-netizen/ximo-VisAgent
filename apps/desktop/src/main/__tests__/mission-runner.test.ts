/**
 * mission-runner.test.ts — Mission 编排状态机（拓扑序 / 确认闸 / 失败停等人工 / 终态回写）
 *
 * 用内存版 MissionRunRepo 替身 + 同步 fake 派发/终态，钉住计划 §8 不变量 2
 * （确认闸前绝不执行）与 §4.4 串行语义；真实 SQLite/派发链由 selftest/e2e 覆盖。
 */
import { describe, it, expect, vi } from 'vitest';
import { createMissionRunner } from '../mission-runner';
import { nextReadySubtask, settleMission, type DagNode } from '../mission-dag';
import type { MissionRunRepo, SubtaskTerminal } from '../mission-db/run-repo';
import type { MissionRowPayload, SubtaskRowPayload } from '../../shared/island-contracts';
import type { MissionStatus, SubtaskStatus } from '@ximo-visagent/shared-types';

// ---- 内存仓储替身（转移守卫与 run-repo 的 SQL WHERE 语义一致） ----

interface FakeMission {
  id: string;
  status: MissionStatus;
  goal: string;
  planJson: string | null;
}
interface FakeSub {
  id: string;
  missionId: string;
  status: SubtaskStatus;
  order: number;
  dependsOn: string[];
  attempts: number;
  taskId: string | null;
  capabilityId: string | null;
  title: string;
  reviewNote: string;
}

class FakeRunRepo implements MissionRunRepo {
  missions = new Map<string, FakeMission>();
  subs = new Map<string, FakeSub>();

  addMission(id: string, status: MissionStatus): void {
    this.missions.set(id, { id, status, goal: `目标-${id}`, planJson: null });
  }
  addSub(id: string, missionId: string, order: number, dependsOn: string[] = []): void {
    this.subs.set(id, {
      id, missionId, status: 'pending', order, dependsOn, attempts: 0, taskId: null,
      capabilityId: `cap.${id}`, title: `子任务-${id}`, reviewNote: '',
    });
  }

  private missionPayload(m: FakeMission): MissionRowPayload {
    return {
      id: m.id, goal: m.goal, origin: 'manual', priority: 'normal', status: m.status,
      planJson: m.planJson, createdAt: 0, startedAt: null, finishedAt: null,
    };
  }
  private subPayload(s: FakeSub): SubtaskRowPayload {
    return {
      id: s.id, missionId: s.missionId, capabilityId: s.capabilityId, title: s.title,
      instruction: `指令-${s.id}`, status: s.status, order: s.order, dependsOn: s.dependsOn,
      risk: null, attempts: s.attempts, taskId: s.taskId,
      startedAt: null, finishedAt: null, reviewNote: s.reviewNote,
    };
  }

  getMission(id: string): MissionRowPayload | null {
    const m = this.missions.get(id);
    return m ? this.missionPayload(m) : null;
  }
  listMissionsByStatus(statuses: MissionStatus[]): MissionRowPayload[] {
    return [...this.missions.values()]
      .filter((m) => statuses.includes(m.status))
      .map((m) => this.missionPayload(m));
  }
  listSubtasks(missionId: string): SubtaskRowPayload[] {
    return [...this.subs.values()]
      .filter((s) => s.missionId === missionId)
      .sort((a, b) => a.order - b.order)
      .map((s) => this.subPayload(s));
  }
  savePlanAwaitConfirm(missionId: string, planJson: string): boolean {
    const m = this.missions.get(missionId);
    if (!m || !['draft', 'planning', 'queued'].includes(m.status)) return false;
    m.status = 'awaiting_confirm';
    m.planJson = planJson;
    return true;
  }
  confirmMission(missionId: string): boolean {
    const m = this.missions.get(missionId);
    if (!m || m.status !== 'awaiting_confirm') return false;
    m.status = 'running';
    return true;
  }
  resumeMission(missionId: string): boolean {
    const m = this.missions.get(missionId);
    if (!m || m.status !== 'paused') return false;
    m.status = 'running';
    return true;
  }
  setMissionStatus(missionId: string, status: MissionStatus): void {
    const m = this.missions.get(missionId);
    if (m) m.status = status;
  }
  attachTask(subtaskId: string, taskId: string): void {
    const s = this.subs.get(subtaskId);
    if (!s) return;
    s.status = 'running';
    s.taskId = taskId;
    s.attempts += 1;
  }
  finishSubtask(subtaskId: string, status: SubtaskTerminal, reviewNote?: string): void {
    const s = this.subs.get(subtaskId);
    if (!s) return;
    s.status = status;
    s.reviewNote = reviewNote ?? '';
  }
  reopenSubtask(subtaskId: string): boolean {
    const s = this.subs.get(subtaskId);
    if (!s || s.status !== 'failed') return false;
    s.status = 'pending';
    s.taskId = null;
    return true;
  }
  bumpCapabilityUsage(): void {
    // 统计列写入与调度决策无关，替身不追踪
  }
}

/**
 * fake 派发器：每次派发分配 task-N；第 N 次派发的结局查 byDispatch（缺省 COMPLETED）。
 * 返回已派发子任务 id 序列，供拓扑序断言。
 */
function makeRunner(repo: FakeRunRepo, opts?: {
  byDispatch?: Record<number, string>;
  notify?: (event: { mission: MissionRowPayload; status: string; text: string }) => void;
}) {
  const dispatched: string[] = [];
  let seq = 0;
  const outcomes = new Map<string, string>();
  const runner = createMissionRunner({
    repo,
    dispatchSubtask: async (subtask) => {
      const taskId = `task-${++seq}`;
      outcomes.set(taskId, opts?.byDispatch?.[seq] ?? 'COMPLETED');
      dispatched.push(subtask.id);
      return { taskId };
    },
    getTaskOutcome: (taskId) => outcomes.get(taskId) ?? 'RUNNING',
    sleep: () => Promise.resolve(),
    notify: opts?.notify,
  });
  return { runner, dispatched };
}

describe('mission-dag 拓扑决策', () => {
  const node = (id: string, status: SubtaskStatus, order: number, dependsOn: string[] = []): DagNode =>
    ({ id, status, order, dependsOn });

  it('依赖未满足不就绪；完成后放行下游', () => {
    const nodes = [node('s2', 'pending', 1, ['s1']), node('s1', 'pending', 0), node('s3', 'pending', 2, ['s1', 's2'])];
    expect(nextReadySubtask(nodes)?.id).toBe('s1');
    const after1 = [node('s2', 'pending', 1, ['s1']), node('s1', 'done', 0), node('s3', 'pending', 2, ['s1', 's2'])];
    expect(nextReadySubtask(after1)?.id).toBe('s2');
  });

  it('skipped 依赖同样放行；幽灵依赖永不就绪；order 定序优先于 id', () => {
    expect(nextReadySubtask([node('b', 'pending', 0, ['a']), node('a', 'skipped', 1)])?.id).toBe('b');
    expect(nextReadySubtask([node('b', 'pending', 0, ['ghost'])])).toBeNull();
    expect(nextReadySubtask([node('z', 'pending', 0), node('a', 'pending', 1)])?.id).toBe('z');
  });

  it('settle：全 done/skipped → completed；failed → failed；被卡 pending → blocked；running → in-flight', () => {
    expect(settleMission([node('a', 'done', 0), node('b', 'skipped', 1)]).kind).toBe('completed');
    expect(settleMission([node('a', 'failed', 0)]).kind).toBe('failed');
    expect(settleMission([node('a', 'failed', 0), node('b', 'pending', 1, ['a'])]).kind).toBe('blocked');
    expect(settleMission([node('a', 'running', 0)]).kind).toBe('in-flight');
  });
});

describe('计划确认闸（§8 不变量 2）', () => {
  it('queued/planning 状态下确认一律失败，绝不开跑', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'queued');
    repo.addSub('s1', 'm1', 0);
    const { runner, dispatched } = makeRunner(repo);

    expect(runner.confirmAndStart('m1')).toBe(false);
    await runner.idle();
    expect(dispatched).toHaveLength(0);
    expect(repo.getMission('m1')?.status).toBe('queued');
  });

  it('plan 入库进入 awaiting_confirm 后，人工确认才派发', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'queued');
    repo.addSub('s1', 'm1', 0);
    const { runner, dispatched } = makeRunner(repo);

    expect(repo.savePlanAwaitConfirm('m1', '{"subtasks":[{"id":"s1","goal":"g"}]}')).toBe(true);
    // 确认闸前：即便手动 pump 入口也不执行（没有别的入口能把 queued 变 running）
    expect(dispatched).toHaveLength(0);
    expect(runner.confirmAndStart('m1')).toBe(true);
    await runner.idle();
    expect(dispatched).toEqual(['s1']);
    expect(repo.getMission('m1')?.status).toBe('completed');
  });
});

describe('依赖驱动串行调度与终态回写', () => {
  it('链式依赖按拓扑序执行；done/taskId/attempts 回写；全完成后 completed + notify', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'awaiting_confirm');
    repo.addSub('s3', 'm1', 2, ['s2']);
    repo.addSub('s1', 'm1', 0);
    repo.addSub('s2', 'm1', 1, ['s1']);
    const notify = vi.fn();
    const { runner, dispatched } = makeRunner(repo, { notify });

    expect(runner.confirmAndStart('m1')).toBe(true);
    await runner.idle();

    expect(dispatched).toEqual(['s1', 's2', 's3']);
    const s1 = repo.subs.get('s1');
    expect(s1?.status).toBe('done');
    expect(s1?.taskId).toBe('task-1');
    expect(s1?.attempts).toBe(1);
    expect(repo.getMission('m1')?.status).toBe('completed');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0]?.text)).toContain('全部子任务完成');
  });

  it('任务未终态时按轮询等待，不重复派发', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'awaiting_confirm');
    repo.addSub('s1', 'm1', 0);
    let polls = 0;
    const runner = createMissionRunner({
      repo,
      dispatchSubtask: async () => ({ taskId: 'task-x' }),
      getTaskOutcome: () => {
        polls += 1;
        return polls >= 3 ? 'COMPLETED' : 'RUNNING';
      },
      sleep: () => Promise.resolve(),
    });
    expect(runner.confirmAndStart('m1')).toBe(true);
    await runner.idle();
    expect(polls).toBe(3);
    expect(repo.subs.get('s1')?.status).toBe('done');
  });
});

describe('失败停等人工（从简策略，不自动重试）', () => {
  it('子任务失败 → paused + notify，不再派发下游', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'awaiting_confirm');
    repo.addSub('s1', 'm1', 0);
    repo.addSub('s2', 'm1', 1, ['s1']);
    const notify = vi.fn();
    const { runner, dispatched } = makeRunner(repo, { byDispatch: { 1: 'FAILED' }, notify });

    expect(runner.confirmAndStart('m1')).toBe(true);
    await runner.idle();
    expect(dispatched).toEqual(['s1']);
    expect(repo.subs.get('s1')?.status).toBe('failed');
    expect(repo.subs.get('s2')?.status).toBe('pending');
    expect(repo.getMission('m1')?.status).toBe('paused');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retry：重开失败子任务再派发（attempts 累计）；skip：放行下游；abort：cancelled 后不可再处置', async () => {
    // retry
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'awaiting_confirm');
    repo.addSub('s1', 'm1', 0);
    const t1 = makeRunner(repo, { byDispatch: { 1: 'FAILED' } });
    expect(t1.runner.confirmAndStart('m1')).toBe(true);
    await t1.runner.idle();
    expect(t1.runner.resolveMission('m1', 'retry')).toBe(true);
    await t1.runner.idle();
    expect(repo.subs.get('s1')?.attempts).toBe(2);
    expect(repo.subs.get('s1')?.status).toBe('done');
    expect(repo.getMission('m1')?.status).toBe('completed');

    // skip 放行下游
    const repo2 = new FakeRunRepo();
    repo2.addMission('m1', 'awaiting_confirm');
    repo2.addSub('s1', 'm1', 0);
    repo2.addSub('s2', 'm1', 1, ['s1']);
    const t2 = makeRunner(repo2, { byDispatch: { 1: 'CANCELLED' } });
    expect(t2.runner.confirmAndStart('m1')).toBe(true);
    await t2.runner.idle();
    expect(t2.runner.resolveMission('m1', 'skip')).toBe(true);
    await t2.runner.idle();
    expect(repo2.subs.get('s1')?.status).toBe('skipped');
    expect(repo2.subs.get('s2')?.status).toBe('done');
    expect(repo2.getMission('m1')?.status).toBe('completed');

    // abort
    const repo3 = new FakeRunRepo();
    repo3.addMission('m1', 'awaiting_confirm');
    repo3.addSub('s1', 'm1', 0);
    const t3 = makeRunner(repo3, { byDispatch: { 1: 'FAILED' } });
    expect(t3.runner.confirmAndStart('m1')).toBe(true);
    await t3.runner.idle();
    expect(t3.runner.resolveMission('m1', 'abort')).toBe(true);
    expect(repo3.getMission('m1')?.status).toBe('cancelled');
    expect(t3.runner.resolveMission('m1', 'retry')).toBe(false);
  });

  it('派发异常也按失败停等人工', async () => {
    const repo = new FakeRunRepo();
    repo.addMission('m1', 'awaiting_confirm');
    repo.addSub('s1', 'm1', 0);
    const runner = createMissionRunner({
      repo,
      dispatchSubtask: async () => {
        throw new Error('未配置模型 API Key');
      },
      getTaskOutcome: () => 'RUNNING',
      sleep: () => Promise.resolve(),
    });
    expect(runner.confirmAndStart('m1')).toBe(true);
    await runner.idle();
    expect(repo.subs.get('s1')?.status).toBe('failed');
    expect(repo.subs.get('s1')?.reviewNote).toContain('未配置模型 API Key');
    expect(repo.getMission('m1')?.status).toBe('paused');
  });
});
