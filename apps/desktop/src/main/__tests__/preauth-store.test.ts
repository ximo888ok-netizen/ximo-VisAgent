/**
 * preauth-store.test.ts — preauth_grants 真库用例（A-M6）
 *
 * 仿 checkpoint-store.test.ts：node:sqlite 薄适配驱动同一 MigrationDb 接口。
 * 覆盖：独立版本戳域、create/ack/revoke 生命周期、默认 30 天有效期、
 * 过期清扫、任务绑定与 listActiveForTask（策略层的唯一取数口）。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { schemaVersion } from '../db-migrations';
import { applyLongtaskSchema } from '../longtask-db/migrations';
import {
  applyLongtaskPreauthSchema,
  PREAUTH_SCHEMA_VERSION,
} from '../longtask-db/preauth-migrations';
import { createPreauthStore, DEFAULT_GRANT_TTL_DAYS } from '../preauth-store';
import type { ScopePackage } from '../../shared/schemas/longtask';

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

function makeDb(): MigrationDb {
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskPreauthSchema(db);
  return db;
}

const scope: ScopePackage = {
  appId: 'app-target',
  dirs: ['C:/发票/**'],
  opClasses: ['type_text', 'file_write'],
  sensitiveExcludes: ['删除'],
  budget: { maxDurationMs: 3_600_000, maxSteps: 600, maxTokens: 8_000_000 },
};

describe('longtask-preauth 域迁移', () => {
  it('幂等：重复应用不报错、版本戳正确', () => {
    const db = makeDb();
    applyLongtaskPreauthSchema(db);
    applyLongtaskPreauthSchema(db);
    expect(schemaVersion(db, 'longtask-preauth')).toBe(PREAUTH_SCHEMA_VERSION);
  });

  it('与 app_recent / checkpoint / audit 共库互不踩踏', () => {
    const sync = new DatabaseSync(':memory:');
    const db = toMigrationDb(sync);
    applyLongtaskSchema(db);
    applyLongtaskPreauthSchema(db);
    expect(schemaVersion(db, 'longtask')).toBe(1);
    expect(schemaVersion(db, 'longtask-preauth')).toBe(PREAUTH_SCHEMA_VERSION);
  });
});

describe('grant 生命周期（create/ack/revoke/bindTask）', () => {
  it('create 即 active 但 acked=0：listActiveForTask 取不到（未 ack 永不生效）', () => {
    const store = createPreauthStore(makeDb());
    const g = store.create({ scope });
    expect(g.id).toMatch(/^g_[0-9a-f]{12}$/);
    expect(g.acked).toBe(false);
    expect(g.status).toBe('active');
    // 用户确认参数：默认有效期 30 天
    expect(g.expiresAt - g.issuedAt).toBe(DEFAULT_GRANT_TTL_DAYS * 86_400_000);
    store.bindTask(g.id, 't1');
    expect(store.listActiveForTask('t1')).toHaveLength(0);
  });

  it('ack 后绑任务 → 可取；revoke 后消失', () => {
    const store = createPreauthStore(makeDb());
    const g = store.create({ scope });
    store.bindTask(g.id, 't1');
    expect(store.ack(g.id)).toBe(true);
    expect(store.get(g.id)?.acked).toBe(true);
    expect(store.listActiveForTask('t1')).toHaveLength(1);
    expect(store.revoke(g.id)).toBe(true);
    expect(store.listActiveForTask('t1')).toHaveLength(0);
    expect(store.get(g.id)?.status).toBe('revoked');
  });

  it('ack 携带最终 scope 时定格草稿（授权卡编辑在 ack 一刻落库）', () => {
    const store = createPreauthStore(makeDb());
    const g = store.create({ scope });
    store.ack(g.id, { ...scope, dirs: ['D:/导出/**'] });
    expect(store.get(g.id)?.scope.dirs).toEqual(['D:/导出/**']);
  });

  it('过期清扫：sweepExpired 把到期 active 置 expired，三条件不再满足', () => {
    const store = createPreauthStore(makeDb());
    const g = store.create({ scope, ttlDays: 1 });
    store.ack(g.id);
    store.bindTask(g.id, 't2');
    expect(store.listActiveForTask('t2')).toHaveLength(1);
    const swept = store.sweepExpired(g.expiresAt + 1);
    expect(swept).toBe(1);
    expect(store.get(g.id)?.status).toBe('expired');
    expect(store.listActiveForTask('t2')).toHaveLength(0);
  });

  it('对不存在/已撤销的 grant ack/revoke 幂等失败可见', () => {
    const store = createPreauthStore(makeDb());
    expect(store.ack('g_000000000000')).toBe(false);
    expect(store.revoke('g_000000000000')).toBe(false);
  });
});
