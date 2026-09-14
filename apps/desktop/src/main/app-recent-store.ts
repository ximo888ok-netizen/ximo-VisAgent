/**
 * app-recent-store.ts — 最近使用应用仓储（app_recent，近 20 条）
 *
 * 仓储层（engineering.md §3）：只做读写与上限裁剪，业务判断（何时记一次“使用”）
 * 在上层——chip 绑定成功与 openAppSafe 启动成功两处写入（规划 §2.5，A-M2 接线）。
 * DDL 归 longtask-db/migrations.ts 拥有，本文件只读写。
 */
import type { MigrationDb } from './db-migrations';
import type { AppEntry } from '../shared/schemas/longtask';

/** 最近使用保留条数（规划 §2.5 / FR-001“近 20 条”口径） */
export const APP_RECENT_LIMIT = 20;

interface AppRecentRow {
  exe_path: string;
  id: string;
  name: string;
  used_at: number;
}

export interface AppRecentStore {
  /** 记录一次使用：按 exe_path 幂等 upsert 并刷新 used_at，超 20 条裁最旧 */
  recordUse(entry: { id: string; name: string; exePath: string }): void;
  /** 近 20 条，最近使用在前 */
  listRecent(): AppEntry[];
}

function toEntry(row: AppRecentRow): AppEntry {
  return { id: row.id, name: row.name, exePath: row.exe_path, iconRef: '', source: 'recent' };
}

export function createAppRecentStore(db: MigrationDb): AppRecentStore {
  const upsert = db.prepare(
    `INSERT INTO app_recent (exe_path, id, name, used_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(exe_path) DO UPDATE SET name = excluded.name, used_at = excluded.used_at`,
  );
  const trim = db.prepare(
    `DELETE FROM app_recent WHERE exe_path NOT IN (
       SELECT exe_path FROM app_recent ORDER BY used_at DESC, exe_path LIMIT ?
     )`,
  );
  const select = db.prepare(
    'SELECT exe_path, id, name, used_at FROM app_recent ORDER BY used_at DESC, exe_path LIMIT ?',
  );
  return {
    recordUse(entry) {
      const now = Date.now();
      upsert.run(entry.exePath, entry.id, entry.name, now);
      trim.run(APP_RECENT_LIMIT);
    },
    listRecent() {
      return (select.all(APP_RECENT_LIMIT) as AppRecentRow[]).map(toEntry);
    },
  };
}
