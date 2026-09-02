// 审计事件类型
export interface AuditEvent {
  id: string;
  taskId: string;
  seq: number;
  kind:
    | 'thought'
    | 'tool_call'
    | 'classification'
    | 'approval'
    | 'execution'
    | 'perception'
    | 'error';
  timestamp: number;
  detail: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  kind: string;
  timestamp: number;
  detail: string; // JSON 序列化
}