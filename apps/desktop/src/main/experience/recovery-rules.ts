/**
 * recovery-rules.ts — 恢复规则的治理咽喉（写入必须过宪法门）
 *
 * 判断依据（为什么走「提案」而不是「自动写入即生效」）：
 * - meta-gate.ts:8-11 语义条款把「启用规则」明确列为提权类变更：一律只登记提案，绝不就地生效；
 * - meta-gate.ts:71 META_ESCALATING_ACTIONS 含 recovery_rule_enable（白名单 meta-gate.ts:59）；
 * - meta-appliers.ts 的 applyRecoveryRuleEnable 是唯一把规则置为 enabled 的执行器，只由 metaApprove 调用；
 * - orchestrator-recovery.ts 的候选过滤只读 enabled 规则。
 * 即：本仓宪法门把「让一条恢复规则开始改变模型行为」定性为自我修改，唯一咽喉是人工批准。
 * 因此提炼侧写 enabled=0 的草稿 + 自动登记 pending 提案 + 审计留痕，批准后执行器才置 1；
 * 未被批准的规则在读取侧永远不可见（不会改变行为），在演化面板的「元层待办」里可见可拒。
 *
 * 淘汰（防止规则库污染成「什么都提示」）：
 * - 同特征（signature）再来一次只 bump timesObserved，不新建第二行；
 * - 连败 / 命中无效 → 自动禁用（降权类，不扩大自主性，即时执行并留痕）；
 * - 容量封顶 + 陈旧无人采纳草稿清退。
 */
import { metaGuard } from '../meta-gate';
import type { MetaAudit, MetaStore } from '../meta-gate';
import type { RecoveryRuleDraft, RecoveryRuleRow } from '../stores/experience-types';
import type { RuleCandidate } from './recovery-signature';

/** 规则库容量与降权阈值 */
export const RECOVERY_RULE_CAP = 200;
export const DEMOTE_AFTER_CONSECUTIVE_FAILS = 3;
/** 从未命中过的草稿超过这个时长即清退（提炼→审批的窗口期，过期说明目标已不再出现） */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * 只声明本模块用到的规则表方法（同 MetaAudit/MetaStore 的收窄纪律）；
 * 提案与元层状态走 meta-gate 自己的 MetaStore 面，ExperienceStore 两者都满足。
 */
export interface RecoveryRuleRepo {
  listRecoveryRules(): RecoveryRuleRow[];
  countRecoveryRules(): number;
  findRecoveryRuleBySignature(signature: string): RecoveryRuleRow | null;
  insertRecoveryRule(row: RecoveryRuleDraft): string;
  bumpRecoveryObservation(id: string, evidenceJson: string, lastSeenAt: number): void;
  toggleRecoveryRule(id: string, enabled: boolean): boolean;
  deleteRecoveryRule(id: string): boolean;
  deleteStaleRecoveryDrafts(cutoffMs: number): number;
  recordRecoveryHit(id: string): void;
  incrementRecoverySuccess(id: string): void;
  incrementRecoveryFail(id: string): void;
}

export interface RecoveryGovernanceDeps {
  experience: RecoveryRuleRepo & MetaStore;
  audit: MetaAudit;
  /** 提炼自哪次任务（审计与证据回溯） */
  taskId: string;
}

export type ProposeOutcome =
  | { status: 'proposed'; ruleId: string; proposalId: string | null }
  | { status: 'merged'; ruleId: string };

