/**
 * migrations.ts — longtask 域建表（A-M1：app_recent；A-M4 的 task_checkpoints 届时以 v2 追加）
 *
 * 一库一模块拥有 DDL（engineering.md §10 参考实现 audit-db/mission-db）：本域的表只写在这里，
 * app-recent-store.ts 只读写。版本戳机制复用 ../db-migrations.ts（规划 §2 总则），共库互不踩踏。
 * 应用目录本体（枚举/图标）是易变派生数据，不进 SQLite（规划 §2.5），唯一持久化 = 最近使用表。
 */
import type { MigrationDb } from '../db-migrations';
import { migrateSchema } from '../db-migrations';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_recent (
    exe_path TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    used_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_app_recent_used ON app_recent(used_at);
`;

/** longtask 域当前期望版本：v1 = app_recent */
export const LONGTASK_SCHEMA_VERSION = 1;

export function applyLongtaskSchema(db: MigrationDb): void {
  migrateSchema(db, 'longtask', [
    {
      version: LONGTASK_SCHEMA_VERSION,
      apply: (d) => {
        d.exec(SCHEMA);
      },
    },
  ]);
}
