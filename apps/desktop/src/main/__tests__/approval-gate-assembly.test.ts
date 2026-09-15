/**
 * approval-gate-assembly.test.ts — A-M7 装配级用例（M6 待装配清单 6）
 *
 * 真实 preauth-store（node:sqlite 同库驱动）× 真实 approval-policy × createApprovalGate，
 * 验证 grantRepo 注入后的两条既有路径在装配形态下成立：
 *   · 未 ack 的 grant → listActiveForTask 空表 → 真值表回落 ask（requestUI 被调用，绝不静默放行）；
 *   · ack + active + 作用域命中的 L2 → auto 放行，留痕 decidedBy:'preauth' 并携带 grantId。
 * （策略真值表本身的红→绿纪律在 approval-policy.test.ts，这里是「装起来还对不对」。）
 */
import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { MigrationDb } from '../db-migrations';
import { applyLongtaskPreauthSchema } from '../longtask-db/preauth-migrations';
import { createPreauthStore } from '../preauth-store';
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

const scope: ScopePackage = {
  appId: 'app-target',
  dirs: ['C:/发票/**'],
  opClasses: ['click', 'type_text'],
  sensitiveExcludes: ['删除'],
  budget: { maxDurationMs: 3_600_000, maxSteps: 600, maxTokens: 8_000_000 },
};

const op: ApprovalGateOp = { tool: 'mouse_click', args: { x: 1, y: 2 }, reason: '点击提交按钮', level: 2, appName: '金蝶KIS' };

describe('审批门装配（grantRepo 真仓储）', () => {
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskPreauthSchema(db);
  const store = createPreauthStore(db);

  function harness() {
    const rows: AuditEvent[] = [];
    const audit = {
      insert: (ev: AuditEvent): void => { rows.push(ev); },
      fromAgentEvent: (taskId: string, event: Record<string, unknown>): AuditEvent => ({
        id: `row-${rows.length}`,
        taskId,
        seq: rows.length,
        kind: String(event.type ?? 'unknown') as AuditEvent['kind'],
        timestamp: Date.now(),
        detail: event,
      }),
    };
    const requestUI = vi.fn(async () => ({ action: 'reject' as const, reason: '测试代答：拒绝' }));
    const gate = createApprovalGate(
      {
        audit,
        getConfigMode: () => 'auto',
        isE2E: false,
        timeoutMs: 1_000,
        escalatedLevel: (o: ApprovalGateOp) => o.level ?? 2,
        announce: vi.fn(),
        auraRequest: vi.fn(),
        requestUI,
        islandVisible: () => false,
        grantRepo: { listActiveForTask: (taskId: string) => store.listActiveForTask(taskId) },
      },
      { taskId: 't-anchor', interactive: false },
    );
    return { gate, rows, requestUI };
  }

  it('未 ack grant：取数口空表 → 真值表回落 ask（requestUI 被调用，人工通道未被绕过）', async () => {
    const grant = store.create({ scope, taskId: 't-anchor' });
    expect(store.listActiveForTask('t-anchor')).toHaveLength(0); // acked=0 永不生效

    const { gate, rows, requestUI } = harness();
    const decision = await gate('ap-1', op);
    expect(requestUI).toHaveBeenCalledTimes(1);
    expect(decision?.action).toBe('reject');
    expect(rows.some((r) => r.kind === 'approval_decided')).toBe(false); // ask 路径不写自动放行留痕
    void grant;
  });

  it('ack 后同参数：preauth 命中 → auto 放行并留痕 decidedBy:preauth + grantId', async () => {
    const grant = store.create({ scope, taskId: 't-anchor' });
    expect(store.ack(grant.id)).toBe(true);
    expect(store.listActiveForTask('t-anchor')).toHaveLength(1);

    const { gate, rows, requestUI } = harness();
    const decision = await gate('ap-2', op);
    expect(requestUI).not.toHaveBeenCalled();
    expect(decision?.action).toBe('approve');
    const trace = rows.find((r) => r.kind === 'approval_decided');
    expect(trace?.detail.decidedBy).toBe('preauth');
    expect(trace?.detail.grantId).toBe(grant.id);
  });

  it('作用域外操作（未映射工具）即使 ack 也回落到 ask（超范围必挂起，永不静默）', async () => {
    const grant = store.create({ scope, taskId: 't-anchor' });
    store.ack(grant.id);
    const { gate, requestUI } = harness();
    const decision = await gate('ap-3', { ...op, tool: 'send_message' });
    expect(requestUI).toHaveBeenCalledTimes(1);
    expect(decision?.action).toBe('reject');
  });
});
