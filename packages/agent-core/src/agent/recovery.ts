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

