/**
 * checkpoint-migrations.ts — longtask 域 task_checkpoints 表（A-M4，规划 §2.3）
 *
 * DDL 逐字采用规划 §2.3（与 mission_artifacts 分域各表，(task_id,seq) 唯一）。
 * 独立版本戳域 'longtask-checkpoint'：与同事的 longtask-db/migrations.ts
 * （v1=app_recent，A-M4 原计划以 v2 追加于此）并行开发时共写同一文件必然冲突，
 * 故开独立域互不踩踏；CREATE TABLE IF NOT EXISTS + UNIQUE(task_id,seq) 幂等，
 * 后续如团队同意可把本步折叠为 longtask 域 v2（删本文件调用点即可，表不受影响）。
 */
import type { MigrationDb } from '../db-migrations';
import { migrateSchema } from '../db-migrations';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    cursor_json TEXT NOT NULL,
    artifacts_json TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(task_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_cp_task ON task_checkpoints(task_id, seq);
`;

/** checkpoint 域当前期望版本：v1 = task_checkpoints */
export const CHECKPOINT_SCHEMA_VERSION = 1;

export function applyLongtaskCheckpointSchema(db: MigrationDb): void {
  migrateSchema(db, 'longtask-checkpoint', [
    {
      version: CHECKPOINT_SCHEMA_VERSION,
      apply: (d) => {
        d.exec(SCHEMA);
      },
    },
  ]);
}
