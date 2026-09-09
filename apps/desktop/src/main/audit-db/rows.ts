/**
 * rows.ts — 审计库的行类型（与 migrations.ts 的 DDL 逐列对应）
 *
 * 列的物理类型即行的类型：INTEGER→number、可空列→`T | null`（C4）。
 * JSON 列以字符串形态出现（*Json），解析发生在各自仓储内并带兜底。
 */
import type { SopOrigin, SopStatus } from '../stores/experience-types';

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
  steps: number | null;
  tokens: number | null;
  failureKind: string | null;
}

/** SOP 变量占位符声明（序列化进 sops.variablesJson） */
export interface SopVariable {
  key: string;
  label: string;
  defaultValue: string;
}

export interface SopRow {
  id: string;
  name: string;
  description: string;
  goalTemplate: string;
  stepsJson: string; // ParameterizedStep[]/StepDetail[] 序列化
  variablesJson: string; // SopVariable[] 序列化
  runCount: number;
  lastRunAt: number | null;
  createdAt: number;
  /** v3 P8 生命周期列 */
  origin: SopOrigin;
  status: SopStatus;
  applicabilityJson: string;
  successCount: number;
  failCount: number;
  promotedAt: number | null;
}
