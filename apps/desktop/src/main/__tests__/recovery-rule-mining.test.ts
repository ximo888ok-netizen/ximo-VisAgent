/**
 * recovery-rule-mining.test.ts — 失败归因 → 恢复规则 → 宪法门 → 命中闭环（真 SQLite）
 *
 * 钉住这次交付的三条铁律：
 * 1. 提炼出的规则必须 enabled=false 起步，未批准前 matcher 读不到（不改变模型行为）；
 * 2. 批准后（metaApprove + 真实执行器）同特征失败必须被命中，且带参数形态判据；
 * 3. 同特征去重合并、连败自动降权、陈旧草稿淘汰都发生在同一个库里。
 *
 * 驱动用 node:sqlite + 结构适配（better-sqlite3 在 node 测试里加载不了 Electron ABI，
 * 与 employee-store/db-migrations 测试同一模式）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import type { AgentRunResult, StepDetail } from '@ximo-visagent/agent-core';
import { ExperienceStore } from '../experience-store';
import { metaApprove, metaReject } from '../meta-gate';
import type { MetaAudit } from '../meta-gate';
import { applyRecoveryRuleEnable } from '../meta-appliers';
import { createRecoveryMatcher } from '../orchestrator-recovery';
import { createRecoveryMiner } from '../experience/recovery-miner';
import { settleAdoptionResult } from '../experience/recovery-rules';
import { mineCandidates, toTraceStep } from '../experience/recovery-signature';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { RecoveryRuleRow } from '../stores/experience-types';

type Params = (string | number | bigint | null | undefined)[];

/** node:sqlite → better-sqlite3 结构子集适配（run().changes 与 transaction() 同形） */
function asSqlite3(sync: DatabaseSync): Database.Database {
  const prepare = (sql: string) => ({
    run: (...p: Params) => {
      const r = sync.prepare(sql).run(...p as (string | number | null)[]) as { changes: number | bigint };
      return { changes: Number(r.changes), lastInsertRowid: 0 };
    },
    get: (...p: Params) => sync.prepare(sql).get(...(p as (string | number | null)[])) ?? null,
    all: (...p: Params) => sync.prepare(sql).all(...(p as (string | number | null)[])),
  });
  return {
    prepare,
    exec: (sql: string) => sync.exec(sql),
    transaction(fn: (...a: Params) => unknown) {
      return (...args: Params) => {
        sync.exec('BEGIN');
        try {
          const out = fn(...args);
          sync.exec('COMMIT');
          return out;
        } catch (e) {
          sync.exec('ROLLBACK');
          throw e;
        }
      };
    },
  } as unknown as Database.Database;
}

/** 审计替身：只关心 kind 与 detail（与门/提炼层的实际用法一致） */
function fakeAudit(): { audit: MetaAudit; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  let seq = 0;
  return {
    events,
    audit: {
      insert: (ev) => { events.push(ev); },
      fromAgentEvent: (taskId, event) => ({
        id: `ev-${seq}`,
        taskId,
        seq: seq++,
        timestamp: Date.now(),
        kind: String(event.type ?? 'unknown'),
        detail: event,
      } as AuditEvent),
    },
  };
}

const kindsOf = (events: AuditEvent[]): string[] => events.map((e) => String(e.kind));

function step(index: number, actionName: string | null, ok: boolean, resultSummary: string, args?: Record<string, unknown>): StepDetail {
  return { index, thought: `t${index}`, actionName, args: args ?? null, ok, resultSummary };
}

function runResult(status: AgentRunResult['status'], stepsDetail: StepDetail[]): AgentRunResult {
  return { status, finalAnswer: '', steps: stepsDetail.length, totalTokens: 0, stepsDetail };
}

/** 反复撞同一面墙、最后换 ui_click 走通的一条轨迹 */
function wallTrace(): StepDetail[] {
  return [
    step(1, 'ui_locate', false, '失败: 未找到匹配控件: 卸载小答AI客服 按钮', { query: '卸载小答AI客服' }),
    step(2, 'ui_locate', false, '失败: 未找到匹配控件: 卸载小答AI客服 按钮', { query: '卸载小答AI客服' }),
    step(3, 'ui_click', true, '已点击 elementId=42', { elementId: 42 }),
  ];
}

/** 与轨迹同特征的失败上下文（matcher 的输入口径：lastResult 不带「失败: 」前缀） */
function sameWall(stepIndex = 9) {
  return {
    stepIndex,
    lastTool: 'ui_locate',
    lastResult: '未找到匹配控件: 卸载小答AI客服 按钮',
    lastOk: false as const,
    windowTitle: '设置',
  };
}

let sync: DatabaseSync;
let store: ExperienceStore;
let audit: MetaAudit;
let events: AuditEvent[];

beforeEach(() => {
  sync = new DatabaseSync(':memory:');
  store = new ExperienceStore(asSqlite3(sync));
  const a = fakeAudit();
  audit = a.audit;
  events = a.events;
});

function minerFor(taskId: string) {
  return createRecoveryMiner({ experience: store, audit, taskId });
}

