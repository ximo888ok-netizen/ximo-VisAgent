/**
 * seed-capabilities.ts — 种子能力卡导入
 *
 * 首次启动或用户手动「重置能力库」时调用。
 * 使用 INSERT OR IGNORE 保证幂等（同 id 不重复插入）。
 * 同时维护 FTS5 索引行。卡内容见 seed-capabilities-cards.ts（高频办公场景种子）。
 */
import type Database from 'better-sqlite3';
import { SEED_CAPABILITIES } from './seed-capabilities-cards';
import { selectRow } from './query';

/** 将种子能力卡导入数据库（幂等：同 id 不覆盖） */
export function seedCapabilities(db: Database.Database): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  const now = Date.now();

  const insertSql = db.prepare(
    `INSERT OR IGNORE INTO capabilities
      (id, title, description, toolsJson, precondition, acceptance, visualAnchorsJson, status, source, usageCount, failCount, createdAt, updatedAt)
     VALUES (@id, @title, @description, @toolsJson, @precondition, @acceptance, @visualAnchorsJson, @status, @source, 0, 0, @createdAt, @updatedAt)`,
  );

  const ftsInsertSql = db.prepare(
    `INSERT OR IGNORE INTO capability_fts (capabilityId, title, description, precondition, acceptance)
     VALUES (@capabilityId, @title, @description, @precondition, @acceptance)`,
  );

  for (const cap of SEED_CAPABILITIES) {
    // 检查是否已存在
    const existing = selectRow<{ id: string }>(db, 'SELECT id FROM capabilities WHERE id = ?', [cap.id]);
    if (existing) {
      skipped++;
      continue;
    }

    insertSql.run({
      id: cap.id,
      title: cap.title,
      description: cap.description,
      toolsJson: JSON.stringify(cap.tools),
      precondition: cap.precondition,
      acceptance: cap.acceptance,
      visualAnchorsJson: JSON.stringify(cap.visualAnchors),
      status: 'active',
      source: 'seed',
      createdAt: now,
      updatedAt: now,
    });

    ftsInsertSql.run({
      capabilityId: cap.id,
      title: cap.title,
      description: cap.description,
      precondition: cap.precondition,
      acceptance: cap.acceptance,
    });

    imported++;
  }

  return { imported, skipped };
}
