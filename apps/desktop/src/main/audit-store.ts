/**
 * audit-store.ts — ZODB：SQLite 审计存储的门面
 *
 * 职责边界（A5）：本文件只做「打开连接 + 组装仓储 + 保持稳定的对外方法名」，
 * DDL 见 audit-db/migrations.ts，各表 SQL 见 audit-db/*-repo.ts，回放文件见 audit-db/replay.ts。
 * experience-store 等 v3 仓储通过 exposeDb() 复用同一连接（不得借此绕过列拥有者，见 C5）。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { StepDetail } from '@ximo-visagent/agent-core';
import { applyAuditSchema } from './audit-db/migrations';
import { createAuditRepo, type AuditRepo } from './audit-db/audit-repo';
import { createTaskRepo, type TaskRepo } from './audit-db/task-repo';
import { createSopRepo, type SopRepo, type SopInput } from './audit-db/sop-repo';
import { pruneReplayRoot, readReplayImage, replayDirFor, saveReplayImage } from './audit-db/replay';
import type { AuditRow, TaskRow, SopRow } from './audit-db/rows';

export type { AuditRow, TaskRow, SopRow, SopVariable } from './audit-db/rows';

export class ZODB {
  private db: Database.Database;
  private events: AuditRepo;
  private tasks: TaskRepo;
  private sops: SopRepo;
  private replayDir: string;

  constructor(file: string, replayDir?: string) {
    this.db = new Database(file);
    this.replayDir = replayDir ?? path.join(path.dirname(file), 'replay');
    this.db.pragma('journal_mode = WAL');
    applyAuditSchema(this.db);
    this.events = createAuditRepo(this.db);
    this.tasks = createTaskRepo(this.db);
    this.sops = createSopRepo(this.db);
    // P2-17 修复：回放截图总量封顶，超出删除最旧任务目录
    pruneReplayRoot(this.replayDir);
  }

  // ---------- 审计事件 ----------

  insert(ev: AuditEvent): void {
    this.events.insert(ev);
  }

  /** AgentEvent → AuditEvent 落库 */
  fromAgentEvent(taskId: string, event: Record<string, unknown>): AuditEvent {
    return this.events.fromAgentEvent(taskId, event);
  }

  query(taskId?: string, limit = 200): AuditRow[] {
    return this.events.query(taskId, limit);
  }

  /** 统计：指定时间以来的审批决定数（人工干预次数；策略自动放行不算人的干预） */
  countApprovalDecisions(since: number): number {
    return this.events.countApprovalDecisions(since);
  }

  /** 续跑：从审计事件还原任务步骤（thought/actionName/resultSummary） */
  getTaskSteps(taskId: string): { thought: string; actionName: string | null; resultSummary: string }[] {
    return this.events.getTaskSteps(taskId);
  }

  /** 全保真还原任务轨迹（args/ok/level 齐全，供跨任务技能蒸馏使用） */
  getTaskStepDetails(taskId: string): StepDetail[] {
    return this.events.getTaskStepDetails(taskId);
  }

  // ---------- 任务历史 ----------

  saveTask(taskId: string, goal: string, status = 'RUNNING'): void {
    this.tasks.saveTask(taskId, goal, status);
  }

  finishTask(taskId: string, status: string, summary: string, steps?: number, tokens?: number, failureKind?: string): void {
    this.tasks.finishTask(taskId, status, summary, steps, tokens, failureKind);
  }

  listTasks(limit = 50): TaskRow[] {
    return this.tasks.listTasks(limit);
  }

  getTask(taskId: string): TaskRow | null {
    return this.tasks.getTask(taskId);
  }

  // ---------- SOP 模板库 ----------

  saveSop(sop: SopInput): string {
    return this.sops.saveSop(sop);
  }

  listSops(): SopRow[] {
    return this.sops.listSops();
  }

  getSop(id: string): SopRow | null {
    return this.sops.getSop(id);
  }

  deleteSop(id: string): void {
    this.sops.deleteSop(id);
  }

  sopRan(id: string): void {
    this.sops.sopRan(id);
  }

  // ---------- 回放证据（C3：每步截图落盘） ----------

  replayDirFor(taskId: string): string {
    return replayDirFor(this.replayDir, taskId);
  }

  saveReplayImage(taskId: string, stepIndex: number, jpeg: Buffer): string {
    return saveReplayImage(this.replayDir, taskId, stepIndex, jpeg);
  }

  readReplayImage(taskId: string, stepIndex: number): string | null {
    return readReplayImage(this.replayDir, taskId, stepIndex);
  }

  // ---------- 导出 ----------

  exportCsv(): string {
    const rows = this.query(undefined, 10000);
    const header = 'id,taskId,kind,timestamp,detail';
    const lines = rows.map((r) =>
      [r.id, r.taskId, r.kind, r.timestamp, `"${r.detail.replace(/"/g, '""')}"`].join(','),
    );
    return [header, ...lines].join('\n');
  }

  exportJson(): string {
    const tasks = this.listTasks(10000);
    const audit = this.query(undefined, 10000);
    return JSON.stringify({ exportedAt: new Date().toISOString(), tasks, audit }, null, 2);
  }

  /** 暴露内部 db 实例（仅组合根 index.ts 构造 ExperienceStore 用，不对外） */
  exposeDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
