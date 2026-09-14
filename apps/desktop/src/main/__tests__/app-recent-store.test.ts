/**
 * app-recent-store.test.ts — 最近使用应用仓储 + longtask 域迁移的纯逻辑单测（A-M1 验收②）
 *
 * 沿用 db-migrations.test.ts 的 node:sqlite 薄适配：不依赖 Electron / better-sqlite3 ABI，
 * 验证迁移幂等、exe_path 幂等 upsert、近 20 条上限裁剪与排序。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { schemaVersion } from '../db-migrations';
import { applyLongtaskSchema } from '../longtask-db/migrations';
import { APP_RECENT_LIMIT, createAppRecentStore } from '../app-recent-store';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toMigrationDb(sync: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => sync.exec(sql),
    prepare: (sql) => {
      const st = sync.prepare(sql) as {
        run: (...p: (string | number | null)[]) => unknown;
        get: (...p: (string | number | null)[]) => unknown;
        all: (...p: (string | number | null)[]) => unknown[];
      };
      return {
        run: (...p) => st.run(...(p as (string | number | null)[])),
        get: (...p) => st.get(...(p as (string | number | null)[])),
        all: (...p) => st.all(...(p as (string | number | null)[])),
      };
    },
  };
}

function makeStore() {
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskSchema(db);
  return { sync, db, store: createAppRecentStore(db) };
}

describe('longtask 域迁移（app_recent）', () => {
  it('幂等：重复应用不报错、版本戳为 1、与 audit/mission 共库互不踩踏', () => {
    const { db } = makeStore();
    applyLongtaskSchema(db);
    applyLongtaskSchema(db);
    expect(schemaVersion(db, 'longtask')).toBe(1);
  });
});

describe('app_recent 读写（近 20 条）', () => {
  it('按 exe_path 幂等 upsert：重复使用不增行，只刷新 used_at', () => {
    const { store } = makeStore();
    const e = { id: 'x1', name: '记事本', exePath: 'C:\\Windows\\notepad.exe' };
    store.recordUse(e);
    store.recordUse(e);
    const list = store.listRecent();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('记事本');
    expect(list[0]?.source).toBe('recent');
  });

  it('超过上限裁最旧：记 25 条只剩 20，最近使用在前', async () => {
    const { store } = makeStore();
    for (let i = 0; i < 25; i++) {
      store.recordUse({ id: `id${i}`, name: `App ${i}`, exePath: `C:\\app${i}.exe` });
      await sleep(2); // used_at=Date.now()：拉开毫秒避免同刻并列
    }
    const list = store.listRecent();
    expect(list).toHaveLength(APP_RECENT_LIMIT);
    expect(list[0]?.name).toBe('App 24'); // 最后写入排最前
    expect(list.some((a) => a.name === 'App 0')).toBe(false); // 最旧被裁
    expect(list.some((a) => a.name === 'App 4')).toBe(false); // 第 5 旧也被裁（25-20=5 条出局）
    expect(list.some((a) => a.name === 'App 5')).toBe(true);
  });

  it('老记录被再次使用后回到队首（used_at 刷新）', async () => {
    const { store } = makeStore();
    store.recordUse({ id: 'a', name: 'A', exePath: 'C:\\a.exe' });
    await sleep(2);
    store.recordUse({ id: 'b', name: 'B', exePath: 'C:\\b.exe' });
    await sleep(2);
    store.recordUse({ id: 'a', name: 'A', exePath: 'C:\\a.exe' });
    expect(store.listRecent()[0]?.name).toBe('A');
  });
});
