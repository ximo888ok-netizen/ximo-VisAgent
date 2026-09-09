/**
 * migrations.ts — Mission 知识库建表与幂等补列
 *
 * 5 张表 + 1 个 FTS5 虚拟表：
 *   capabilities        能力卡（技能表示）
 *   missions            任务（用户目标）
 *   subtasks            子任务（任务分解）
 *   mission_artifacts   子任务产物
 *   capability_fts      能力卡全文索引（FTS5）
 *
 * 所有 DDL 幂等：CREATE TABLE IF NOT EXISTS、ALTER TABLE ADD COLUMN 前先检查。
 * 历史列只 ADD 不改不删——与 audit-db/migrations.ts 同一纪律。
 */
import type Database from 'better-sqlite3';

const SCHEMA = `
  -- 能力卡
  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    toolsJson TEXT NOT NULL DEFAULT '[]',
    precondition TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    visualAnchorsJson TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'seed',
    usageCount INTEGER NOT NULL DEFAULT 0,
    failCount INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cap_status ON capabilities(status);
  CREATE INDEX IF NOT EXISTS idx_cap_source ON capabilities(source);

  -- 任务
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'draft',
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    finishedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mission_status ON missions(status);
  CREATE INDEX IF NOT EXISTS idx_mission_created ON missions(createdAt);

  -- 子任务
  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    missionId TEXT NOT NULL,
    capabilityId TEXT,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    "order" INTEGER NOT NULL DEFAULT 0,
    startedAt INTEGER,
    finishedAt INTEGER,
    reviewNote TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subtask_mission ON subtasks(missionId);
  CREATE INDEX IF NOT EXISTS idx_subtask_status ON subtasks(status);

  -- 子任务产物
  CREATE TABLE IF NOT EXISTS mission_artifacts (
    id TEXT PRIMARY KEY,
    subtaskId TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'file',
    path TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (subtaskId) REFERENCES subtasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_subtask ON mission_artifacts(subtaskId);

  -- 能力卡全文索引（FTS5）
  CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(
    capabilityId UNINDEXED,
    title,
    description,
    precondition,
    acceptance
  );
`;

/** 旧库迁移：补列（幂等） */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  // 未来版本如果有加列，在这里追加
];

export function applyMissionSchema(db: Database.Database): void {
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) migrateColumn(db, table, column, type);
  // 确保外键级联生效
  db.exec('PRAGMA foreign_keys = ON');
}

function migrateColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = selectColumnNames(db, table);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function selectColumnNames(db: Database.Database, table: string): string[] {
  return db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
