/**
 * preauth-migrations.ts — longtask 域 preauth_grants 表（A-M6，规划 §2.2）
 *
 * DDL 逐字采用规划 §2.2。独立版本戳域 'longtask-preauth'：与
 * longtask-db/migrations.ts（v1=app_recent）、checkpoint-migrations.ts 并行开发
 * 共写同一文件必然冲突，照 checkpoint 域先例开独立域互不踩踏；
 * CREATE TABLE IF NOT EXISTS 幂等，后续团队同意可折叠为 longtask 域 vN。
 */
import type { MigrationDb } from '../db-migrations';
import { migrateSchema } from '../db-migrations';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS preauth_grants (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    job_id TEXT,
    scope_json TEXT NOT NULL,
    status TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    acked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_grant_task ON preauth_grants(task_id, status);
`;

/** preauth 域当前期望版本：v1 = preauth_grants */
export const PREAUTH_SCHEMA_VERSION = 1;

export function applyLongtaskPreauthSchema(db: MigrationDb): void {
  migrateSchema(db, 'longtask-preauth', [
    {
      version: PREAUTH_SCHEMA_VERSION,
      apply: (d) => {
        d.exec(SCHEMA);
      },
    },
  ]);
}
