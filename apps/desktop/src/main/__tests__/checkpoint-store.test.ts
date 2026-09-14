/**
 * checkpoint-store.test.ts — task_checkpoints 真库用例（A-M4）
 *
 * 仿 db-migrations.test.ts：node:sqlite 薄适配驱动同一 MigrationDb 接口，
 * 覆盖 checkpoint 域迁移幂等/共库互不踩踏、seq 单调、双写去重合流。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { schemaVersion } from '../db-migrations';
import { applyLongtaskSchema } from '../longtask-db/migrations';
import { applyLongtaskCheckpointSchema, CHECKPOINT_SCHEMA_VERSION } from '../longtask-db/checkpoint-migrations';
import { artifactFingerprint, createCheckpointStore } from '../checkpoint-store';
import type { CheckpointArtifact, CheckpointDraft } from '../../shared/schemas/longtask';

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

function makeDb(): { db: MigrationDb } {
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskCheckpointSchema(db);
  return { db };
}

function draft(over: Partial<CheckpointDraft> & { taskId: string }): CheckpointDraft {
  return {
    kind: 'host',
    cursor: { done: 1, unit: '工件' },
    artifacts: [{ path: 'C:/out/a.xlsx', contentHash: 'h-a', role: 'output' }],
    summary: '宿主：工件落盘 a.xlsx',
    ...over,
  };
}

describe('longtask checkpoint 域迁移（task_checkpoints）', () => {
  it('幂等：重复应用不报错、版本戳正确', () => {
    const { db } = makeDb();
    applyLongtaskCheckpointSchema(db);
    applyLongtaskCheckpointSchema(db);
    expect(schemaVersion(db, 'longtask-checkpoint')).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it('与 app_recent（longtask 域 v1）及 audit/mission 共库互不踩踏', () => {
    const sync = new DatabaseSync(':memory:');
    const db = toMigrationDb(sync);
    applyLongtaskSchema(db);
    applyLongtaskCheckpointSchema(db);
    expect(schemaVersion(db, 'longtask')).toBe(1);
    expect(schemaVersion(db, 'longtask-checkpoint')).toBe(1);
    // (task_id,seq) 唯一约束真实存在
    expect(() => sync.exec("INSERT INTO task_checkpoints (task_id,seq,kind,cursor_json,artifacts_json,summary,created_at) VALUES ('t',1,'host','{}','[]','',1)")).not.toThrow();
    expect(() => sync.exec("INSERT INTO task_checkpoints (task_id,seq,kind,cursor_json,artifacts_json,summary,created_at) VALUES ('t',1,'model','{}','[]','',1)")).toThrow(/UNIQUE/i);
  });
});

describe('task_checkpoints 读写（append/latest/list）', () => {
  it('seq 按任务单调 +1 且跨任务独立；latest 取最大 seq', () => {
    const { db } = makeDb();
    const store = createCheckpointStore(db);
    store.append(draft({ taskId: 't1' }));
    const r2 = store.append(draft({ taskId: 't1', cursor: { done: 2, unit: '工件' }, artifacts: [{ path: 'C:/out/b.xlsx', contentHash: 'h-b', role: 'output' }] }));
    store.append(draft({ taskId: 'other' }));
    expect(r2.checkpoint.seq).toBe(2);
    expect(store.latest('t1')?.seq).toBe(2);
    expect(store.latest('other')?.seq).toBe(1);
    expect(store.list('t1').map((c) => c.seq)).toEqual([2, 1]);
    expect(store.latest('missing')).toBeNull();
  });

  it('双写去重：宿主行 + 模型行同工件指纹 → 不重复成行，cursor/summary 合流', () => {
    const { db } = makeDb();
    const store = createCheckpointStore(db);
    store.append(draft({ taskId: 't1' }));
    const merged = store.append({
      ...draft({ taskId: 't1' }),
      kind: 'model',
      cursor: { done: 1, total: 30, unit: '张发票' },
      summary: '已录入 1/30 张发票',
    });
    expect(merged.deduped).toBe(true);
    expect(merged.checkpoint.summary).toBe('已录入 1/30 张发票');
    expect(merged.checkpoint.cursor).toEqual({ done: 1, total: 30, unit: '张发票' });
    expect(store.list('t1')).toHaveLength(1);
    // 合流保留原行的登记时刻与 seq（B 期 checkpointRef={taskId,seq} 引用稳定）
    expect(store.latest('t1')?.seq).toBe(1);
  });

  it('工件不同（哪怕路径同内容变）→ 新行而非去重', () => {
    const { db } = makeDb();
    const store = createCheckpointStore(db);
    store.append(draft({ taskId: 't1' }));
    const r = store.append(draft({
      taskId: 't1',
      cursor: { done: 2, unit: '工件' },
      artifacts: [{ path: 'C:/out/a.xlsx', contentHash: 'h-a2', role: 'output' }],
    }));
    expect(r.deduped).toBe(false);
    expect(r.checkpoint.seq).toBe(2);
  });

  it('模型只报进度不报工件 → 始终独立成行（无指纹可比）', () => {
    const { db } = makeDb();
    const store = createCheckpointStore(db);
    store.append(draft({ taskId: 't1' }));
    const r = store.append({ ...draft({ taskId: 't1' }), kind: 'model', artifacts: [], summary: '进度语义' });
    expect(r.deduped).toBe(false);
    expect(store.list('t1')).toHaveLength(2);
  });
});

describe('工件指纹', () => {
  it('顺序无关（去重判据是集合而非数组序）', () => {
    const a1: CheckpointArtifact = { path: 'p1', contentHash: 'h1', role: 'output' };
    const a2: CheckpointArtifact = { path: 'p2', contentHash: 'h2', role: 'input-ref' };
    expect(artifactFingerprint([a1, a2])).toBe(artifactFingerprint([a2, a1]));
    expect(artifactFingerprint([a1, a2])).not.toBe(artifactFingerprint([{ ...a1, contentHash: 'x' }, a2]));
  });
});
