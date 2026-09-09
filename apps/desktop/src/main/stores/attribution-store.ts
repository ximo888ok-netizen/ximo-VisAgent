// P7 域：归因 + 基准（AttributionStore）
import type Database from 'better-sqlite3';
import type { AttributionRecord, BenchmarkRow } from './experience-types';
import { migrateColumn } from './experience-types';

export interface AttributionRow {
  id: string;
  taskId: string;
  taskStatus: string;
  failureStage: AttributionRecord['failureStage'];
  failedStepSeq: number | null;
  rootCause: string;
  evidenceJson: string;
  recoveryHint: string | null;
  confidence: number;
  ruleKind: string | null;
  modelUsed: string | null;
  needsReview: number;
  humanVerdict: AttributionRecord['humanVerdict'];
  createdAt: number;
}

export class AttributionStore {
  constructor(private db: Database.Database) {
    this.initTables();
  }

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS attributions (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          taskStatus TEXT NOT NULL,
          failureStage TEXT,
          failedStepSeq INTEGER,
          rootCause TEXT NOT NULL,
          evidenceJson TEXT NOT NULL DEFAULT '[]',
          recoveryHint TEXT,
          confidence REAL NOT NULL,
          ruleKind TEXT,
          modelUsed TEXT,
          needsReview INTEGER NOT NULL DEFAULT 0,
          humanVerdict TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attr_review ON attributions(needsReview);

        CREATE TABLE IF NOT EXISTS benchmark_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          goal TEXT NOT NULL,
          assertionsJson TEXT NOT NULL DEFAULT '{}',
          sourceTaskId TEXT,
          origin TEXT NOT NULL DEFAULT 'user',
          lastRunAt INTEGER,
          lastResult TEXT,
          createdAt INTEGER NOT NULL
        );
      `);
      migrateColumn(this.db, 'tasks', 'benchmark', 'INTEGER NOT NULL DEFAULT 0');
      this.dedupeAttributions();
    } catch (err) {
      console.error('[experience-store] init failed (v3 降级，核心执行链路不受影响)', err);
    }
  }

  /**
   * 幂等迁移：一个任务只保留最新一条归因，并把 taskId 升级为唯一索引。
   * 背景：critic 与 orchestrator 曾双写 attributions，重复行会让
   * getAttribution 随机取行、并使 G7 归因覆盖率虚高。
   */
  private dedupeAttributions(): void {
    try {
      this.db.exec(`
        DELETE FROM attributions WHERE rowid NOT IN (
          SELECT (SELECT rowid FROM attributions b
                  WHERE b.taskId = a.taskId
                  ORDER BY b.createdAt DESC, b.rowid DESC LIMIT 1)
          FROM attributions a
        );
        DROP INDEX IF EXISTS idx_attr_task;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_attr_task ON attributions(taskId);
      `);
    } catch (err) {
      console.error('[experience-store] attributions taskId 唯一索引建立失败，归因仍按可重复写入运行', err);
    }
  }

  // ---------- 归因 CRUD ----------

  insertAttribution(rec: AttributionRecord): void {
    this.db.prepare(`
      INSERT INTO attributions (id, taskId, taskStatus, failureStage, failedStepSeq, rootCause,
        evidenceJson, recoveryHint, confidence, ruleKind, modelUsed, needsReview, humanVerdict, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskId) DO UPDATE SET
        id = excluded.id, taskStatus = excluded.taskStatus, failureStage = excluded.failureStage,
        failedStepSeq = excluded.failedStepSeq, rootCause = excluded.rootCause,
        evidenceJson = excluded.evidenceJson, recoveryHint = excluded.recoveryHint,
        confidence = excluded.confidence, ruleKind = excluded.ruleKind,
        modelUsed = excluded.modelUsed, needsReview = excluded.needsReview,
        humanVerdict = excluded.humanVerdict, createdAt = excluded.createdAt
    `).run(
      rec.id, rec.taskId, rec.taskStatus, rec.failureStage, rec.failedStepSeq,
      rec.rootCause, JSON.stringify(rec.evidence), rec.recoveryHint, rec.confidence,
      rec.ruleKind, rec.modelUsed, rec.needsReview ? 1 : 0, rec.humanVerdict, rec.createdAt,
    );
  }

  listAttributions(status?: 'needsReview' | 'all', limit = 100, offset = 0): { items: AttributionRow[]; total: number } {
    const where = status === 'needsReview' ? 'WHERE needsReview = 1' : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM attributions ${where}`).get() as { c: number }).c;
    const rows = this.db.prepare(
      `SELECT * FROM attributions ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as AttributionRow[];
    return { items: rows, total };
  }

  getAttribution(taskId: string): AttributionRow | null {
    return this.db.prepare('SELECT * FROM attributions WHERE taskId = ?').get(taskId) as AttributionRow | null;
  }

  updateAttributionVerdict(taskId: string, verdict: string, adjustedStage?: string, adjustedRootCause?: string): void {
    const updates: string[] = ['humanVerdict = ?'];
    const params: unknown[] = [verdict];
    if (adjustedStage) { updates.push('failureStage = ?'); params.push(adjustedStage); }
    if (adjustedRootCause) { updates.push('rootCause = ?'); params.push(adjustedRootCause); }
    params.push(taskId);
    this.db.prepare(`UPDATE attributions SET ${updates.join(', ')} WHERE taskId = ?`).run(...params);
  }

  // ---------- 基准 CRUD ----------

  saveBenchmark(row: Omit<BenchmarkRow, 'lastRunAt' | 'lastResult' | 'createdAt'> & { lastRunAt?: number; lastResult?: string; createdAt?: number }): string {
    const id = row.id;
    const existing = this.db.prepare('SELECT createdAt FROM benchmark_tasks WHERE id = ?').get(id) as { createdAt?: number } | undefined;
    this.db.prepare(`
      INSERT INTO benchmark_tasks (id, name, goal, assertionsJson, sourceTaskId, origin, lastRunAt, lastResult, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, goal = excluded.goal,
        assertionsJson = excluded.assertionsJson, lastRunAt = excluded.lastRunAt, lastResult = excluded.lastResult
    `).run(id, row.name, row.goal, row.assertionsJson, row.sourceTaskId, row.origin,
      row.lastRunAt ?? null, row.lastResult ?? null, existing?.createdAt ?? row.createdAt ?? Date.now());
    return id;
  }

  listBenchmarks(): BenchmarkRow[] {
    return this.db.prepare('SELECT * FROM benchmark_tasks ORDER BY createdAt ASC').all() as BenchmarkRow[];
  }

  getBenchmark(id: string): BenchmarkRow | null {
    return this.db.prepare('SELECT * FROM benchmark_tasks WHERE id = ?').get(id) as BenchmarkRow | null;
  }

  updateBenchmarkResult(id: string, lastRunAt: number, lastResult: string): void {
    this.db.prepare('UPDATE benchmark_tasks SET lastRunAt = ?, lastResult = ? WHERE id = ?').run(lastRunAt, lastResult, id);
  }

  // ---------- 统计 ----------

  countAttributions(since: number): { total: number; reviewed: number; correct: number; needsReview: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM attributions WHERE createdAt >= ?').get(since) as { c: number }).c;
    const reviewed = (this.db.prepare('SELECT COUNT(*) AS c FROM attributions WHERE humanVerdict IS NOT NULL AND createdAt >= ?').get(since) as { c: number }).c;
    const correct = (this.db.prepare("SELECT COUNT(*) AS c FROM attributions WHERE humanVerdict = 'correct' AND createdAt >= ?").get(since) as { c: number }).c;
    const needsReview = (this.db.prepare('SELECT COUNT(*) AS c FROM attributions WHERE needsReview = 1 AND createdAt >= ?').get(since) as { c: number }).c;
    return { total, reviewed, correct, needsReview };
  }
}
