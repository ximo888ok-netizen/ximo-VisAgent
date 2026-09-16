/**
 * recovery-migrations.ts — 恢复规则表（recovery_rules）的列演进
 *
 * 走 db-migrations 的版本戳域机制（domain = 'recovery_rules'），不复用 audit / mission 域，
 * 避免多域共库时整数版本互相覆盖（见 db-migrations.ts 头注释）。
 *
 * 列的所有者是 stores/evolution-store.ts（CREATE TABLE 仍在那里）；本文件只做「补列 + 建索引」，
 * 每张表的历史列只 ADD、不改不删。
 */
import { migrateSchema, applyAddedColumns, columnNames, type MigrationDb } from '../db-migrations';

/** 提炼出的规则需要的账本列（治理计数 + 去重指纹 + 证据） */
const RECOVERY_COLUMNS = [
  ['recovery_rules', 'signature', 'TEXT'],
  ['recovery_rules', 'origin', "TEXT NOT NULL DEFAULT 'mined'"],
  ['recovery_rules', 'sourceTaskId', 'TEXT'],
  ['recovery_rules', 'evidenceJson', "TEXT NOT NULL DEFAULT '[]'"],
  ['recovery_rules', 'hitCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['recovery_rules', 'timesObserved', 'INTEGER NOT NULL DEFAULT 1'],
  ['recovery_rules', 'lastSeenAt', 'INTEGER'],
] as const;

function applyV1(db: MigrationDb): void {
  applyAddedColumns(db, RECOVERY_COLUMNS.map(([t, c, ty]) => [t, c, ty] as [string, string, string]));
  // 去重合并的正查路径：signature 命中即 bump 观测，不再新建规则
  if (columnNames(db, 'recovery_rules').includes('signature')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_sig ON recovery_rules(signature)');
  }
}

/** 幂等应用恢复规则表迁移（重复调用只跑一次，版本戳落在 schema_migrations） */
export function applyRecoveryMigrations(db: MigrationDb): void {
  migrateSchema(db, 'recovery_rules', [{ version: 1, apply: applyV1 }]);
}
