/**
 * migrations.ts — 审计库建表与幂等补列（D1）
 *
 * 三张表都由本模块拥有：应用必须能直接打开上一版本的数据文件，
 * 因此所有 DDL 幂等，历史列只 ADD 不改不删。
 * 版本戳与补列机制统一在 ../db-migrations.ts（audit-db 与 mission-db 共库共用）。
 */
import type { AddedColumn, MigrationDb } from '../db-migrations';
import { applyAddedColumns, migrateSchema } from '../db-migrations';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    kind TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_task ON audit(taskId);
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(timestamp);

  CREATE TABLE IF NOT EXISTS tasks (
    taskId TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    createdAt INTEGER NOT NULL,
    finishedAt INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    steps INTEGER,
    tokens INTEGER,
    failureKind TEXT
  );

  CREATE TABLE IF NOT EXISTS sops (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    goalTemplate TEXT NOT NULL DEFAULT '',
    stepsJson TEXT NOT NULL DEFAULT '[]',
    variablesJson TEXT NOT NULL DEFAULT '[]',
    runCount INTEGER NOT NULL DEFAULT 0,
    lastRunAt INTEGER,
    createdAt INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    applicabilityJson TEXT NOT NULL DEFAULT '{}',
    successCount INTEGER NOT NULL DEFAULT 0,
    failCount INTEGER NOT NULL DEFAULT 0,
    promotedAt INTEGER
  );
`;

/** 旧库迁移：补列（幂等） */
const ADDED_COLUMNS: AddedColumn[] = [
  ['tasks', 'steps', 'INTEGER'],
  ['tasks', 'tokens', 'INTEGER'],
  ['tasks', 'failureKind', 'TEXT'],
  ['sops', 'variablesJson', 'TEXT'],
  ['sops', 'origin', "TEXT NOT NULL DEFAULT 'manual'"],
  ['sops', 'status', "TEXT NOT NULL DEFAULT 'active'"],
  ['sops', 'applicabilityJson', "TEXT NOT NULL DEFAULT '{}'"],
  ['sops', 'successCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['sops', 'failCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['sops', 'promotedAt', 'INTEGER'],
];

/** 审计库当前期望版本：v1 = 三张表 + 全部历史补列 */
export const AUDIT_SCHEMA_VERSION = 1;

export function applyAuditSchema(db: MigrationDb): void {
  migrateSchema(db, 'audit', [
    {
      version: AUDIT_SCHEMA_VERSION,
      apply: (d) => {
        d.exec(SCHEMA);
        applyAddedColumns(d, ADDED_COLUMNS);
      },
    },
  ]);
}
