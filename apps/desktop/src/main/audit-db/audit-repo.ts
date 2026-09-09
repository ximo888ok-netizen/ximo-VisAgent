/**
 * audit-repo.ts — audit 表仓储（事件写入 + 从事件还原步骤轨迹）
 *
 * 事件表是唯一事实源：断点续跑（有损）与技能蒸馏（全保真）都从这里回读，
 * 两条路径故意分开——见 getTaskSteps / getTaskStepDetails 的注释。
 */
import type Database from 'better-sqlite3';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { StepDetail } from '@ximo-visagent/agent-core';
import { selectRows, selectRow } from './query';
import type { AuditRow } from './rows';

export interface AuditRepo {
  insert(ev: AuditEvent): void;
  fromAgentEvent(taskId: string, event: Record<string, unknown>): AuditEvent;
  query(taskId?: string, limit?: number): AuditRow[];
  countApprovalDecisions(since: number): number;
  getTaskSteps(taskId: string): { thought: string; actionName: string | null; resultSummary: string }[];
  getTaskStepDetails(taskId: string): StepDetail[];
}

export function createAuditRepo(db: Database.Database): AuditRepo {
  const insertStmt = db.prepare(
    'INSERT INTO audit (id, taskId, kind, seq, timestamp, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const seqStmt = db.prepare<unknown[], { m: number }>('SELECT COALESCE(MAX(seq), 0) AS m FROM audit');

  /** 进程内单调递增 seq（P2 修复：Date.now() 同毫秒乱序） */
  const nextSeq = (): number => (seqStmt.get()?.m ?? 0) + 1;

  return {
    insert(ev) {
      try {
        insertStmt.run(ev.id, ev.taskId, ev.kind, ev.seq || nextSeq(), ev.timestamp, JSON.stringify(ev.detail));
      } catch (err) {
        console.error('[audit] insert failed', err); // 不再静默吞（P2）
      }
    },

    fromAgentEvent(taskId, event) {
      const { type, ...rest } = event;
      const kind = String(type ?? 'unknown') as AuditEvent['kind'];
      return {
        id: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        seq: nextSeq(),
        kind,
        timestamp: Date.now(),
        detail: rest as Record<string, unknown>,
      };
    },

    query(taskId, limit = 200) {
      return taskId
        ? selectRows<AuditRow>(db, 'SELECT * FROM audit WHERE taskId = ? ORDER BY seq DESC LIMIT ?', [taskId, limit])
        : selectRows<AuditRow>(db, 'SELECT * FROM audit ORDER BY seq DESC LIMIT ?', [limit]);
    },

    /** 统计：指定时间以来的审批决定数（人工干预次数；策略自动放行不算人的干预） */
    countApprovalDecisions(since) {
      const row = selectRow<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM audit WHERE kind = 'approval_decided' AND detail NOT LIKE '%\"decidedBy\":\"policy\"%' AND timestamp >= ?",
        [since],
      );
      return row?.c ?? 0;
    },

    /** 续跑：从审计事件还原任务步骤（thought/actionName/resultSummary） */
    getTaskSteps(taskId) {
      try {
        const rows = selectRows<{ detail: string }>(
          db,
          "SELECT detail FROM audit WHERE taskId = ? AND kind = 'step' ORDER BY seq ASC",
          [taskId],
        );
        const out: { thought: string; actionName: string | null; resultSummary: string }[] = [];
        for (const r of rows) {
          try {
            const d = JSON.parse(r.detail) as { thought?: unknown; actionName?: unknown; resultSummary?: unknown; ok?: unknown };
            const thought = typeof d.thought === 'string' ? d.thought.slice(0, 300) : '';
            const actionName = typeof d.actionName === 'string' ? d.actionName : null;
            const resultSummary = typeof d.resultSummary === 'string' ? d.resultSummary.slice(0, 300) : '';
            if (thought || actionName) out.push({ thought, actionName, resultSummary });
          } catch { /* 跳过损坏行 */ }
        }
        return out;
      } catch {
        return [];
      }
    },

    /**
     * 全保真还原任务轨迹（args/ok/level 齐全，供跨任务技能蒸馏使用）。
     * 与有损的 getTaskSteps 区别：后者只用于断点续跑的步骤骨架。
     */
    getTaskStepDetails(taskId) {
      const rows = selectRows<{ seq: number; detail: string }>(
        db,
        "SELECT seq, detail FROM audit WHERE taskId = ? AND kind = 'step' ORDER BY seq ASC",
        [taskId],
      );
      const out: StepDetail[] = [];
      for (const r of rows) {
        try {
          const d = JSON.parse(r.detail) as Record<string, unknown>;
          const step: StepDetail = {
            index: typeof d.step === 'number' ? d.step : r.seq,
            thought: typeof d.thought === 'string' ? d.thought : '',
            actionName: typeof d.actionName === 'string' ? d.actionName : null,
            resultSummary: typeof d.resultSummary === 'string' ? d.resultSummary : '',
            args: d.args && typeof d.args === 'object' ? (d.args as Record<string, unknown>) : null,
            ok: typeof d.ok === 'boolean' ? d.ok : undefined,
            level: typeof d.level === 'number' ? (d.level as StepDetail['level']) : undefined,
            durationMs: typeof d.durationMs === 'number' ? d.durationMs : undefined,
          };
          out.push(step);
        } catch { /* 跳过损坏行 */ }
      }
      return out;
    },
  };
}
