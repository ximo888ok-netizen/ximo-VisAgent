/**
 * db-migrations.test.ts — 迁移版本戳 + mission 契约迁移的幂等/漂移探测
 *
 * 用 node:sqlite（纯 node 可加载，不碰 better-sqlite3 的 Electron ABI）经最小
 * 适配器驱动同一套 MigrationDb 接口：验证「任何 SQLite 同步驱动都能跑迁移」，
 * 顺带钉住 better-sqlite3 结构兼容（typecheck 里由 index.ts 调用点保证）。
 */
import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { migrateSchema, schemaVersion, applyAddedColumns, columnNames } from '../db-migrations';
import { applyMissionSchema } from '../mission-db/migrations';
import { applyAuditSchema } from '../audit-db/migrations';

/** node:sqlite 的 StatementSync 参数面比 MigrationDb 窄，测试内做无断言适配 */
function toMigrationDb(sync: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => sync.exec(sql),
    prepare: (sql) => {
      // eslint 测试目录放宽 any；这里不用断言也能通过结构检查
      const st = sync.prepare(sql) as {
        run: (...p: (string | number | bigint | Buffer | null | undefined)[]) => unknown;
        get: (...p: (string | number | bigint | Buffer | null | undefined)[]) => unknown;
        all: (...p: (string | number | bigint | Buffer | null | undefined)[]) => unknown[];
      };
      return {
        run: (...p) => st.run(...p as (string | number | null)[]),
        get: (...p) => st.get(...p as (string | number | null)[]),
        all: (...p) => st.all(...p as (string | number | null)[]),
      };
    },
  };
}

function makeDb(): { sync: DatabaseSync; db: MigrationDb } {
  const sync = new DatabaseSync(':memory:');
  return { sync, db: toMigrationDb(sync) };
}

describe('迁移版本戳（migrateSchema）', () => {
  it('按序应用步骤并落版本戳；重复调用不再执行（幂等）', () => {
    const { db } = makeDb();
    const v1 = vi.fn();
    const v2 = vi.fn();
    const steps = [
      { version: 1, apply: v1 },
      { version: 2, apply: v2 },
    ];
    migrateSchema(db, 'demo', steps);
    expect(v1).toHaveBeenCalledTimes(1);
    expect(v2).toHaveBeenCalledTimes(1);
    expect(schemaVersion(db, 'demo')).toBe(2);

    migrateSchema(db, 'demo', steps);
    migrateSchema(db, 'demo', steps);
    expect(v1).toHaveBeenCalledTimes(1);
    expect(v2).toHaveBeenCalledTimes(1);
  });

  it('增量迁移：v1 库升到 v2 只跑缺的步骤', () => {
    const { db } = makeDb();
    const v1 = vi.fn();
    const v2 = vi.fn();
    migrateSchema(db, 'demo', [{ version: 1, apply: v1 }]);
    migrateSchema(db, 'demo', [
      { version: 1, apply: v1 },
      { version: 2, apply: v2 },
    ]);
    expect(v1).toHaveBeenCalledTimes(1);
    expect(v2).toHaveBeenCalledTimes(1);
    expect(schemaVersion(db, 'demo')).toBe(2);
  });

  it('漂移探测：库版本高于代码期望时告警且不重跑', () => {
    const { db } = makeDb();
    const apply = vi.fn();
    migrateSchema(db, 'demo', [{ version: 5, apply }]);
    expect(apply).toHaveBeenCalledTimes(1);
    apply.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    migrateSchema(db, 'demo', [{ version: 3, apply }]);
    expect(apply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('漂移'));
    warn.mockRestore();
  });

  it('多域共库互不踩踏（audit / mission 各自记版本）', () => {
    const { db } = makeDb();
    applyAuditSchema(db);
    applyMissionSchema(db);
    expect(schemaVersion(db, 'audit')).toBe(1);
    expect(schemaVersion(db, 'mission')).toBe(2);
    // 同库重跑：不抛错、版本不回退
    applyAuditSchema(db);
    applyMissionSchema(db);
    expect(schemaVersion(db, 'mission')).toBe(2);
  });
});

