/**
 * orchestrator-approval.ts — 审批结论的回写与留痕（从 orchestrator.ts 拆出）
 *
 * 审批状态机本身在 safety 包（ApprovalEngine），这里只负责：
 * 把人的决定送回状态机，并按审批记录里的真实 taskId 落审计 ——
 * 用 approvalId 当 taskId 会让审批事件挂到错误的任务上（BUG-19）。
 */
import type { ApprovalDecision, ApprovalEngine } from '@ximo-visagent/safety';
import type { ApprovalMode, AppConfig } from '@ximo-visagent/shared-types';
import type { ZODB } from './audit-store';
import { assertModeChangeAllowed, parseApprovalMode, resolveApprovalDecision } from './approval-policy';
import { findPreauthHit, type ActiveGrant } from './preauth-scope';
import { publishStep } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';

export function decideApproval(
  approvals: ApprovalEngine,
  audit: ZODB,
  id: string,
  decision: ApprovalDecision,
): void {
  try {
    approvals.decide(id, decision);
    const record = approvals.get(id);
    audit.insert(audit.fromAgentEvent(record?.taskId ?? id, { type: 'approval_decided', decision }));
  } catch (err) {
    console.error('[approval] 决定回写失败', err);
  }
}

/**
 * 审批档位变更的唯一合法入口：值校验 + ack 门 + 落库 + 留痕。
 * ack 门在主进程强校验（I7）；切入 autonomous 的留痕让「谁在什么时候
 * 放弃了人审」永远可追溯。返回最终生效的档位（同档重复提交直接返回）。
 */
export function applyApprovalModeChange(
  configStore: { get(): AppConfig; set(partial: Partial<AppConfig>): void },
  audit: ZODB,
  next: unknown,
  ack: unknown,
): ApprovalMode {
  const to = parseApprovalMode(next);
  const from = configStore.get().approvalMode;
  assertModeChangeAllowed(from, to, ack);
  if (to === from) return to;
  configStore.set({ approvalMode: to });
  try {
    audit.insert(audit.fromAgentEvent('system', { type: 'approval_mode_changed', from, to, ts: Date.now() }));
  } catch (err) {
    // 落库失败不回滚档位（用户的明确意愿优先），但必须可见
    console.error('[approval] 档位切换留痕失败', err);
  }
  return to;
}

// ---------- 审批门（S11：档位自动放行 + 五道刹车） ----------

export interface ApprovalGateOp {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  level?: number;
  appName?: string;
}

interface ApprovalGateDeps {
  /** 只用到事件映射+落库两个口（装配级可测）；生产注入仍是 ZODB 实例 */
  audit: Pick<ZODB, 'insert' | 'fromAgentEvent'>;
  /** 每次实时读档位（运行中即时生效；launch 时的配置快照不用于审批） */
  getConfigMode: () => unknown;
  isE2E: boolean;
  timeoutMs: number;
  /** 规则热更新后的等级复查：运行中抬高规则不能被 loop 里的分级快照绕过 */
  escalatedLevel: (op: ApprovalGateOp) => number;
  announce: (taskId: string, approvalId: string, tool: string, reason: string) => void;
  auraRequest: (approvalId: string) => void;
  requestUI: (
    approvalId: string,
    op: ApprovalGateOp,
    timeoutMs: number,
  ) => Promise<{ action: 'approve' | 'reject' | 'edit'; reason?: string; newArgs?: Record<string, unknown> } | null>;
  islandVisible: () => boolean;
  /**
   * A-M6 预授权仓储（可缺省=功能未装配，行为与现状逐字节一致）。
   * 取数口只返回 acked ∧ active ∧ 未过期的 grant；approval-policy 仍独立复核。
   * B-M1：listActiveForJob = job 级作用域包（无人值守触发链按 job_id 命中，规划 §2.2/§2.4）。
   */
  grantRepo?: {
    listActiveForTask(taskId: string): ActiveGrant[];
    listActiveForJob?(jobId: string): ActiveGrant[];
  };
}

