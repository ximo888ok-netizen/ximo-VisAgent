/**
 * query.ts — better-sqlite3 行读取的类型边界
 *
 * 与 audit-db/query.ts 同一模式：驱动只回 unknown，
 * 列形状由 migrations.ts 的 DDL 定义，用 prepare 的 Result 泛型表达。
 */
import type Database from 'better-sqlite3';

/** 读取全部命中行；T 必须与 SELECT 的列集合一致 */
export function selectRows<T>(
  db: Database.Database,
  sql: string,
  params: unknown[] = [],
): T[] {
  return db.prepare<unknown[], T>(sql).all(...params);
}

/** 读取首行；无命中返回 null */
export function selectRow<T>(
  db: Database.Database,
  sql: string,
  params: unknown[] = [],
): T | null {
  return db.prepare<unknown[], T>(sql).get(...params) ?? null;
}
