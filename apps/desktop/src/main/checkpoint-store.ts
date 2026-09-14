/**
 * checkpoint-store.ts — task_checkpoints 仓储（longtask 域，规划 §2.3）
 *
 * 仓储层（engineering.md §3）：只做读写与游标分配；「何时登记、工件怎么取指纹、
 * 双写去重的语义合并」在服务层 longtask-reconcile.ts。DDL 归
 * longtask-db/checkpoint-migrations.ts 拥有，本文件只读写。
 *
 * 双写去重（Q5-C：宿主自动登记 + 模型 checkpoint 工具写同一行 payload）：
 * 工件指纹（path+contentHash 排序集合）与最近一行完全一致 → 不新增 seq，
 * 用模型行的 cursor/summary 原地覆盖（宿主行只保证确定性，语义以更完整的一方为准）。
 */
import {
  CheckpointDraftSchema,
  type CheckpointArtifact,
  type CheckpointCursor,
  type CheckpointDraft,
  type CheckpointKind,
} from '../shared/schemas/longtask';
import type { MigrationDb } from './db-migrations';

/** task_checkpoints 行的应用层形态（JSON 列已反解析） */
export interface TaskCheckpoint {
  taskId: string;
  seq: number;
  kind: CheckpointKind;
  cursor: CheckpointCursor;
  artifacts: CheckpointArtifact[];
  summary: string;
  createdAt: number;
}

export interface AppendResult {
  checkpoint: TaskCheckpoint;
  /** true=并入最近行（双写去重命中），未新增行 */
  deduped: boolean;
}

export interface CheckpointStore {
  /** 追加检查点：seq 按任务单调 +1；同工件指纹合并到最近行 */
  append(draft: CheckpointDraft): AppendResult;
  latest(taskId: string): TaskCheckpoint | null;
  /** seq 降序（最近在前），默认封顶 50 行 */
  list(taskId: string, limit?: number): TaskCheckpoint[];
}

/** 工件指纹：按 path 排序的稳定序列化（顺序无关、大小写/路径原样） */
export function artifactFingerprint(artifacts: CheckpointArtifact[]): string {
  return artifacts
    .map((a) => `${a.path}\u0000${a.contentHash}\u0000${a.role}`)
    .sort()
    .join('\u0001');
}

interface CheckpointRow {
  task_id: string;
  seq: number;
  kind: CheckpointKind;
  cursor_json: string;
  artifacts_json: string;
  summary: string;
  created_at: number;
}

function toCheckpoint(row: CheckpointRow): TaskCheckpoint {
  return {
    taskId: row.task_id,
    seq: row.seq,
    kind: row.kind,
    cursor: JSON.parse(row.cursor_json) as CheckpointCursor,
    artifacts: JSON.parse(row.artifacts_json) as CheckpointArtifact[],
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function createCheckpointStore(db: MigrationDb): CheckpointStore {
  const selectLatest = db.prepare(
    `SELECT task_id, seq, kind, cursor_json, artifacts_json, summary, created_at
     FROM task_checkpoints WHERE task_id = ? ORDER BY seq DESC LIMIT 1`,
  );
  const selectList = db.prepare(
    `SELECT task_id, seq, kind, cursor_json, artifacts_json, summary, created_at
     FROM task_checkpoints WHERE task_id = ? ORDER BY seq DESC LIMIT ?`,
  );
  const insert = db.prepare(
    `INSERT INTO task_checkpoints (task_id, seq, kind, cursor_json, artifacts_json, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const mergeSemantic = db.prepare(
    `UPDATE task_checkpoints SET cursor_json = ?, summary = ? WHERE task_id = ? AND seq = ?`,
  );

  const store: CheckpointStore = {
    append(rawDraft) {
      const draft = CheckpointDraftSchema.parse(rawDraft);
      const latest = store.latest(draft.taskId);
      // 双写去重：游标已由服务层解析完整（模型未给 done 时继承宿主基数），这里原地合流
      if (latest && draft.artifacts.length > 0 && artifactFingerprint(latest.artifacts) === artifactFingerprint(draft.artifacts)) {
        const summary = draft.summary || latest.summary;
        mergeSemantic.run(JSON.stringify(draft.cursor), summary, draft.taskId, latest.seq);
        return {
          checkpoint: { ...latest, kind: latest.kind, cursor: draft.cursor, summary },
          deduped: true,
        };
      }
      const seq = (latest?.seq ?? 0) + 1;
      const createdAt = Date.now();
      insert.run(
        draft.taskId,
        seq,
        draft.kind,
        JSON.stringify(draft.cursor),
        JSON.stringify(draft.artifacts),
        draft.summary,
        createdAt,
      );
      return {
        checkpoint: { ...draft, seq, createdAt },
        deduped: false,
      };
    },
    latest(taskId) {
      const row = selectLatest.get(taskId) as CheckpointRow | undefined;
      return row ? toCheckpoint(row) : null;
    },
    list(taskId, limit = 50) {
      return (selectList.all(taskId, limit) as CheckpointRow[]).map(toCheckpoint);
    },
  };
  return store;
}
