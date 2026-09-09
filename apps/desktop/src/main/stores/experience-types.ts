// v3 经验层共享类型与 SQL 辅助（从 experience-store.ts 拆分，遵守 300 行上限）
import type Database from 'better-sqlite3';

// ---------- P8: 技能生命周期（sops 表扩展列的唯一类型定义处） ----------

/** SOP 来源：人工保存 or 轨迹蒸馏 */
export type SopOrigin = 'manual' | 'distilled';

/** SOP 生命周期状态：候选 → 影子 → 生效 → 待复核 → 退役 */
export type SopStatus = 'candidate' | 'shadow' | 'active' | 'review' | 'retired';

// ---------- P7: 归因 ----------

export interface AttributionRecord {
  id: string;
  taskId: string;
  taskStatus: string;
  failureStage: 'perception' | 'planning' | 'execution' | 'environment' | 'external' | 'unknown' | null;
  failedStepSeq: number | null;
  rootCause: string;
  evidence: { seq: number; quote: string }[];
  recoveryHint: string | null;
  confidence: number;
  ruleKind: string | null;
  modelUsed: string | null;
  needsReview: boolean;
  humanVerdict: 'correct' | 'incorrect' | 'adjusted' | null;
  createdAt: number;
}

// ---------- P7: 基准 ----------

export interface BenchmarkRow {
  id: string;
  name: string;
  goal: string;
  assertionsJson: string;
  sourceTaskId: string | null;
  origin: string;
  lastRunAt: number | null;
  lastResult: string | null;
  createdAt: number;
}

// ---------- P8: 技能运行 ----------

export interface SkillRunRecord {
  id: string;
  sopId: string;
  taskId: string;
  mode: 'shadow' | 'active' | 'manual';
  adopted: boolean;
  outcome: string | null;
  stepsUsed: number | null;
  tokens: number | null;
  createdAt: number;
}

// ---------- P8: 世界模型 ----------

export interface EnvFactRow {
  id: string;
  kind: 'app' | 'login' | 'path' | 'workflow' | 'preference' | 'ui-convention' | 'fact';
  content: string;
  confidence: number;
  timesObserved: number;
  sourceTaskId: string | null;
  lastVerifiedAt: number | null;
  createdAt: number;
  enabled: boolean;
}

// ---------- P9: 恢复规则 ----------

export interface RecoveryRuleRow {
  id: string;
  name: string;
  detectJson: string;
  actionJson: string;
  sourceAttributionId: string | null;
  enabled: boolean;
  successCount: number;
  failCount: number;
  createdAt: number;
}

// ---------- P9: Prompt 版本 ----------

export interface PromptVersionRow {
  id: string;
  label: string;
  guidance: string;
  origin: 'human' | 'meta';
  benchmarkJson: string | null;
  approvalId: string | null;
  active: boolean;
  createdAt: number;
}

// ---------- P9: 自定义工具 ----------

export interface CustomToolRow {
  id: string;
  name: string;
  description: string;
  schemaJson: string;
  scriptPath: string;
  proposalJson: string | null;
  approvalId: string | null;
  status: string;
  createdAt: number;
}

// ---------- P9: 宪法门提案 ----------

export type MetaProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface MetaProposalRow {
  id: string;
  /** MetaActionType，存库为 TEXT，读取时由 meta-gate 校验 */
  action: string;
  targetId: string;
  reason: string;
  /** 执行该变更所需参数（由 meta-appliers 消费） */
  payloadJson: string;
  status: MetaProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  error: string | null;
}

/** 元层总开关状态：越权尝试后自动停用，需人工恢复 */
export interface MetaState {
  enabled: boolean;
  lastViolation: string | null;
  disabledAt: number | null;
}

// ---------- 共享 SQL 辅助 ----------

/** 幂等加列迁移（表可能尚未创建时静默忽略） */
export function migrateColumn(db: Database.Database, table: string, column: string, type: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch {
    /* 表可能不存在（如 tasks 在 ZODB 中创建），忽略 */
  }
}
