/**
 * db-migrations.ts — 迁移版本戳 + 幂等补列的统一机制（audit-db 与 mission-db 共用）
 *
 * 背景：audit-db 与 mission-db 共库（同一 SQLite 文件，见 main/index.ts），
 * 各自 DDL 仍由本域 migrations.ts 拥有；本文件只提供两件事：
 * 1. schema_migrations 版本戳表（PRAGMA user_version 的按域等价物，多域共库时
 *    单一整数会互相覆盖，故用表存 (domain → version)）；
 * 2. 幂等补列工具（ADD COLUMN 前查 table_info，历史列只 ADD 不改不删）。
 *
 * 漂移探测：库中版本 > 代码声明版本（例如回滚了代码没回滚库）时告警并跳过
 * 前向迁移，不做任何破坏性操作；任何失败可见（E1 口径）。
 */

/**
 * 迁移所需的最小同步驱动面：better-sqlite3 的 Database 结构上满足本接口
 * （由 index.ts / audit-store.ts 的真实连接调用点在 tsc 下钉住），
 * 单测可用 node:sqlite 的 DatabaseSync 薄适配替换（不依赖 Electron ABI）。
 */
export interface MigrationStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface MigrationDb {
  exec(sql: string): unknown;
  prepare(sql: string): MigrationStatement;
}

/** 旧库补列定义：[表, 列, 列类型] */
export type AddedColumn = [table: string, column: string, type: string];

/** 一个带版本号的迁移步骤（版本必须严格递增，最后一个即当前期望版本） */
export interface MigrationStep {
  version: number;
  apply: (db: MigrationDb) => void;
}

export function applyAddedColumns(db: MigrationDb, defs: AddedColumn[]): void {
  for (const [table, column, type] of defs) {
    if (!columnNames(db, table).includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

export function columnNames(db: MigrationDb, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((c) => c.name);
}

/** 按域应用迁移：只跑 version > 当前库版本 的步骤，逐步落版本戳 */
export function migrateSchema(db: MigrationDb, domain: string, steps: MigrationStep[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    domain TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    appliedAt INTEGER NOT NULL
  )`);
  const row = db.prepare('SELECT version FROM schema_migrations WHERE domain = ?').get(domain) as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  const last = steps[steps.length - 1];
  const expected = last ? last.version : 0;
  if (current > expected) {
    console.warn(`[db-migrations] ${domain} 版本漂移：库中 v${current} > 代码期望 v${expected}，跳过迁移（请升级代码而非降级库）`);
    return;
  }
  for (const step of steps) {
    if (step.version <= current) continue;
    step.apply(db);
    db.prepare(
      `INSERT INTO schema_migrations (domain, version, appliedAt) VALUES (?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET version = excluded.version, appliedAt = excluded.appliedAt`,
    ).run(domain, step.version, Date.now());
  }
}

/** 读取某域当前版本戳（诊断/测试用） */
export function schemaVersion(db: MigrationDb, domain: string): number {
  const row = db.prepare('SELECT version FROM schema_migrations WHERE domain = ?').get(domain) as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}
