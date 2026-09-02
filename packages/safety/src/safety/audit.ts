// 审计事件结构化（纯逻辑，独立于存储）
import type { AuditEvent } from '@desktop-agi/shared-types';

let _seq = 0;

export function createAuditEvent(
  taskId: string,
  kind: AuditEvent['kind'],
  detail: Record<string, unknown>,
): AuditEvent {
  _seq += 1;
  return {
    id: `${taskId}-${_seq}`,
    taskId,
    seq: _seq,
    kind,
    timestamp: Date.now(),
    detail,
  };
}