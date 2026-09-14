/**
 * preauth-store.ts — preauth_grants 生命周期仓储（A-M6，规划 §3.3-4）
 *
 * 仓储层（engineering.md §3）：只做 CRUD 与状态迁移；作用域判定纯逻辑在
 * preauth-scope.ts，DDL 归 longtask-db/preauth-migrations.ts 拥有。
 * 策略层唯一取数口 listActiveForTask：先清扫过期（status→expired 可审计），
 * 再返回 acked ∧ active ∧ 未过期 的行——但 approval-policy 仍会独立复核
 * 三生效条件（纵深防御，仓储不是安全边界）。
 */
import { randomBytes } from 'node:crypto';
import { ScopePackageSchema, type ScopePackage } from '../shared/schemas/longtask';
import type { ActiveGrant, GrantStatus } from './preauth-scope';
import type { MigrationDb } from './db-migrations';

/** 用户确认参数（Q8）：grant 默认有效期 30 天 */
export const DEFAULT_GRANT_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

/** preauth_grants 行的应用层形态 */
export interface PreauthGrant extends ActiveGrant {
  issuedAt: number;
  taskId: string | null;
  jobId: string | null;
}

export interface PreauthStore {
  /** 授权卡打开即建：status=active、acked=0（未 ack 永不生效） */
  create(input: { scope: ScopePackage; taskId?: string; jobId?: string; ttlDays?: number; now?: number }): PreauthGrant;
  /** 显式确认（放行前提）；携带 scope 时在 ack 一刻定格授权卡上的最终编辑 */
  ack(grantId: string, scope?: ScopePackage, now?: number): boolean;
  revoke(grantId: string): boolean;
  /** task:start 成功后补绑（A 期 grant 与任务 1:1） */
  bindTask(grantId: string, taskId: string): boolean;
  get(grantId: string): PreauthGrant | null;
  /** 策略层取数口：先扫过期，再返回该任务全部生效 grant（ActiveGrant 形状） */
  listActiveForTask(taskId: string, now?: number): ActiveGrant[];
  /** 到期 active → expired（可审计的显式状态迁移），返回清扫行数 */
  sweepExpired(now?: number): number;
}

interface GrantRow {
  id: string;
  task_id: string | null;
  job_id: string | null;
  scope_json: string;
  status: GrantStatus;
  issued_at: number;
  expires_at: number;
  acked: number;
}

/** better-sqlite3 的 run() 结果（MigrationStatement 返回 unknown，这里唯一收窄点） */
function changesOf(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const c = (result as { changes?: unknown }).changes;
  return typeof c === 'number' ? c : typeof c === 'bigint' ? Number(c) : 0;
}

function toGrant(row: GrantRow): PreauthGrant {
  return {
    id: row.id,
    acked: row.acked === 1,
    status: row.status,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    taskId: row.task_id,
    jobId: row.job_id,
    scope: ScopePackageSchema.parse(JSON.parse(row.scope_json)) as ScopePackage,
  };
}

export function createPreauthStore(db: MigrationDb): PreauthStore {
  const insert = db.prepare(
    `INSERT INTO preauth_grants (id, task_id, job_id, scope_json, status, issued_at, expires_at, acked)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0)`,
  );
  const selectById = db.prepare('SELECT * FROM preauth_grants WHERE id = ?');
  const selectForTask = db.prepare(
    "SELECT * FROM preauth_grants WHERE task_id = ? AND acked = 1 AND status = 'active'",
  );
  const markAcked = db.prepare("UPDATE preauth_grants SET acked = 1 WHERE id = ? AND status = 'active'");
  const rewriteScope = db.prepare(
    "UPDATE preauth_grants SET scope_json = ? WHERE id = ? AND acked = 0 AND status = 'active'",
  );
  const markRevoked = db.prepare("UPDATE preauth_grants SET status = 'revoked' WHERE id = ? AND status = 'active'");
  const bindRow = db.prepare('UPDATE preauth_grants SET task_id = ? WHERE id = ? AND task_id IS NULL');
  const sweep = db.prepare("UPDATE preauth_grants SET status = 'expired' WHERE status = 'active' AND expires_at <= ?");

  const store: PreauthStore = {
    create({ scope, taskId, jobId, ttlDays, now = Date.now() }) {
      const parsed = ScopePackageSchema.parse(scope);
      const id = `g_${randomBytes(6).toString('hex')}`;
      const expiresAt = now + (ttlDays ?? DEFAULT_GRANT_TTL_DAYS) * DAY_MS;
      insert.run(id, taskId ?? null, jobId ?? null, JSON.stringify(parsed), now, expiresAt);
      return toGrant(selectById.get(id) as GrantRow);
    },
    ack(grantId, scope, now = Date.now()) {
      const row = selectById.get(grantId) as GrantRow | undefined;
      if (!row || row.status !== 'active' || now >= row.expires_at) return false;
      // 未 ack 前允许定格最终编辑；已 ack 的 grant 内容不可再改（要改作用域必须重开授权卡）
      if (scope) {
        if (row.acked === 1) return false;
        rewriteScope.run(JSON.stringify(ScopePackageSchema.parse(scope)), grantId);
      }
      return changesOf(markAcked.run(grantId)) > 0;
    },
    revoke(grantId) {
      return changesOf(markRevoked.run(grantId)) > 0;
    },
    bindTask(grantId, taskId) {
      return changesOf(bindRow.run(taskId, grantId)) > 0;
    },
    get(grantId) {
      const row = selectById.get(grantId) as GrantRow | undefined;
      return row ? toGrant(row) : null;
    },
    listActiveForTask(taskId, now = Date.now()) {
      store.sweepExpired(now);
      return (selectForTask.all(taskId) as GrantRow[])
        .map(toGrant)
        .filter((g) => g.expiresAt > now)
        .map(({ issuedAt: _issuedAt, taskId: _taskId, jobId: _jobId, ...active }) => active);
    },
    sweepExpired(now = Date.now()) {
      return changesOf(sweep.run(now));
    },
  };
  return store;
}