function newRuleId(): string {
  // 宪法门要求 recovery_* 类提案的 targetId 必须以 rec- 开头（meta-gate.ts:149），
  // 且不得含 ; ' " \ ,：这里只用 base36 时间戳 + 随机尾巴，格式自证安全。
  return `rec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 人工已经表过态（pending/approved/rejected/executed/failed）就不再自动重复提案 */
function hasProposalFor(deps: RecoveryGovernanceDeps, targetId: string): boolean {
  if (deps.experience.getPendingMetaProposal(targetId)) return true;
  return deps.experience.listMetaProposals(undefined, 200).some((p) => p.targetId === targetId);
}

function evidenceJson(candidate: RuleCandidate, taskId: string): string {
  return JSON.stringify({ taskId, occurrences: candidate.occurrences, steps: candidate.evidence });
}

/**
 * 为草稿规则登记 recovery_rule_enable 提案（宪法门咽喉，只登记不生效）。
 * 三种情形不重复排队：规则已启用（无事可做）、元层因越权被停用（先由人恢复）、
 * 该规则已有任何状态的提案（含被人工拒绝 = 尊重人的决定，不自动重提）。
 */
function ensureProposal(
  deps: RecoveryGovernanceDeps,
  ruleId: string,
  ruleName: string,
  candidate: RuleCandidate,
): string | null {
  if (deps.experience.getMetaState().enabled === false) return null;
  if (hasProposalFor(deps, ruleId)) return null;
  const reason = `轨迹提炼：${candidate.name}；同特征重复 ${candidate.occurrences} 次（步骤 ${candidate.evidence.map((e) => e.step).join(' ')}）；批准后才会启用`.slice(0, 480);
  const proposal = metaGuard(deps.audit, deps.experience, 'recovery_rule_enable', ruleId, reason, {
    ruleId,
    name: ruleName,
    remedy: candidate.action.action,
  });
  return proposal?.id ?? null;
}

/**
 * 候选规则入库 = 写一条 enabled=0 草稿 + 登记 recovery_rule_enable 提案。
 * 同特征已有规则则合并观测计数（人工拒绝过的特征不再自动重提，尊重人的决定）。
 */
export function proposeRecoveryRule(deps: RecoveryGovernanceDeps, candidate: RuleCandidate): ProposeOutcome {
  const now = Date.now();
  const existing = deps.experience.findRecoveryRuleBySignature(candidate.signature);
  if (existing) {
    deps.experience.bumpRecoveryObservation(existing.id, evidenceJson(candidate, deps.taskId), now);
    // 草稿期错过提案（当时元层停用）→ 这次补登记
    const lateProposal = existing.enabled
      ? null
      : ensureProposal(deps, existing.id, existing.name, candidate);
    deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, {
      type: 'recovery_rule_merged',
      ruleId: existing.id,
      signature: candidate.signature,
      timesObserved: existing.timesObserved + 1,
      enabled: existing.enabled,
      proposalId: lateProposal,
    }));
    return { status: 'merged', ruleId: existing.id };
  }

  const ruleId = newRuleId();
  deps.experience.insertRecoveryRule({
    id: ruleId,
    name: candidate.name,
    detectJson: JSON.stringify(candidate.detect),
    actionJson: JSON.stringify(candidate.action),
    sourceAttributionId: null,
    enabled: false,
    signature: candidate.signature,
    origin: 'mined',
    sourceTaskId: deps.taskId,
    evidenceJson: evidenceJson(candidate, deps.taskId),
    lastSeenAt: now,
    timesObserved: 1,
  });
  const proposalId = ensureProposal(deps, ruleId, candidate.name, candidate);

  deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, {
    type: 'recovery_rule_proposed',
    ruleId,
    name: candidate.name,
    signature: candidate.signature,
    detectJson: candidate.detect,
    actionJson: candidate.action,
    proposalId,
    occurrences: candidate.occurrences,
  }));
  enforceRecoveryBudget(deps);
  return { status: 'proposed', ruleId, proposalId };
}

/**
 * 采纳结果结算：成/败计数落账 + 审计留痕 + 立刻跑降权淘汰。
 * 连败的规则不该继续提示模型——降权在下一任务生效，不等人工。
 */
export function settleAdoptionResult(deps: RecoveryGovernanceDeps, ruleId: string, success: boolean): void {
  if (success) deps.experience.incrementRecoverySuccess(ruleId);
  else deps.experience.incrementRecoveryFail(ruleId);
  deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, {
    type: 'recovery_rule_result',
    ruleId,
    success,
  }));
  enforceRecoveryBudget(deps);
}

/** 命中记账（可观测：规则到底有没有在用） */
export function recordRecoveryHit(deps: RecoveryGovernanceDeps, rule: RecoveryRuleRow, reason: string): void {
  deps.experience.recordRecoveryHit(rule.id);
  deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, {
    type: 'recovery_rule_hit',
    ruleId: rule.id,
    name: rule.name,
    hitCount: rule.hitCount + 1,
    reason: reason.slice(0, 200),
  }));
}

/**
 * 淘汰与降权：连败、命中后仍然失败、以及容量超限。
 * 禁用属降权类（meta-gate.ts:10-12：不扩大自主性，可即时执行但必须留痕），因此不经提案。
 */
export function enforceRecoveryBudget(deps: RecoveryGovernanceDeps): { demoted: string[]; deleted: number } {
  const rules = deps.experience.listRecoveryRules();
  const demoted: string[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const losing = r.failCount >= DEMOTE_AFTER_CONSECUTIVE_FAILS && r.failCount > r.successCount;
    const useless = r.hitCount >= 5 && r.successCount === 0;
    if (!losing && !useless) continue;
    if (deps.experience.toggleRecoveryRule(r.id, false)) {
      demoted.push(r.id);
      deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, {
        type: 'recovery_rule_demoted',
        ruleId: r.id,
        name: r.name,
        successCount: r.successCount,
        failCount: r.failCount,
        hitCount: r.hitCount,
        cause: losing ? 'consecutive_fails' : 'no_adoption',
      }));
    }
  }

  let deleted = 0;
  if (deps.experience.countRecoveryRules() > RECOVERY_RULE_CAP) {
    deleted += deps.experience.deleteStaleRecoveryDrafts(Date.now() - DRAFT_TTL_MS);
    if (deps.experience.countRecoveryRules() > RECOVERY_RULE_CAP) {
      // 仍超限：按「观测次数少 → 创建时间早」淘汰未启用的草稿，已生效规则不动
      const drafts = rules
        .filter((r) => !r.enabled)
        .sort((a, b) => (a.timesObserved - b.timesObserved) || (a.createdAt - b.createdAt));
      let overflow = deps.experience.countRecoveryRules() - RECOVERY_RULE_CAP;
      for (const d of drafts) {
        if (overflow <= 0) break;
        if (deps.experience.deleteRecoveryRule(d.id)) {
          deleted += 1;
          overflow -= 1;
        }
      }
    }
  }
  if (deleted > 0) {
    deps.audit.insert(deps.audit.fromAgentEvent(deps.taskId, { type: 'recovery_rule_pruned', deleted }));
  }
  return { demoted, deleted };
}
