/**
 * capability-meta-gate.test.ts — 能力知识库写入纪律：capabilities 写只走宪法门
 *
 * 对应 mission-knowledge-development-plan §3.4 与 §8 不变量3：
 * 提案登记阶段不落库；拒绝不落库；批准才由执行器落库并全程审计留痕。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectViolation, metaGuard, metaApprove, metaReject } from '../meta-gate';
import type { MetaAudit, MetaStore } from '../meta-gate';
import {
  applyCapabilityUpsert,
  applyCapabilityDisable,
  type CapabilityApplyDeps,
} from '../meta-appliers';
import type { AuditEvent } from '@ximo-visagent/shared-types';
import type {
  CapabilityCardPayload,
  CapabilityCreateRequest,
  CapabilityUpdateRequest,
} from '../../shared/schemas/capability';
import type { MetaProposalRow, MetaProposalStatus } from '../stores/experience-types';

// ---------- 替身：门的状态存储 / 审计 / 能力仓储 ----------

class FakeStore implements MetaStore {
  proposals = new Map<string, MetaProposalRow>();
  state = { enabled: true, lastViolation: null as string | null, disabledAt: null as number | null };

  insertMetaProposal(row: Omit<MetaProposalRow, 'status' | 'decidedAt' | 'error'> & { status?: MetaProposalStatus }): void {
    this.proposals.set(row.id, { ...row, status: row.status ?? 'pending', decidedAt: null, error: null });
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

function fakeAudit(): { audit: MetaAudit; kinds: string[] } {
  const kinds: string[] = [];
  let seq = 0;
  return {
    kinds,
    audit: {
      insert: (ev) => { kinds.push(ev.kind); },
      fromAgentEvent: (taskId, event) => ({
        id: `ev-${seq}`,
        taskId,
        seq: seq++,
        timestamp: Date.now(),
        kind: String(event.type ?? 'unknown'),
        detail: {},
      } as AuditEvent),
    },
  };
}

/** 能力仓储替身：记录写入调用（=「落库」的唯一判定点） */
class FakeWriter implements CapabilityApplyDeps {
  mission: {
    rows: Map<string, CapabilityCardPayload>;
    getCapability(id: string): CapabilityCardPayload | null;
    createCapability(req: CapabilityCreateRequest): { id: string };
    updateCapability(req: CapabilityUpdateRequest): void;
  };
  created: CapabilityCreateRequest[] = [];
  updated: CapabilityUpdateRequest[] = [];

  constructor(existing: string[] = []) {
    const rows = new Map<string, CapabilityCardPayload>();
    for (const id of existing) rows.set(id, card(id));
    this.mission = {
      rows,
      getCapability: (id) => rows.get(id) ?? null,
      createCapability: (req) => { this.created.push(req); return { id: req.id }; },
      updateCapability: (req) => { this.updated.push(req); },
    };
  }

  get writeCount(): number {
    return this.created.length + this.updated.length;
  }
}

