// 恢复策略钩子的宿主契约（从 loop.ts 拆出）
/** 传给宿主匹配器的本轮上下文（与 recovery_rules.detect 的口径一一对应） */
export interface RecoveryContext {
  stepIndex: number;
  lastTool?: string;
  lastResult?: string;
  /** 上一步是否执行成功（宿主据此判断 lastResult 是否为错误摘要） */
  lastOk?: boolean;
  /** 当前前台窗口标题 */
  windowTitle?: string;
}

/** 宿主返回的恢复策略命中结果 */
export interface RecoveryHit {
  /** auto：替换本轮动作（仍会被 SafetyClassifier 复核）；hint：只注入提示 */
  mode: 'auto' | 'hint';
  /** mode=auto 时必填 */
  action?: string;
  args?: Record<string, unknown>;
  reason: string;
  /** 命中的规则 id（宿主用于成功/失败记账闭环；可选，向后兼容） */
  ruleId?: string;
}

import { SafetyClassifier } from '@ximo-visagent/safety';
import type { PerceptionSnap } from './loop-helpers';
  /**
   * 恢复规则的 auto 动作只有在 SafetyClassifier 判为自动档（≤L1）时才允许替换本轮动作；
   * 达到审批级的动作不静默执行，交由调用方降级为提示。
   */
export function resolveAutoRecovery(
    hit: RecoveryHit,
    snap: PerceptionSnap,
    classifier: SafetyClassifier,
): { name: string; args: Record<string, unknown> } | null {
    if (!hit.action) return null;
    const candidate = { name: hit.action, args: hit.args ?? {} };
    const appName = snap.foreground
      ? `${snap.foreground.title} ${snap.foreground.className ?? ''}`.trim()
      : undefined;
    const classified = classifier.classify(candidate, appName, snap.domain);
    return classified.level <= 1 ? candidate : null;
  }

/** 一次执行结果的记账输入（loop 每步执行后调用） */
export interface RecoveryExecution {
  stepIndex: number;
  tool: string;
  ok: boolean;
  /** ok=false 时的错误摘要（宿主据此匹配 detect 规则） */
  error?: string;
  windowTitle?: string;
}

export interface RecoveryAdvisor {
  /**
   * 每步执行后调用：先结算上一次命中规则的成败（成功/失败计数回写），
   * 再为本次失败匹配历史经验。返回命中（无匹配、非 hint、或该规则本任务已提示过则 null）。
   */
  afterExecution(exec: RecoveryExecution): RecoveryHit | null;
}

/**
 * 恢复顾问：把"去重 + 待记账规则"两处状态收在一处，loop 侧只留一次调用。
 * 只产出 hint——auto 动作替换缺现场校验（屏幕是否仍适用），不在此实现。
 */
export function createRecoveryAdvisor(deps: {
  matcher?: (ctx: RecoveryContext) => RecoveryHit | null;
  onResult?: (ruleId: string, success: boolean) => void;
}): RecoveryAdvisor {
  const nudged = new Set<string>();
  let pendingRuleId: string | null = null;
  return {
    afterExecution(exec: RecoveryExecution): RecoveryHit | null {
      if (pendingRuleId) {
        deps.onResult?.(pendingRuleId, exec.ok);
        pendingRuleId = null;
      }
      if (exec.ok) return null;
      const hit = deps.matcher?.({ stepIndex: exec.stepIndex, lastTool: exec.tool, lastResult: exec.error, lastOk: false, windowTitle: exec.windowTitle }) ?? null;
      if (hit?.mode !== 'hint') return null;
      if (hit.ruleId && nudged.has(hit.ruleId)) return null;
      if (hit.ruleId) { nudged.add(hit.ruleId); pendingRuleId = hit.ruleId; }
      return hit;
    },
  };
}

