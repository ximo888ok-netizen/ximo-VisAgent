// 审计存储：SQLite（better-sqlite3）
import Database from 'better-sqlite3';
import type { AuditEvent } from '@desktop-agi/shared-types';

export interface AuditRow {
  id: string;
  taskId: string;
  kind: string;
  timestamp: number;
  seq: number;
  detail: string; // JSON
}

export interface TaskRow {
  taskId: string;
  goal: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
  summary: string;
}

export class ZODB {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private upsertTaskStmt: Database.Statement;
  private finishTaskStmt: Database.Statement;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        kind TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit(taskId);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(timestamp);

      CREATE TABLE IF NOT EXISTS tasks (
        taskId TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        createdAt INTEGER NOT NULL,
        finishedAt INTEGER,
        summary TEXT NOT NULL DEFAULT ''
      );
    `);
    this.insertStmt = this.db.prepare(
      'INSERT INTO audit (id, taskId, kind, seq, timestamp, detail) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.upsertTaskStmt = this.db.prepare(
      `INSERT INTO tasks (taskId, goal, status, createdAt, finishedAt, summary)
       VALUES (?, ?, ?, ?, NULL, '')
       ON CONFLICT(taskId) DO UPDATE SET status = excluded.status`,
    );
    this.finishTaskStmt = this.db.prepare(
      `UPDATE tasks SET status = ?, finishedAt = ?, summary = ? WHERE taskId = ?`,
    );
  }

  insert(ev: AuditEvent): void {
    this.insertStmt.run(ev.id, ev.taskId, ev.kind, ev.seq, ev.timestamp, JSON.stringify(ev.detail));
  }

  /**
   * AgentEvent → AuditEvent 落库
   */
  fromAgentEvent(taskId: string, event: Record<string, unknown>): AuditEvent {
    const { type, ...rest } = event;
    const kind = String(type ?? 'unknown') as AuditEvent['kind'];
    return {
      id: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      seq: Date.now(),
      kind,
      timestamp: Date.now(),
      detail: rest as Record<string, unknown>,
    };
  }

  query(taskId?: string, limit = 200): AuditRow[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM audit WHERE taskId = ? ORDER BY timestamp DESC LIMIT ?').all(taskId, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY timestamp DESC LIMIT ?').all(limit);
    return rows as unknown as AuditRow[];
  }

  /** 任务历史：开始任务时记录，重启后仍可恢复 */
  saveTask(taskId: string, goal: string, status = 'RUNNING'): void {
    this.upsertTaskStmt.run(taskId, goal, status, Date.now());
  }

  finishTask(taskId: string, status: string, summary: string): void {
    this.finishTaskStmt.run(status, Date.now(), summary, taskId);
  }

  listTasks(limit = 50): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?')
      .all(limit) as unknown as TaskRow[];
  }

  close(): void {
    this.db.close();
  }

  exportCsv(): string {
    const rows = this.query(undefined, 10000);
    const header = 'id,taskId,kind,timestamp,detail';
    const lines = rows.map((r) =>
      [r.id, r.taskId, r.kind, r.timestamp, `"${r.detail.replace(/"/g, '""')}"`].join(','),
    );
    return [header, ...lines].join('\n');
  }
}