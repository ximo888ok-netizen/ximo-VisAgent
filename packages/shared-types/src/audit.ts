// 审计事件类型
export interface AuditEvent {
  id: string;
  taskId: string;
  seq: number;
  kind:
    // 内核执行链路
    | 'thought'
    | 'step'
    | 'status'
    | 'tool_call'
    | 'classification'
    | 'perception'
    | 'evidence'
    | 'task_result'
    | 'llm_usage'
    // 审批
    | 'approval'
    | 'approval_pending'
    | 'approval_decided'
    | 'approval_result'
    // 审批档位切换（含切入「完全自主」的显式确认留痕）
    | 'approval_mode_changed'
    // 元层（宪法门）
    | 'meta_proposed'
    | 'meta_executed'
    | 'meta_violation_blocked'
    // 任务子系统
    | 'mission_created'
    | 'mission_status_changed'
    | 'subtask_status_changed'
    | 'artifact_created'
    // 能力卡
    | 'capability_matched'
    | 'capability_used'
    | 'capability_failed'
    | 'capability_distilled'
    | 'capability_retired'
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