function card(id: string): CapabilityCardPayload {
  return {
    id,
    title: `能力 ${id}`,
    description: '',
    tools: [],
    precondition: '',
    acceptance: '',
    visualAnchors: [],
    status: 'active',
    source: 'seed',
    usageCount: 0,
    failCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

const CREATE_PAYLOAD: Record<string, unknown> = {
  id: 'cap.demo.new',
  title: '演示能力',
  description: 'd',
  tools: ['file_write'],
  precondition: '',
  acceptance: '',
  visualAnchors: [],
  operator: 'user_direct',
};

let store: FakeStore;
let audit: MetaAudit;
let kinds: string[];

beforeEach(() => {
  store = new FakeStore();
  const a = fakeAudit();
  audit = a.audit;
  kinds = a.kinds;
});

describe('能力写经门：登记与拒绝阶段不落库', () => {
  it('metaGuard 只登记 capability_upsert 提案，仓储零写入', () => {
    const writer = new FakeWriter();
    const proposal = metaGuard(audit, store, 'capability_upsert', 'cap:cap.demo.new', '面板人工创建能力卡', CREATE_PAYLOAD);
    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe('pending');
    expect(writer.writeCount).toBe(0);
    expect(kinds).toContain('meta_proposed');
  });

  it('人工拒绝 → 提案 rejected，执行器永不被调用（不落库）', async () => {
    const writer = new FakeWriter(['cap.demo.new']);
    const proposal = metaGuard(audit, store, 'capability_disable', 'cap:cap.demo.new', '面板人工退役能力卡', { id: 'cap.demo.new' })!;
    expect(metaReject(audit, store, proposal.id, '风险过高')).toBe(true);
    const res = await metaApprove(audit, store, proposal.id, (_p, payload) =>
      applyCapabilityDisable(writer, payload));
    expect(res.ok).toBe(false);
    expect(writer.writeCount).toBe(0);
  });

  it('targetId 不在 cap: 命名空间 → 越权拒绝并停用元层，提案不落库', () => {
    expect(detectViolation('capability_upsert', 'wrong-id', '原因').code).toBe('TYPE_MISMATCH');
    const writer = new FakeWriter();
    const proposal = metaGuard(audit, store, 'capability_upsert', 'wrong-id', '原因', CREATE_PAYLOAD);
    expect(proposal).toBeNull();
    expect(store.state.enabled).toBe(false);
    expect(kinds).toContain('meta_violation_blocked');
    expect(writer.writeCount).toBe(0);
  });
});

describe('能力写经门：批准后落库 + 审计留痕', () => {
  it('capability_upsert 批准 → create 落库，审计含 meta_proposed/meta_executed', async () => {
    const writer = new FakeWriter();
    const proposal = metaGuard(audit, store, 'capability_upsert', 'cap:cap.demo.new', '面板人工创建能力卡', CREATE_PAYLOAD)!;
    const res = await metaApprove(audit, store, proposal.id, (_p, payload) => {
      applyCapabilityUpsert(writer, payload);
    });
    expect(res.ok).toBe(true);
    expect(writer.created).toHaveLength(1);
    expect(writer.created[0]?.id).toBe('cap.demo.new');
    expect(store.getMetaProposal(proposal.id)!.status).toBe('executed');
    expect(kinds).toContain('meta_proposed');
    expect(kinds).toContain('meta_executed');
  });

  it('upsert 对已存在的能力卡转为更新而非重复创建', () => {
    const writer = new FakeWriter(['cap.demo.new']);
    applyCapabilityUpsert(writer, CREATE_PAYLOAD);
    expect(writer.created).toHaveLength(0);
    expect(writer.updated).toHaveLength(1);
  });

  it('部分编辑提案批准后按更新落库；目标不存在则失败可见', () => {
    const writer = new FakeWriter(['cap.demo.new']);
    applyCapabilityUpsert(writer, { id: 'cap.demo.new', title: '新标题' });
    expect(writer.updated).toEqual([{ id: 'cap.demo.new', title: '新标题' }]);
    expect(() => applyCapabilityUpsert(writer, { id: 'cap.missing', title: 'x' })).toThrow('能力卡不存在');
  });

  it('capability_disable 批准 → 状态置 retired 落库', async () => {
    const writer = new FakeWriter(['cap.demo.new']);
    const proposal = metaGuard(audit, store, 'capability_disable', 'cap:cap.demo.new', '面板人工退役能力卡', { id: 'cap.demo.new' })!;
    const res = await metaApprove(audit, store, proposal.id, (_p, payload) =>
      applyCapabilityDisable(writer, payload));
    expect(res.ok).toBe(true);
    expect(writer.updated).toEqual([{ id: 'cap.demo.new', status: 'retired' }]);
    expect(kinds).toContain('meta_executed');
  });

  it('提案参数损坏时执行器拒绝落库（可见失败）', () => {
    const writer = new FakeWriter();
    expect(() => applyCapabilityUpsert(writer, { foo: 1 })).toThrow('参数损坏');
    expect(writer.writeCount).toBe(0);
  });
});
