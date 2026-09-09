/**
 * meta-gate.ts — v3 P9 宪法门（Constitutional Gate）
 *
 * 元层写入的唯一咽喉点。硬编码在代码里，不依赖 prompt 约束。
 *
 * 语义（F15.1 + 宪法红线 1.4）：
 * 1. 白名单之外的一切元层操作 → 拒绝 + 审计 meta_violation_blocked + 元层自动停用；
 * 2. 白名单内的「提权类」变更（激活 prompt / 启用规则 / 注册工具 / 晋升技能）
 *    一律只登记提案，绝不就地生效；必须由人工在「元层待办」批准后经 apply 回调执行；
 * 3. 「降权类」变更（禁用/回滚到已审版本/拒绝）可即时执行 —— 它们不会扩大自主性，
 *    但仍全程留痕；
 * 4. 审计表、审批状态机、安全规则、配置中的安全分项（含 approvalMode——
 *    元层不得自己扩大审批自主性）、宪法门自身永不可被元层写入。
 */
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { MetaProposalRow, MetaProposalStatus, MetaState } from './stores/experience-types';

/** 门只需要写审计事件，不需要整个存储 */
export interface MetaAudit {
  insert(ev: AuditEvent): void;
  fromAgentEvent(taskId: string, event: Record<string, unknown>): AuditEvent;
}

/** 门需要持久化提案与元层开关，同样只声明用到的方法 */
export interface MetaStore {
  insertMetaProposal(row: Omit<MetaProposalRow, 'status' | 'decidedAt' | 'error'> & { status?: MetaProposalStatus }): void;
  getMetaProposal(id: string): MetaProposalRow | null;
  getPendingMetaProposal(targetId: string): MetaProposalRow | null;
  listMetaProposals(status?: MetaProposalStatus, limit?: number): MetaProposalRow[];
  updateMetaProposal(id: string, updates: { status?: MetaProposalStatus; decidedAt?: number; error?: string | null }): boolean;
  getMetaState(): MetaState;
  setMetaState(state: Partial<Pick<MetaState, 'enabled' | 'lastViolation' | 'disabledAt'>>): void;
}

// ---------- 白名单 ----------

export type MetaActionType =
  | 'prompt_activate'
  | 'prompt_rollback'
  | 'sop_promote'
  | 'sop_demote'
  | 'tool_register'
  | 'tool_unregister'
  | 'recovery_rule_enable'
  | 'recovery_rule_disable'
  | 'position_update';

export const META_ACTION_WHITELIST: ReadonlySet<MetaActionType> = new Set([
  'prompt_activate',
  'prompt_rollback',
  'sop_promote',
  'sop_demote',
  'tool_register',
  'tool_unregister',
  'recovery_rule_enable',
  'recovery_rule_disable',
  'position_update',
]);

/** 提权类动作：扩大 Agent 能力，必须经人工批准后生效 */
export const META_ESCALATING_ACTIONS: ReadonlySet<MetaActionType> = new Set([
  'prompt_activate',
  'sop_promote',
  'tool_register',
  'recovery_rule_enable',
  'position_update',
]);

export interface MetaProposal {
  id: string;
  action: MetaActionType;
  targetId: string;
  reason: string;
  createdAt: number;
  status: MetaProposalStatus;
}

export interface ViolationResult {
  violated: boolean;
  code: string;
  detail: string;
}

// ---------- 越权检测 ----------

/**
 * 检测越权行为。每种越权对应一个 code。
 * metaDisabled 由调用方从持久化状态传入（越权后自动停用，直至人工恢复）。
 */
