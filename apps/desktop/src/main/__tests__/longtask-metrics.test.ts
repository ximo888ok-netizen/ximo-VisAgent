/**
 * longtask-metrics.test.ts — FR-012 度量聚合查询真库用例（B-M3）
 *
 * node:sqlite 适配同一 MigrationDb 接口（仿 checkpoint-store.test），建 audit 表灌
 * 埋点事件，钉死四项指标口径：锚定去重 / 暂停任务数 vs 暂停事件数 / preauth 放行率
 * 分子分母 / gate 分布降序，以及空库不炸（全 0 + 空分布）。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { computeLongTaskMetrics } from '../audit-db/longtask-metrics';

const AUDIT_DDL = `
  CREATE TABLE audit (
    id TEXT PRIMARY KEY, taskId TEXT NOT NULL, kind TEXT NOT NULL,
    seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
  );
`;

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

let n = 0;
function ev(db: MigrationDb, taskId: string, kind: string, detail: unknown): void {
  n += 1;
  db.prepare('INSERT INTO audit (id, taskId, kind, seq, timestamp, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`a${n}`, taskId, kind, n, 1000 + n, JSON.stringify(detail ?? {}));
}

function seeded(): MigrationDb {
  const db = toMigrationDb(new DatabaseSync(':memory:'));
  db.exec(AUDIT_DDL);
  // 两个锚定任务；t1 暂停 2 次，t2 暂停 0 次 → 暂停任务数 1 / 锚定 2
  ev(db, 't1', 'anchor_attached', { targetAppId: 'appA' });
  ev(db, 't2', 'anchor_attached', { targetAppId: 'appA' });
  ev(db, 't1', 'anchor_pause', { anchorPausedReason: 'away-timeout' });
  ev(db, 't1', 'anchor_pause', { anchorPausedReason: 'app-exited' });
  // 审批：2 preauth + 1 人工 → 放行率 2/3
  ev(db, 't1', 'approval_decided', { decidedBy: 'preauth' });
  ev(db, 't1', 'approval_decided', { decidedBy: 'preauth' });
  ev(db, 't2', 'approval_decided', { decidedBy: 'policy' });
  // gate 分布：assertion×2，stall×1
  ev(db, 't1', 'task_gate_report', { gate: 'assertion' });
  ev(db, 't2', 'task_gate_report', { gate: 'assertion' });
  ev(db, 't1', 'task_gate_report', { gate: 'stall' });
  return db;
}

describe('FR-012 度量聚合（面板四数卡数据源）', () => {
  it('锚定任务数按去重计，暂停任务数 ≤ 暂停事件数', () => {
    const m = computeLongTaskMetrics(seeded());
    expect(m.anchoredTasks).toBe(2);
    expect(m.pausedTasks).toBe(1);
    expect(m.pauseCount).toBe(2);
  });

  it('preauth 放行率返回分子/分母（2/3）；gate 分布按计数降序', () => {
    const m = computeLongTaskMetrics(seeded());
    expect(m.preauthCount).toBe(2);
    expect(m.approvalTotal).toBe(3);
    expect(m.gates[0]).toEqual({ gate: 'assertion', count: 2 });
    expect(m.gates[1]).toEqual({ gate: 'stall', count: 1 });
  });

  it('空库：全 0 + 空分布，不抛（分母 0 由前端渲染「—」）', () => {
    const db = toMigrationDb(new DatabaseSync(':memory:'));
    db.exec(AUDIT_DDL);
    expect(computeLongTaskMetrics(db)).toEqual({
      anchoredTasks: 0,
      pausedTasks: 0,
      pauseCount: 0,
      preauthCount: 0,
      approvalTotal: 0,
      gates: [],
    });
  });
});
