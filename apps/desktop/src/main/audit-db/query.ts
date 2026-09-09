/**
 * query.ts — better-sqlite3 行读取的唯一类型边界
 *
 * 驱动只回 `unknown`，而列形状由 ./migrations.ts 的 DDL 定义。
 * 把「行 → 声明类型」集中在这里用 prepare 的 Result 泛型表达，
 * 全模块因此不需要任何双重断言（engineering.md C2/C4）。
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

/** 读取首行；无命中返回 null（不返回 undefined，调用方只判一种空值） */
export function selectRow<T>(
  db: Database.Database,
  sql: string,
  params: unknown[] = [],
): T | null {
  return db.prepare<unknown[], T>(sql).get(...params) ?? null;
}
