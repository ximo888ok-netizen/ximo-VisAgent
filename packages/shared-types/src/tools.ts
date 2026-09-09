// Agent 工具调用协议（函数调用 JSON）
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentStepAction {
  thought: string;
  action: ToolCall | null; // null = step 或任务完成
  done?: boolean;
  finalAnswer?: string;
}

// 操作分级 L0-L3
export type OperationLevel = 0 | 1 | 2 | 3;

export interface ClassifiedOperation {
  level: OperationLevel;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  source: 'rule' | 'llm';
}

// 工具 JSON schema 集合
export interface ToolSchema {
  name: string;
  description: string;
  level: OperationLevel; // 策略：L0/L1 自动，L2 审批，L3 默认禁止
  source: 'computer' | 'browser' | 'files' | 'office' | 'meta' | 'communication';
  parameters: Record<string, unknown>;
}