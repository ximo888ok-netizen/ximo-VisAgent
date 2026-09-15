/**
 * employee-store.test.ts — 员工域存储回归
 *
 * 钉死「AI 员工无法删除」缺陷：mission-db 迁移在共享连接上执行 PRAGMA foreign_keys=ON 后，
 * 存量库（fact_cards/onboarding_reports 建表无 ON DELETE CASCADE）直接删 positions 抛
 * FOREIGN KEY 约束异常。deletePosition 现于事务内手动级联，对存量库与新库均成立。
 *
 * 驱动用 node:sqlite + 结构适配（desktop 测试环境加载不了 Electron ABI 编译的 better-sqlite3，
 * 与 checkpoint-store/db-migrations 测试同一模式）；EmployeeStore 只用到
 * prepare/exec/transaction 面，适配器提供同形结构。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { EmployeeStore } from "../stores/employee-store";

type Params = (string | number | bigint | null | undefined)[];

/** node:sqlite → better-sqlite3 结构子集适配（含 run().changes 与 transaction()） */
function asSqlite3(sync: DatabaseSync): Database.Database {
  const prepare = (sql: string) => ({
    run: (...p: Params) => {
      const r = sync.prepare(sql).run(...p as (string | number | null)[]) as { changes: number | bigint };
      return { changes: Number(r.changes), lastInsertRowid: 0 };
    },
    get: (...p: Params) => sync.prepare(sql).get(...(p as (string | number | null)[])) ?? null,
    all: (...p: Params) => sync.prepare(sql).all(...(p as (string | number | null)[])),
  });
  return {
    prepare,
    exec: (sql: string) => sync.exec(sql),
    transaction(fn: (...a: Params) => unknown) {
      return (...args: Params) => {
        sync.exec("BEGIN");
        try {
          const out = fn(...args);
          sync.exec("COMMIT");
          return out;
        } catch (e) {
          sync.exec("ROLLBACK");
          throw e;
        }
      };
    },
  } as unknown as Database.Database;
}

function seed(store: EmployeeStore, posId: string) {
  store.insertPosition({
    id: posId, name: `岗位-${posId}`, roleProfile: "", reportTo: "", tone: "",
    dutyScopeJson: "[]", dutyBoundaryJson: "[]", goalsJson: "[]",
    knowledgeJson: "[]", routineJson: "[]", status: "active",
  });
  store.insertFactCard({
    id: `fc-${posId}`, positionId: posId, topic: "t", claim: "事实", sourceRef: "src",
    confidence: 0.9, sourceHash: null, status: "active", confirmed: true,
  });
  store.upsertReport({
    id: `rp-${posId}`, positionId: posId, reportJson: "{}", questionsJson: "[]",
    lastCursorJson: "{}", coverage: 1, status: "confirmed",
  });
}

describe("EmployeeStore.deletePosition（FK 开启下的级联删除）", () => {
  let store: EmployeeStore;

  beforeEach(() => {
    const sync = new DatabaseSync(":memory:");
    sync.exec("PRAGMA foreign_keys = ON;"); // 复现共库连接的运行时状态
    store = new EmployeeStore(asSqlite3(sync));
  });

  it("持有事实卡与入职报告的岗位可删除，且子行随事务清空", () => {
    seed(store, "p1");
    expect(store.deletePosition("p1")).toBe(true);
    expect(store.getPosition("p1")).toBeNull();
    expect(store.listFactCards("p1")).toHaveLength(0);
    expect(store.listReports("p1")).toHaveLength(0);
  });

  it("删除不影响其他岗位的数据", () => {
    seed(store, "p1");
    seed(store, "p2");
    store.deletePosition("p1");
    expect(store.getPosition("p2")).not.toBeNull();
    expect(store.listFactCards("p2")).toHaveLength(1);
    expect(store.listReports("p2")).toHaveLength(1);
  });

  it("删除后 FTS 不再命中该岗位事实卡（ad 触发器随级联生效）", () => {
    seed(store, "p2");
    expect(store.searchFactCardsFTS("事实", "p2").length).toBeGreaterThan(0);
    store.deletePosition("p2");
    expect(store.searchFactCardsFTS("事实", "p2")).toHaveLength(0);
  });

  it("删除不存在的岗位返回 false 而非抛错", () => {
    expect(store.deletePosition("nope")).toBe(false);
  });
});
