// orchestrator-recovery.ts — 条目6：从经验库构建恢复匹配器（仅 hint 模式）
//
// 设计约束：
// - 只在 lastOk === false 时匹配（成功无恢复可言）
// - 只推荐 enabled && successCount >= failCount 的规则（不推荐历史上更常失败的）
// - detectJson/actionJson 解析失败即跳过该规则（宁可不用，不可乱用）
// - 规则声明了 argPattern 而宿主取不到该步参数 → 不命中（参数形态判据宁可漏不可错）
// - 命中通过 opts.onHit 交回宿主记账（hitCount + 审计），本文件自身不做任何 IO
// - mode:'auto' 不由本文件产生——动作替换缺"屏幕现场校验"，无人值守下风险过高，
//   resolveAutoRecovery 保留给后续带现场校验的版本
import type { RecoveryContext, RecoveryHit } from '@ximo-visagent/agent-core';
import type { ExperienceStore } from './experience-store';
import type { RecoveryRuleRow } from './stores/experience-types';
import { stableArgsJson, type RecoveryActionSpec, type RecoveryDetectSpec } from './experience/recovery-signature';

/** 宿主注入：失败那一步的实际参数（提炼侧的 argPattern 靠它还原参数形态） */
export interface RecoveryMatcherOptions {
  argsAt?: (stepIndex: number) => Record<string, unknown> | undefined;
  /** 规则命中记账（提炼侧用它把命中次数写进现有审计通道） */
  onHit?: (rule: RecoveryRuleRow, reason: string) => void;
}

/** 规则是否命中当前失败上下文（全部声明的条件都要满足） */
function matches(
  ctx: RecoveryContext,
  detect: RecoveryDetectSpec,
  argsAt: RecoveryMatcherOptions['argsAt'],
): boolean {
  if (detect.lastTool && detect.lastTool !== ctx.lastTool) return false;
  if (detect.windowTitlePattern) {
    if (!safeRegexTest(detect.windowTitlePattern, ctx.windowTitle ?? '')) return false;
  }
  if (detect.errorPattern) {
    if (!safeRegexTest(detect.errorPattern, ctx.lastResult ?? '')) return false;
  }
  if (detect.argPattern) {
    const args = argsAt?.(ctx.stepIndex);
    // 现场取不到参数形态就不命中：宁可漏提示，不可错提示
    if (!args || !safeRegexTest(detect.argPattern, stableArgsJson(args))) return false;
  }
  // 至少声明一个匹配条件，空规则不命中（防止误伤所有失败）
  return Boolean(detect.lastTool || detect.errorPattern || detect.windowTitlePattern);
}

/** 正则编译失败 → includes 兜底（规则来自历史数据，质量不可控） */
function safeRegexTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return text.includes(pattern);
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function createRecoveryMatcher(
  experience: ExperienceStore,
  opts: RecoveryMatcherOptions = {},
): (ctx: RecoveryContext) => RecoveryHit | null {
  return (ctx: RecoveryContext): RecoveryHit | null => {
    if (ctx.lastOk !== false) return null;
    let rules: RecoveryRuleRow[];
    try {
      rules = experience.listRecoveryRules();
    } catch {
      return null;
    }
    // 候选排序：净成功数降序，取第一个命中
    const candidates = rules
      .filter((r) => r.enabled && r.successCount >= r.failCount)
      .sort((a, b) => (b.successCount - b.failCount) - (a.successCount - a.failCount));
    for (const rule of candidates) {
      const detect = parseJson<RecoveryDetectSpec>(rule.detectJson);
      if (!detect || !matches(ctx, detect, opts.argsAt)) continue;
      const action = parseJson<RecoveryActionSpec>(rule.actionJson);
      if (!action?.action) continue;
      const reason = `历史经验「${rule.name}」：上次遇到类似失败时的处置是 ${action.action}${action.args ? `(${JSON.stringify(action.args).slice(0, 80)})` : ''} — ${rule.successCount} 成 ${rule.failCount} 败`;
      try {
        opts.onHit?.(rule, reason);
      } catch (err) {
        console.error('[recovery] 命中记账失败（不影响提示注入）', err instanceof Error ? err.message : err);
      }
      return { mode: 'hint', reason, ruleId: rule.id };
    }
    return null;
  };
}
