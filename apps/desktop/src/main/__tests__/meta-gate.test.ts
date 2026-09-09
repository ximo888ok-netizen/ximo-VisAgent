/**
 * meta-gate.test.ts — 宪法门：越权检测 + 阻塞语义 + 审批后执行
 *
 * 用内存版 MetaStore 替身（门的依赖已收窄为接口，无需伪造整个 ExperienceStore）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectViolation,
  META_ACTION_WHITELIST,
  META_ESCALATING_ACTIONS,
  metaGuard,
  metaApprove,
  metaReject,
  metaStatus,
  setMetaEnabled,
  getLastViolation,
  isEscalating,
} from '../meta-gate';
import type { MetaActionType, MetaAudit, MetaStore } from '../meta-gate';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type { MetaProposalRow, MetaProposalStatus } from '../stores/experience-types';

class FakeStore implements MetaStore {
  proposals = new Map<string, MetaProposalRow>();
  state: { enabled: boolean; lastViolation: string | null; disabledAt: number | null } = {
    enabled: true,
    lastViolation: null,
    disabledAt: null,
  };

  insertMetaProposal(row: Omit<MetaProposalRow, 'status' | 'decidedAt' | 'error'> & { status?: MetaProposalStatus }): void {
    this.proposals.set(row.id, {
      ...row,
      status: row.status ?? 'pending',
      decidedAt: null,
      error: null,
    });
  }
  getMetaProposal(id: string): MetaProposalRow | null {
    return this.proposals.get(id) ?? null;
  }
  getPendingMetaProposal(targetId: string): MetaProposalRow | null {
    return [...this.proposals.values()].find((p) => p.targetId === targetId && p.status === 'pending') ?? null;
  }
  listMetaProposals(status?: MetaProposalStatus): MetaProposalRow[] {
    return [...this.proposals.values()].filter((p) => !status || p.status === status);
  }
  updateMetaProposal(id: string, updates: { status?: MetaProposalStatus; decidedAt?: number; error?: string | null }): boolean {
    const row = this.proposals.get(id);
    if (!row) return false;
    this.proposals.set(id, { ...row, ...updates });
    return true;
  }
  getMetaState() {
    return this.state;
  }
  setMetaState(next: Partial<{ enabled: boolean; lastViolation: string | null; disabledAt: number | null }>): void {
    this.state = { ...this.state, ...next };
  }
}

function fakeAudit(): { audit: MetaAudit; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    audit: {
      // 与真实 ZODB 一致：kind 取 type，其余字段收进 detail
      insert: (ev) => { events.push({ kind: ev.kind, ...ev.detail }); },
      fromAgentEvent: (taskId, event) => {
        const { type, ...rest } = event;
        return {
          id: `ev-${events.length}`,
          taskId,
          seq: events.length,
          timestamp: Date.now(),
          kind: String(type ?? 'unknown'),
          detail: rest,
        } as AuditEvent;
      },
    },
  };
}

let store: FakeStore;
let audit: MetaAudit;
let events: Array<Record<string, unknown>>;

beforeEach(() => {
  store = new FakeStore();
  const a = fakeAudit();
  audit = a.audit;
  events = a.events;
});

describe('白名单与分级', () => {
  it('包含 9 种元层操作', () => {
    expect(META_ACTION_WHITELIST.size).toBe(9);
  });

  it('提权类动作必须经人工批准，降权类可即时执行', () => {
    expect(META_ESCALATING_ACTIONS.has('prompt_activate')).toBe(true);
    expect(META_ESCALATING_ACTIONS.has('recovery_rule_enable')).toBe(true);
    expect(META_ESCALATING_ACTIONS.has('tool_register')).toBe(true);
    expect(META_ESCALATING_ACTIONS.has('sop_promote')).toBe(true);
    expect(isEscalating('recovery_rule_disable')).toBe(false);
    expect(isEscalating('prompt_rollback')).toBe(false);
    expect(isEscalating('tool_unregister')).toBe(false);
    expect(isEscalating('sop_demote')).toBe(false);
  });
});

describe('越权检测 detectViolation', () => {

  it('非白名单操作被拒', () => {
    const r = detectViolation('DELETE_EVERYTHING' as MetaActionType, 'all', '删库');
    expect(r.violated).toBe(true);
    expect(r.code).toBe('NOT_IN_WHITELIST');
  });
  it('autoExecute / bypassApproval 标志被拒', () => {
    expect(detectViolation('prompt_activate', 'prompt-v2', '原因', { autoExecute: true }).code).toBe('BYPASS_APPROVAL');
    expect(detectViolation('prompt_activate', 'prompt-v2', '原因', { bypassApproval: true }).code).toBe('BYPASS_FLAG');
  });
  it('空 targetId / 空 reason / 超长 reason 被拒', () => {
    expect(detectViolation('prompt_activate', '', '原因').code).toBe('EMPTY_TARGET');
    expect(detectViolation('prompt_activate', 'prompt-v2', '  ').code).toBe('EMPTY_REASON');
    expect(detectViolation('prompt_activate', 'prompt-v2', 'x'.repeat(501)).code).toBe('REASON_TOO_LONG');
  });
  it('targetId 含注入字符被拒', () => {
    expect(detectViolation('prompt_activate', "prompt-'; DROP", '原因').code).toBe('INVALID_TARGET_FORMAT');
  });
  it('四类 action/targetId 前缀不匹配均被拒', () => {
    expect(detectViolation('prompt_activate', 'wrong-id', '原因').code).toBe('TYPE_MISMATCH');
    expect(detectViolation('tool_register', 'wrong-id', '原因').code).toBe('TYPE_MISMATCH');
    expect(detectViolation('sop_promote', 'wrong-id', '原因').code).toBe('TYPE_MISMATCH');
    expect(detectViolation('recovery_rule_enable', 'wrong-id', '原因').code).toBe('TYPE_MISMATCH');
  });
  it('批量 targetId 被拒', () => {
    expect(detectViolation('sop_promote', 'sop-a,sop-b', '原因').code).toBe('BATCH_OPERATION');
  });
  it('合法提案无越权', () => {
    expect(detectViolation('prompt_activate', 'prompt-v2', '人工激活').violated).toBe(false);
  });
  it('元层停用后一切提案被拒', () => {
    const r = detectViolation('prompt_activate', 'prompt-v2', '原因', { metaDisabled: true });
    expect(r.code).toBe('META_DISABLED');
  });
});

describe('metaGuard 只登记、不生效', () => {
  it('合法提案落库为 pending，且不触碰任何目标数据', () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活', { promptId: 'v2' });
    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe('pending');
    expect(store.proposals.size).toBe(1);
    // 门的唯一职责是登记：没有 apply 回调被调用过
    expect(events.map((e) => e.kind ?? '')).toContain('meta_proposed');
  });

  it('同一目标的重复请求复用已存在的待决提案（幂等）', () => {
    const a = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '第一次', { promptId: 'v2' });
    const b = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '第二次', { promptId: 'v2' });
    expect(b!.id).toBe(a!.id);
    expect(store.proposals.size).toBe(1);
  });

  it('越权提案被拒并自动停用元层 + 留痕', () => {
    const proposal = metaGuard(audit, store, 'DELETE_EVERYTHING' as MetaActionType, 'all', '删除一切');
    expect(proposal).toBeNull();
    expect(store.state.enabled).toBe(false);
    expect(getLastViolation(store)).toContain('NOT_IN_WHITELIST');
    expect(events.map((e) => e.kind ?? '')).toContain('meta_violation_blocked');
  });

  it('停用后连合法提案也无法登记，直至人工恢复', () => {
    metaGuard(audit, store, 'DELETE_EVERYTHING' as MetaActionType, 'all', '越权');
    expect(metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '合法')).toBeNull();
    setMetaEnabled(store, true);
    expect(metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '合法')).not.toBeNull();
  });
});

describe('metaApprove 审批后执行', () => {
  it('执行器被调用一次，提案转 executed', async () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活', { promptId: 'v2' })!;
    let applied: Record<string, unknown> | null = null;
    const res = await metaApprove(audit, store, proposal.id, (_p, payload) => { applied = payload; });
    expect(res.ok).toBe(true);
    expect(applied).toEqual({ promptId: 'v2' });
    expect(store.getMetaProposal(proposal.id)!.status).toBe('executed');
  });

  it('未批准的提案不会执行任何东西', async () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活')!;
    let called = false;
    // 模拟「绕过门直接改数据」被拒绝：必须先 metaGuard 登记，此处不批准即无副作用
    const res = await metaApprove(audit, store, 'not-exist', () => { called = true; });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    expect(store.getMetaProposal(proposal.id)!.status).toBe('pending');
  });

  it('不能重复决定', async () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活')!;
    await metaApprove(audit, store, proposal.id, () => undefined);
    const second = await metaApprove(audit, store, proposal.id, () => { throw new Error('不应再执行'); });
    expect(second.ok).toBe(false);
  });

  it('执行抛错 → 提案标记 failed 且保留错误信息', async () => {
    const proposal = metaGuard(audit, store, 'tool_register', 'tool-x', '注册工具')!;
    const res = await metaApprove(audit, store, proposal.id, () => { throw new Error('脚本被沙箱拒绝'); });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('脚本被沙箱拒绝');
    const row = store.getMetaProposal(proposal.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('脚本被沙箱拒绝');
  });

  it('拒绝的提案永不执行', async () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活')!;
    expect(metaReject(audit, store, proposal.id, '风险过高')).toBe(true);
    expect(store.getMetaProposal(proposal.id)!.status).toBe('rejected');
    const after = await metaApprove(audit, store, proposal.id, () => { throw new Error('不该被调用'); });
    expect(after.ok).toBe(false);
  });

  it('payload 损坏时拒绝执行而不是静默', async () => {
    const proposal = metaGuard(audit, store, 'prompt_activate', 'prompt-v2', '人工激活')!;
    store.proposals.get(proposal.id)!.payloadJson = '{坏 JSON';
    const res = await metaApprove(audit, store, proposal.id, () => undefined);
    expect(res.ok).toBe(false);
  });
});

describe('metaStatus', () => {
  it('汇总待决数量与停用状态', () => {
    metaGuard(audit, store, 'prompt_activate', 'prompt-v1', 'a');
    metaGuard(audit, store, 'tool_register', 'tool-b', 'b');
    const status = metaStatus(store);
    expect(status.enabled).toBe(true);
    expect(status.pending).toBe(2);
  });
});
