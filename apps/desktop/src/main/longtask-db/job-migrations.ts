/**
 * job-migrations.ts — longtask 域 B 期迁移（B-M1：preauth_grants.job_id 查询索引）
 *
 * job 载荷本体走 scheduler.json 文件持久化（沿用既有 JSON 契约，不搬库）；
 * 增量游标复用 task_checkpoints（A-M4 表，不重造）。本步只补 B 期无人值守
 * 触发链的取数索引：审批门每步按 job_id 查有效 grant（listActiveForJob）。
 * 独立版本戳域 'longtask-job'：与 migrations.ts（v1=app_recent）、
 * checkpoint-migrations、preauth-migrations 并行开发共写必冲突，照先例开独立域；
 * CREATE INDEX IF NOT EXISTS 幂等，后续团队同意可折叠为 longtask 域 vN。
 */
import type { MigrationDb } from '../db-migrations';
import { migrateSchema } from '../db-migrations';
import { applyLongtaskPreauthSchema } from './preauth-migrations';

const SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_grant_job ON preauth_grants(job_id, status);
`;

/** job 域当前期望版本：v1 = idx_grant_job */
export const JOB_SCHEMA_VERSION = 1;

/** 自足依赖：先幂等确保 preauth_grants 表在（版本戳守卫），再补 job_id 查询索引 */
export function applyLongtaskJobSchema(db: MigrationDb): void {
  applyLongtaskPreauthSchema(db);
  migrateSchema(db, 'longtask-job', [
    {
      version: JOB_SCHEMA_VERSION,
      apply: (d) => {
        d.exec(SCHEMA);
      },
    },
  ]);
}