type GateDecision = Awaited<ReturnType<ApprovalGateDeps['requestUI']>>;

/**
 * 每任务一个审批门（闭包内持有配额）。E2E 下只外抛事件并强制走 UI 应答，
 * 自动档位不生效（T5：审批必须经外部脚本显式应答并计入报告）。
 */
export function createApprovalGate(
  deps: ApprovalGateDeps,
  task: { taskId: string; interactive: boolean; jobId?: string },
): (approvalId: string, op: ApprovalGateOp) => Promise<GateDecision> {
  const quota = { usedL2: 0, usedL3: 0 };
  return async (approvalId, op) => {
    if (deps.isE2E) {
      deps.announce(task.taskId, approvalId, op.tool, op.reason);
    }
    const mode = deps.getConfigMode();
    // 取 loop 分级与规则热更新复查中的较大者：只会更严，不会更松
    const level = Math.max(op.level ?? 2, deps.escalatedLevel(op));
    const grants = [
      ...(deps.grantRepo?.listActiveForTask(task.taskId) ?? []),
      ...(task.jobId ? deps.grantRepo?.listActiveForJob?.(task.jobId) ?? [] : []),
    ];
    const grantCtx = matchContextOf(op);
    if (
      resolveApprovalDecision({
        mode,
        level,
        tool: op.tool,
        interactive: task.interactive,
        islandVisible: deps.islandVisible(),
        usedL2: quota.usedL2,
        usedL3: quota.usedL3,
        grantCtx,
      }, grants) === 'auto'
    ) {
      // 区分放行来源（审计口径 + FR-007）：preauth 命中不消耗配额，policy 路径照旧
      const preauth = grants?.length
        ? findPreauthHit(grants, { tool: op.tool, level, ...grantCtx })
        : null;
      if (!preauth) {
        if (level >= 3) quota.usedL3 += 1;
        else quota.usedL2 += 1;
      }
      recordPolicyApproval(deps.audit, task.taskId, approvalId, op, level, parseApprovalMode(mode), preauth?.id);
      return { action: 'approve' };
    }
    deps.auraRequest(approvalId);
    return deps.requestUI(approvalId, op, deps.timeoutMs);
  };
}

/** grant 匹配上下文：写入/导出取参数中的路径，窗口文本用审批已知的 appName */
function matchContextOf(op: ApprovalGateOp): { targetPath?: string; windowText?: string } {
  const keys = ['path', 'file_path', 'filePath', 'file', 'dest', 'destination'] as const;
  for (const k of keys) {
    const v = op.args[k];
    if (typeof v === 'string' && v) return { targetPath: v, windowText: op.appName };
  }
  return { windowText: op.appName };
}

/** 策略放行的留痕：持久记录在 approval_decided（decidedBy:'policy'|'preauth'），日志行只是实时 UI */
function recordPolicyApproval(
  audit: Pick<ZODB, 'insert' | 'fromAgentEvent'>,
  taskId: string,
  approvalId: string,
  op: ApprovalGateOp,
  level: number,
  mode: ApprovalMode,
  preauthGrantId?: string,
): void {
  try {
    audit.insert(
      audit.fromAgentEvent(taskId, {
        type: 'approval_decided',
        approvalId,
        tool: op.tool,
        decision: { action: 'approve' },
        decidedBy: preauthGrantId ? 'preauth' : 'policy',
        ...(preauthGrantId ? { grantId: preauthGrantId } : {}),
        mode,
        level,
        irreversible: level >= 3,
      }),
    );
  } catch (err) {
    console.error('[approval] 自动放行留痕失败', err);
  }
  publishStep(
    createStepEvent(
      'thinking',
      preauthGrantId
        ? `预授权放行 · ${op.tool}（作用域包 ${preauthGrantId}）`
        : `${level >= 3 ? '⚠ ' : ''}已自动放行 · ${op.tool}（L${level}，${mode === 'autonomous' ? '完全自主' : '自动审批'}）`,
    ),
  );
}
