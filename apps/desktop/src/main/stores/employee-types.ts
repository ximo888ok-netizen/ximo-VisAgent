/**
 * employee-types.ts — 员工域行类型（与 DDL 逐列对应，C4）
 *
 * 列的物理类型即行的类型：INTEGER→number、可空列→`T | null`。
 * JSON 列以字符串形态出现（*Json），解析在仓储内带兜底。
 */
import type { PositionStatus, FactCardStatus } from '../../shared/schemas/employee';

/** 岗位定义行（positions 表） */
export interface PositionRow {
  id: string;
  name: string;
  roleProfile: string;
  reportTo: string;
  tone: string;
  /** JSON: string[] — 职责范围 */
  dutyScopeJson: string;
  /** JSON: string[] — 职责边界 */
  dutyBoundaryJson: string;
  /** JSON: string[] — 工作目标 */
  goalsJson: string;
  /** JSON: KnowledgeSource[] — 资料清单 */
  knowledgeJson: string;
  /** JSON: string[] — 例行职责 */
  routineJson: string;
  status: PositionStatus;
  createdAt: number;
  updatedAt: number;
}

/** 事实卡行（fact_cards 表） */
export interface FactCardRow {
  id: string;
  positionId: string;
  topic: string;
  claim: string;
  sourceRef: string;
  confidence: number;
  sourceHash: string | null;
  status: FactCardStatus;
  /** 0/1 → false/true */
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 入职报告行（onboarding_reports 表） */
export interface OnboardingReportRow {
  id: string;
  positionId: string;
  /** JSON: { topics: { topic: string; factCardIds: string[]; summary: string }[], ... } */
  reportJson: string;
  /** JSON: { topic: string; question: string; confidence: number }[] */
  questionsJson: string;
  /** JSON: { [sourcePath: string]: number } — 断点续读游标 */
  lastCursorJson: string;
  coverage: number;
  status: 'in_progress' | 'ready' | 'confirmed' | 'rejected';
  createdAt: number;
  updatedAt: number;
}
