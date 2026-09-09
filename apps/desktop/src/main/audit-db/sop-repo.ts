/**
 * sop-repo.ts — sops 表仓储（模板库）
 *
 * D4：ON CONFLICT 只覆盖「由本次写入决定的字段」，runCount/status/promotedAt/
 * successCount 等运行期累积列一律保留，否则重存模板会把晋升状态洗掉。
 */
import type Database from 'better-sqlite3';
import { selectRows, selectRow } from './query';
import type { SopRow, SopVariable } from './rows';
import type { SopOrigin, SopStatus } from '../stores/experience-types';

export interface SopInput {
  id?: string;
  name: string;
  description?: string;
  goalTemplate: string;
  steps: unknown[];
  variables?: SopVariable[];
  /** v3 P8：省略时为人工模板（origin=manual / status=active） */
  origin?: SopOrigin;
  status?: SopStatus;
  applicability?: unknown;
}

export interface SopRepo {
  saveSop(sop: SopInput): string;
  listSops(): SopRow[];
  getSop(id: string): SopRow | null;
  deleteSop(id: string): void;
  sopRan(id: string): void;
}

export function createSopRepo(db: Database.Database): SopRepo {
  return {
    saveSop(sop) {
      const id = sop.id ?? crypto.randomUUID();
      const existing = selectRow<{ runCount?: number; createdAt?: number; status?: string; promotedAt?: number | null }>(
        db,
        'SELECT runCount, createdAt, status, promotedAt FROM sops WHERE id = ?',
        [id],
      );
      db.prepare(`
      INSERT INTO sops (id, name, description, goalTemplate, stepsJson, variablesJson, runCount, lastRunAt, createdAt,
                        origin, status, applicabilityJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
        goalTemplate = excluded.goalTemplate, stepsJson = excluded.stepsJson,
        variablesJson = excluded.variablesJson, origin = excluded.origin,
        applicabilityJson = excluded.applicabilityJson
    `).run(
        id, sop.name, sop.description ?? '', sop.goalTemplate, JSON.stringify(sop.steps),
        JSON.stringify(sop.variables ?? []),
        existing?.runCount ?? 0, null, existing?.createdAt ?? Date.now(),
        sop.origin ?? 'manual', sop.status ?? existing?.status ?? 'active',
        JSON.stringify(sop.applicability ?? {}),
      );
      return id;
    },

    listSops() {
      return selectRows<SopRow>(db, 'SELECT * FROM sops ORDER BY createdAt DESC');
    },

    getSop(id) {
      return selectRow<SopRow>(db, 'SELECT * FROM sops WHERE id = ?', [id]);
    },

    deleteSop(id) {
      db.prepare('DELETE FROM sops WHERE id = ?').run(id);
    },

    sopRan(id) {
      db.prepare('UPDATE sops SET runCount = runCount + 1, lastRunAt = ? WHERE id = ?').run(Date.now(), id);
    },
  };
}
