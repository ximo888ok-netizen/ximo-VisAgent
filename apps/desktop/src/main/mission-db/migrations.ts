/**
 * migrations.ts — Mission 知识库建表与幂等补列
 *
 * 5 张表 + 1 个 FTS5 虚拟表：
 *   capabilities        能力卡（技能表示）
 *   missions            任务（用户目标，planJson 存规划产物）
 *   subtasks            子任务（任务分解，dependsOn 为 DAG 边）
 *   mission_artifacts   子任务产物（contentHash 供下游消费前复核）
 *   capability_fts      能力卡全文索引（FTS5，trigram tokenizer 保中文召回）
 *
 * 所有 DDL 幂等：CREATE TABLE IF NOT EXISTS、ALTER TABLE ADD COLUMN 前先检查。
 * 历史列只 ADD 不改不删——与 audit-db/migrations.ts 同一纪律；
 * 版本戳与补列机制统一在 ../db-migrations.ts（共库、可探测漂移）。
 * 版本线：v1 基础五表；v2 编排列（dependsOn/risk/attempts/taskId/planJson/
 * contentHash/stale）+ capability_fts 重建为 trigram（保留既有数据回填）。
 */
import type { AddedColumn, MigrationDb } from '../db-migrations';
import { applyAddedColumns, migrateSchema } from '../db-migrations';

/** trigram 全文索引 DDL（建表与旧库重建共用同一字符串源） */
const FTS_TRIGRAM_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(
    capabilityId UNINDEXED,
    title,
    description,
    precondition,
    acceptance,
    tokenize='trigram'
  )`;

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
    planJson TEXT,
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
    dependsOn TEXT NOT NULL DEFAULT '[]',
    risk TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    taskId TEXT,
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
    contentHash TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (subtaskId) REFERENCES subtasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_subtask ON mission_artifacts(subtaskId);

  -- 能力卡全文索引（FTS5，trigram：中文子串可召回，见 mission 计划 §3.3）
  ${FTS_TRIGRAM_DDL}
`;

/** 旧库迁移：补列（幂等） */
const ADDED_COLUMNS: AddedColumn[] = [
  ['missions', 'planJson', 'TEXT'],
  ['subtasks', 'dependsOn', "TEXT NOT NULL DEFAULT '[]'"],
  ['subtasks', 'risk', 'TEXT'],
  ['subtasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['subtasks', 'taskId', 'TEXT'],
  ['mission_artifacts', 'contentHash', 'TEXT'],
  ['mission_artifacts', 'stale', 'INTEGER NOT NULL DEFAULT 0'],
];

export function applyMissionSchema(db: MigrationDb): void {
  migrateSchema(db, 'mission', [
    { version: 1, apply: (d) => d.exec(SCHEMA) },
    {
      version: 2,
      apply: (d) => {
        applyAddedColumns(d, ADDED_COLUMNS);
        ensureTrigramFts(d);
      },
    },
  ]);
  // 连接级 PRAGMA，与版本戳无关，每次启动都设
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * capability_fts 收敛为 trigram tokenizer：
 * 旧库以默认 tokenizer 建过表的，DROP → 按新 DDL 重建 → 从 capabilities 回填。
 * 新库 SCHEMA 已直接建 trigram 表，这里探测后不动（幂等）。
 */
function ensureTrigramFts(db: MigrationDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capability_fts'")
    .get() as { sql: string | null } | undefined;
  if (!row || /trigram/i.test(row.sql ?? '')) return;
  db.exec('DROP TABLE capability_fts');
  db.exec(FTS_TRIGRAM_DDL);
  db.exec(`INSERT INTO capability_fts (capabilityId, title, description, precondition, acceptance)
            SELECT id, title, description, precondition, acceptance FROM capabilities`);
}
