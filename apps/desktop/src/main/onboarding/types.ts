/**
 * onboarding/types.ts — 入职执行器共享类型与常量
 */
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { EmployeeStore } from '../stores/employee-store';
import type { ZODB } from '../audit-store';

/** 单个资料分块（≤2000 字符，带行号区间） */
export interface DocChunk {
  source: string;
  chunkIndex: number;
  text: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
}

/** LLM 产出的事实卡（待入库） */
export interface RawFactCard {
  topic: string;
  claim: string;
  sourceRef: string;
  confidence: number;
}

/** 环境画像 */
export interface EnvProfile {
  apps: string[];
  dirs: string[];
  workspaceDir: string;
}

/** 单阶段 token 预算上限（粗估：1 token ≈ 3 字符） */
export const TOKEN_BUDGET = 12_000;
export const CHUNK_CHAR_LIMIT = 2000;
export const MIN_CHUNK_SIZE = 200;

export interface OnboardingOptions {
  positionId: string;
  llm: ILLMClient;
  employee: EmployeeStore;
  audit: ZODB;
  workspaceDir: string;
  skipCodebase?: boolean;
  onProgress?: (stage: string, detail: string) => void;
}

export interface OnboardingResult {
  reportId: string;
  positionId: string;
  coverage: number;
  factCardCount: number;
  questionCount: number;
}