describe('mission 契约迁移（v1 → v2）', () => {
  it('全新库：五表齐 + 编排新列直接存在，capability_fts 为 trigram', () => {
    const { db } = makeDb();
    applyMissionSchema(db);
    for (const col of ['dependsOn', 'risk', 'attempts', 'taskId']) {
      expect(columnNames(db, 'subtasks')).toContain(col);
    }
    expect(columnNames(db, 'missions')).toContain('planJson');
    expect(columnNames(db, 'mission_artifacts')).toEqual(
      expect.arrayContaining(['contentHash', 'stale']),
    );
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='capability_fts'").get() as { sql: string };
    expect(fts.sql).toMatch(/trigram/i);
  });

  it('旧库升级：补列、FTS 重建为 trigram 且既有数据回填可中文召回', () => {
    const { sync, db } = makeDb();
    // 手工复刻旧版 DDL（无新列 + 默认 tokenizer 的 fts），模拟线上历史库
    sync.exec(`
      CREATE TABLE capabilities (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        toolsJson TEXT NOT NULL DEFAULT '[]', precondition TEXT NOT NULL DEFAULT '',
        acceptance TEXT NOT NULL DEFAULT '', visualAnchorsJson TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'seed',
        usageCount INTEGER NOT NULL DEFAULT 0, failCount INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE missions (id TEXT PRIMARY KEY, goal TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'manual', priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'draft', createdAt INTEGER NOT NULL,
        startedAt INTEGER, finishedAt INTEGER);
      CREATE TABLE subtasks (id TEXT PRIMARY KEY, missionId TEXT NOT NULL,
        capabilityId TEXT, title TEXT NOT NULL, instruction TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', "order" INTEGER NOT NULL DEFAULT 0,
        startedAt INTEGER, finishedAt INTEGER, reviewNote TEXT NOT NULL DEFAULT '');
      CREATE TABLE mission_artifacts (id TEXT PRIMARY KEY, subtaskId TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'file', path TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL);
      CREATE VIRTUAL TABLE capability_fts USING fts5(
        capabilityId UNINDEXED, title, description, precondition, acceptance);
      INSERT INTO capabilities (id, title, description, createdAt, updatedAt)
        VALUES ('cap.excel.fill_column', '填充 Excel 列',
                '当用户需要将一列单元格按规则填充（如序号、公式、日期）时使用。', 1, 1);
      INSERT INTO capability_fts (capabilityId, title, description, precondition, acceptance)
        SELECT id, title, description, precondition, acceptance FROM capabilities;
    `);
    applyMissionSchema(db);

    for (const col of ['dependsOn', 'attempts']) {
      expect(columnNames(db, 'subtasks')).toContain(col);
    }
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='capability_fts'").get() as { sql: string };
    expect(fts.sql).toMatch(/trigram/i);
    // 既有索引行被保留（回填）且 trigram 中文子串可命中：3 字滑窗「填充 Ex」→ 取「一列细」式子串
    const hit = db.prepare(
      `SELECT capabilityId FROM capability_fts WHERE capability_fts MATCH '"单元格按"' LIMIT 1`,
    ).all() as Array<{ capabilityId: string }>;
    expect(hit[0]?.capabilityId).toBe('cap.excel.fill_column');
    // 幂等重跑（清掉戳强制全走一遍 DDL 路径）不报错、数据不丢
    sync.exec("DELETE FROM schema_migrations WHERE domain = 'mission'");
    applyMissionSchema(db);
    applyMissionSchema(db);
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM capability_fts').get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  it('补列工具自身幂等：重复应用不抛错', () => {
    const { db } = makeDb();
    db.exec('CREATE TABLE t (a TEXT)');
    applyAddedColumns(db, [['t', 'b', 'INTEGER NOT NULL DEFAULT 0']]);
    applyAddedColumns(db, [['t', 'b', 'INTEGER NOT NULL DEFAULT 0']]);
    expect(columnNames(db, 't')).toEqual(['a', 'b']);
  });
});