export function detectViolation(
  action: string,
  targetId: string,
  reason: string,
  context?: { autoExecute?: boolean; bypassApproval?: boolean; metaDisabled?: boolean },
): ViolationResult {
  // 0. 元层已被停用（此前发生过越权）
  if (context?.metaDisabled) {
    return { violated: true, code: 'META_DISABLED', detail: '元层已停用：检测到过越权尝试，需人工在设置中重新启用' };
  }

  // 1. 非白名单操作
  if (!META_ACTION_WHITELIST.has(action as MetaActionType)) {
    return { violated: true, code: 'NOT_IN_WHITELIST', detail: `操作「${action}」不在宪法门白名单中` };
  }

  // 2. 自动执行标志（绕过审批）
  if (context?.autoExecute) {
    return { violated: true, code: 'BYPASS_APPROVAL', detail: '元层操作不可自动执行，必须经过人工审批' };
  }

  // 3. bypassApproval 标志
  if (context?.bypassApproval) {
    return { violated: true, code: 'BYPASS_FLAG', detail: 'bypassApproval 标志被设置，这是被禁止的' };
  }

  // 4. 空 targetId
  if (!targetId || targetId.trim() === '') {
    return { violated: true, code: 'EMPTY_TARGET', detail: '元层操作目标 ID 不能为空' };
  }

  // 5. 空 reason
  if (!reason || reason.trim() === '') {
    return { violated: true, code: 'EMPTY_REASON', detail: '元层操作必须提供原因说明' };
  }

  // 6. reason 过长（防注入）
  if (reason.length > 500) {
    return { violated: true, code: 'REASON_TOO_LONG', detail: '元层操作原因说明超过 500 字符限制' };
  }

  // 7. targetId 格式异常（防注入）
  if (/[;'"\\]/.test(targetId)) {
    return { violated: true, code: 'INVALID_TARGET_FORMAT', detail: 'targetId 包含非法字符' };
  }

  // 8-11. action 与 targetId 前缀一致性
  const prefixRules: Array<[string, string, string]> = [
    ['prompt_', 'prompt-', 'prompt'],
    ['tool_', 'tool-', 'tool'],
    ['sop_', 'sop-', 'sop'],
    ['recovery_', 'rec-', 'recovery'],
    ['position_', 'pos-', 'position'],
  ];
  for (const [actionPrefix, targetPrefix, label] of prefixRules) {
    if (action.startsWith(actionPrefix) && !targetId.startsWith(targetPrefix)) {
      return { violated: true, code: 'TYPE_MISMATCH', detail: `${label} 类操作需要 ${targetPrefix}* 格式的 targetId` };
    }
  }

  // 12. 批量操作检测
  if (targetId.includes(',')) {
    return { violated: true, code: 'BATCH_OPERATION', detail: '单个提案不可包含多个 targetId' };
  }

  return { violated: false, code: '', detail: '' };
}

// ---------- 咽喉点：提案登记（不就地生效） ----------

function toProposal(row: MetaProposalRow): MetaProposal {
  return {
    id: row.id,
    action: row.action as MetaActionType,
    targetId: row.targetId,
    reason: row.reason,
    createdAt: row.createdAt,
    status: row.status,
  };
}

/**
 * 元层写操作的唯一入口：只登记提案，不执行变更。
 * 返回 pending 提案（提权类需人工批准后才生效）或 null（被拒）。
 */
export function metaGuard(
  audit: MetaAudit,
  experience: MetaStore,
  action: MetaActionType,
  targetId: string,
  reason: string,
  payload?: Record<string, unknown>,
): MetaProposal | null {
  const state = experience.getMetaState();
  const violation = detectViolation(action, targetId, reason, { metaDisabled: !state.enabled });
  if (violation.violated) {
    const label = `[${violation.code}] ${violation.detail}`;
    experience.setMetaState({ lastViolation: label, enabled: false, disabledAt: Date.now() });
    audit.insert(audit.fromAgentEvent(targetId, {
      type: 'meta_violation_blocked',
      message: `宪法门拒绝: ${label}`,
    }));
    return null;
  }

  // 幂等：同一目标已有待决提案时复用，不排队第二个
  const existing = experience.getPendingMetaProposal(targetId);
  if (existing) return toProposal(existing);

  const proposal: MetaProposalRow = {
    id: `meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    targetId,
    reason,
    payloadJson: JSON.stringify(payload ?? {}),
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    error: null,
  };
  experience.insertMetaProposal(proposal);
  audit.insert(audit.fromAgentEvent(targetId, {
    type: 'meta_proposed',
    proposalId: proposal.id,
    action,
    reason,
  }));
  return toProposal(proposal);
}

/** 该动作是否属于「必须人工批准才生效」的提权类变更 */
export function isEscalating(action: MetaActionType): boolean {
  return META_ESCALATING_ACTIONS.has(action);
}

/** 提案是否已获准执行（供调用方判断能否就地执行降权类变更） */
export function isApproved(proposal: MetaProposal): boolean {
  return proposal.status === 'approved' || proposal.status === 'executed';
}

// ---------- 咽喉点：批准后执行 ----------

/**
 * 人工批准后执行提案。apply 由宿主注册（见 meta-appliers.ts），
 * 执行失败时提案标记为 failed 并保留错误，不重试。
 */
export async function metaApprove(
  audit: MetaAudit,
  experience: MetaStore,
  proposalId: string,
  apply: (proposal: MetaProposal, payload: Record<string, unknown>) => void | Promise<void>,
): Promise<{ ok: true; proposal: MetaProposal } | { ok: false; error: string }> {
  const row = experience.getMetaProposal(proposalId);
  if (!row) return { ok: false, error: '提案不存在' };
  if (row.status !== 'pending') return { ok: false, error: `提案已是 ${row.status}，不能重复决定` };

  const proposal = toProposal(row);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    experience.updateMetaProposal(proposalId, { status: 'failed', decidedAt: Date.now(), error: 'payloadJson 损坏' });
    return { ok: false, error: '提案参数损坏，无法执行' };
  }

  experience.updateMetaProposal(proposalId, { status: 'approved', decidedAt: Date.now() });
  audit.insert(audit.fromAgentEvent(row.targetId, {
    type: 'meta_executed',
    proposalId,
    action: row.action,
    outcome: 'approved',
  }));

  try {
    await apply(proposal, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    experience.updateMetaProposal(proposalId, { status: 'failed', decidedAt: Date.now(), error: message });
    audit.insert(audit.fromAgentEvent(row.targetId, {
      type: 'error',
      message: `宪法门提案执行失败: ${message}`,
    }));
    return { ok: false, error: message };
  }

  experience.updateMetaProposal(proposalId, { status: 'executed', decidedAt: Date.now(), error: null });
  return { ok: true, proposal: { ...proposal, status: 'executed' } };
}

/** 人工拒绝提案：变更不执行，目标状态保持不变 */
export function metaReject(
  audit: MetaAudit,
  experience: MetaStore,
  proposalId: string,
  note?: string,
): boolean {
  const row = experience.getMetaProposal(proposalId);
  if (!row || row.status !== 'pending') return false;
  experience.updateMetaProposal(proposalId, { status: 'rejected', decidedAt: Date.now(), error: note ?? null });
  audit.insert(audit.fromAgentEvent(row.targetId, {
    type: 'meta_proposed',
    proposalId,
    action: row.action,
    outcome: 'rejected',
    note: note ?? '',
  }));
  return true;
}

// ---------- 状态查询与人工恢复 ----------

export interface MetaStatus {
  enabled: boolean;
  lastViolation: string | null;
  disabledAt: number | null;
  pending: number;
}

export function metaStatus(experience: MetaStore): MetaStatus {
  const state: MetaState = experience.getMetaState();
  return {
    enabled: state.enabled,
    lastViolation: state.lastViolation,
    disabledAt: state.disabledAt,
    pending: experience.listMetaProposals('pending', 500).length,
  };
}

/** 仅允许人工调用（UI 明确按钮）：重新启用元层并清空越权记录 */
export function setMetaEnabled(experience: MetaStore, enabled: boolean): MetaStatus {
  experience.setMetaState(enabled
    ? { enabled: true, lastViolation: null, disabledAt: null }
    : { enabled: false, disabledAt: Date.now() });
  return metaStatus(experience);
}

/** 兼容旧调用：最近一次越权说明（持久化，重启后仍可见） */
export function getLastViolation(experience: MetaStore): string | null {
  return experience.getMetaState().lastViolation;
}