function ruleRow(id: string): RecoveryRuleRow | undefined {
  return store.listRecoveryRules().find((r) => r.id === id);
}

/** 人工批准（走真实执行器），返回批准后的规则 */
async function approvePending(ruleId: string): Promise<RecoveryRuleRow | undefined> {
  const pending = store.listMetaProposals('pending', 50).find((p) => p.targetId === ruleId);
  if (!pending) throw new Error(`没有待批提案：${ruleId}`);
  const res = await metaApprove(audit, store, pending.id, (proposal, payload) =>
    applyRecoveryRuleEnable({ experience: store }, { ...payload, proposalId: proposal.id, ruleId }));
  expect(res.ok).toBe(true);
  return ruleRow(ruleId);
}

describe('迁移与列演进', () => {
  it('recovery_rules 走版本戳域机制补齐治理列', () => {
    const stamp = sync.prepare("SELECT version FROM schema_migrations WHERE domain = 'recovery_rules'").get() as
      | { version: number }
      | undefined;
    expect(stamp?.version).toBe(1);
    const cols = sync.prepare('PRAGMA table_info(recovery_rules)').all() as Array<{ name: string }>;
    for (const col of ['signature', 'origin', 'sourceTaskId', 'evidenceJson', 'hitCount', 'timesObserved', 'lastSeenAt']) {
      expect(cols.some((c) => c.name === col)).toBe(true);
    }
  });
});

describe('失败归因 → 提案 → 批准 → 命中', () => {
  it('终态失败轨迹产出 enabled=0 草稿 + recovery_rule_enable 待批提案', () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));

    const rules = store.listRecoveryRules();
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.enabled).toBe(false);
    expect(rule.origin).toBe('mined');
    expect(rule.id.startsWith('rec-')).toBe(true);
    expect(rule.name).toContain('ui_locate');
    const detect = JSON.parse(rule.detectJson) as { lastTool?: string; errorPattern?: string; argPattern?: string };
    expect(detect.lastTool).toBe('ui_locate');
    expect(detect.errorPattern).toContain('未找到匹配控件');
    expect(detect.argPattern).toContain('"query"');
    expect(JSON.parse(rule.actionJson)).toEqual({ action: 'ui_click' });
    expect(rule.sourceTaskId).toBe('task-1');

    const pendingRows = store.listMetaProposals('pending', 50);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]!.action).toBe('recovery_rule_enable');
    expect(pendingRows[0]!.targetId).toBe(rule.id);
    expect(kindsOf(events)).toContain('recovery_rule_proposed');
  });

  it('未批准的规则不会被 matcher 读到（不改变模型行为）', () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));
    const matcher = createRecoveryMatcher(store, { argsAt: () => ({ query: '卸载小答AI客服' }) });
    expect(matcher(sameWall())).toBeNull();
  });

  it('批准后同特征失败被命中，命中次数与采纳结果进审计', async () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));
    const ruleId = store.listRecoveryRules()[0]!.id;
    const enabled = await approvePending(ruleId);
    expect(enabled?.enabled).toBe(true);

    const miner = minerFor('task-2');
    const matcher = createRecoveryMatcher(store, {
      argsAt: (i) => (i === 9 ? { query: '卸载小答AI客服' } : undefined),
      onHit: (rule, reason) => miner.onHit(rule, reason),
    });
    const hit = matcher(sameWall());
    expect(hit?.mode).toBe('hint');
    expect(hit?.ruleId).toBe(ruleId);
    expect(hit?.reason).toContain('ui_click');
    expect(kindsOf(events)).toContain('recovery_rule_hit');
    expect(ruleRow(ruleId)?.hitCount).toBe(1);

    miner.onResult(ruleId, true);
    expect(ruleRow(ruleId)?.successCount).toBe(1);
    expect(kindsOf(events)).toContain('recovery_rule_result');
  });

  it('现场取不到参数形态时不命中（宁缺毋滥）', async () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));
    const ruleId = store.listRecoveryRules()[0]!.id;
    await approvePending(ruleId);
    expect(createRecoveryMatcher(store)(sameWall())).toBeNull();
    expect(createRecoveryMatcher(store, { argsAt: () => undefined })(sameWall())).toBeNull();
  });

  it('人工拒绝后该特征不再生效，也不自动重提提案', () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));
    const ruleId = store.listRecoveryRules()[0]!.id;
    const pending = store.listMetaProposals('pending', 50).find((p) => p.targetId === ruleId)!;
    expect(metaReject(audit, store, pending.id, '太宽')).toBe(true);

    minerFor('task-2').finish(runResult('FAILED', wallTrace()));
    expect(store.listMetaProposals('pending', 50)).toHaveLength(0);
    expect(store.listRecoveryRules()).toHaveLength(1);
    expect(store.listRecoveryRules()[0]!.timesObserved).toBe(2);
    expect(createRecoveryMatcher(store, { argsAt: () => ({ query: '卸载' }) })(sameWall())).toBeNull();
  });
});

