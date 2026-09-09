/**
 * task-repo.ts — tasks 表仓储（一行一个任务，终态字段只在 finish 时写）
 */
import type Database from 'better-sqlite3';
import { selectRows, selectRow } from './query';
import type { TaskRow } from './rows';

export interface TaskRepo {
  saveTask(taskId: string, goal: string, status?: string): void;
  finishTask(taskId: string, status: string, summary: string, steps?: number, tokens?: number, failureKind?: string): void;
  listTasks(limit?: number): TaskRow[];
  getTask(taskId: string): TaskRow | null;
}

export function createTaskRepo(db: Database.Database): TaskRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO tasks (taskId, goal, status, createdAt, finishedAt, summary)
       VALUES (?, ?, ?, ?, NULL, '')
       ON CONFLICT(taskId) DO UPDATE SET status = excluded.status`,
  );
  const finishStmt = db.prepare(
    `UPDATE tasks SET status = ?, finishedAt = ?, summary = ?, steps = ?, tokens = ?, failureKind = ? WHERE taskId = ?`,
  );
  return {
    saveTask(taskId, goal, status = 'RUNNING') {
      upsertStmt.run(taskId, goal, status, Date.now());
    },
    finishTask(taskId, status, summary, steps, tokens, failureKind) {
      finishStmt.run(status, Date.now(), summary, steps ?? null, tokens ?? null, failureKind ?? null, taskId);
    },
    listTasks(limit = 50) {
      return selectRows<TaskRow>(db, 'SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?', [limit]);
    },
    getTask(taskId) {
      return selectRow<TaskRow>(db, 'SELECT * FROM tasks WHERE taskId = ?', [taskId]);
    },
  };
}
