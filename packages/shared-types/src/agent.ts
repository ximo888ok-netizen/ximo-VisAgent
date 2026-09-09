// Agent 任务 / 状态机类型
import type { OperationLevel } from './tools';

export type TaskStatus =
  | 'IDLE'
  | 'PLANNING'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EMERGENCY_STOPPED';

export interface TaskRequest {
  id: string;
  goal: string;
  createdAt: number;
}

export interface TaskStep {
  id: string;
  taskId: string;
  index: number;
  thought: string;
  actionName: string | null;
  actionArgs: Record<string, unknown> | null;
  resultSummary: string;
  level: OperationLevel;
  approvalStatus: 'NONE' | 'APPROVED' | 'REJECTED' | 'PENDING' | 'EDITED';
  timestamp: number;
  durationMs: number;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}