describe('提炼判据本身（纯函数）', () => {
  it('单次偶发失败不产规则', () => {
    const steps = wallTrace().slice(2).map(toTraceStep);
    expect(mineCandidates(steps)).toHaveLength(0);
  });

  it('撞墙后没有任何换路成功 → 不编造对策', () => {
    const steps = wallTrace().slice(0, 2).map(toTraceStep);
    expect(mineCandidates(steps)).toHaveLength(0);
  });

  it('错误文本里的数字被泛化，换任务也能命中同一特征', () => {
    const noisy = [
      step(1, 'mouse_click', false, '失败: 第 3 次尝试未命中坐标，已点击 120 像素外', { x: 10, y: 20 }),
      step(2, 'mouse_click', false, '失败: 第 7 次尝试未命中坐标，已点击 340 像素外', { x: 11, y: 21 }),
      step(3, 'keyboard_press', true, '已按下 Enter', { combo: 'Enter' }),
    ].map(toTraceStep);
    const [candidate] = mineCandidates(noisy);
    expect(candidate?.detect.errorPattern).toContain('\\d+');
    expect(new RegExp(candidate!.detect.errorPattern!).test('第 99 次尝试未命中坐标，已点击 880 像素外')).toBe(true);
  });

  it('活体路径：对策出现的当下即产候选（不等任务终态）', () => {
    const miner = minerFor('task-live');
    for (const s of wallTrace()) miner.observeEvent({ type: 'step', step: s });
    expect(store.listRecoveryRules()).toHaveLength(1);
    expect(store.listMetaProposals('pending', 50)).toHaveLength(1);
    // 终态补提炼不重复计数（同特征在本任务只产一次）
    miner.finish(runResult('FAILED', wallTrace()));
    expect(store.listRecoveryRules()[0]!.timesObserved).toBe(1);
  });

  it('成功任务不重复补提炼', () => {
    const miner = minerFor('task-ok');
    miner.finish(runResult('COMPLETED', wallTrace()));
    expect(store.listRecoveryRules()).toHaveLength(0);
  });
});

describe('淘汰与治理', () => {
  it('批准后连败 3 次 → 自动降权禁用，matcher 不再读到它', async () => {
    minerFor('task-1').finish(runResult('FAILED', wallTrace()));
    const ruleId = store.listRecoveryRules()[0]!.id;
    await approvePending(ruleId);
    const deps = { experience: store, audit, taskId: 'task-2' };
    settleAdoptionResult(deps, ruleId, false);
    settleAdoptionResult(deps, ruleId, false);
    expect(ruleRow(ruleId)?.enabled).toBe(true);
    settleAdoptionResult(deps, ruleId, false);
    expect(ruleRow(ruleId)?.enabled).toBe(false);
    expect(kindsOf(events)).toContain('recovery_rule_demoted');
    expect(createRecoveryMatcher(store, { argsAt: () => ({ query: '卸载小答AI客服' }) })(sameWall())).toBeNull();
  });

  it('同特征重复合并成一条规则并累计观测', () => {
    minerFor('task-a').finish(runResult('FAILED', wallTrace()));
    minerFor('task-b').finish(runResult('FAILED', wallTrace()));
    minerFor('task-c').finish(runResult('CANCELLED', wallTrace()));
    const rules = store.listRecoveryRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.timesObserved).toBe(3);
    expect(kindsOf(events)).toContain('recovery_rule_merged');
    // 提案也只排队一次
    expect(store.listMetaProposals('pending', 50)).toHaveLength(1);
  });

  it('容量淘汰只清无人采纳的陈旧草稿', () => {
    const now = Date.now();
    store.insertRecoveryRule({
      id: 'rec-old', name: '陈旧草稿', detectJson: '{"lastTool":"wait"}', actionJson: '{"action":"ui_locate"}',
      sourceAttributionId: null, enabled: false, signature: 'sig-old', origin: 'mined', sourceTaskId: 'x',
      evidenceJson: '[]', createdAt: now - 31 * 24 * 60 * 60_000, timesObserved: 1,
    });
    store.insertRecoveryRule({
      id: 'rec-live', name: '新草稿', detectJson: '{"lastTool":"wait"}', actionJson: '{"action":"ui_locate"}',
      sourceAttributionId: null, enabled: false, signature: 'sig-live', origin: 'mined', sourceTaskId: 'x',
      evidenceJson: '[]', createdAt: now, timesObserved: 1,
    });
    store.insertRecoveryRule({
      id: 'rec-on', name: '已生效', detectJson: '{"lastTool":"wait"}', actionJson: '{"action":"ui_locate"}',
      sourceAttributionId: null, enabled: true, signature: 'sig-on', origin: 'mined', sourceTaskId: 'x',
      evidenceJson: '[]', createdAt: now - 40 * 24 * 60 * 60_000, timesObserved: 1,
    });
    expect(store.deleteStaleRecoveryDrafts(now - 30 * 24 * 60 * 60_000)).toBe(1);
    expect(store.listRecoveryRules().map((r) => r.id).sort()).toEqual(['rec-live', 'rec-on']);
  });
});
