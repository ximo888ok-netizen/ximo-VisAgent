/**
 * approval-policy.ts — 审批档位（manual / auto / autonomous）的放行判定
 *
 * 这是「谁有权不问人就动手」的唯一判定点。档位只是用户的意愿，能否真放行
 * 还要过五道刹车（docs/engineering.md S11）：
 *   B1 无人值守来源（定时/基准/进化/E2E）不继承用户给自己开的权限；
 *   B2 E2E/selftest 进程强制 manual（在 orchestrator 回调处判，因为要读 process.argv）；
 *   B3 岛窗口不在场就没有任何可见性，自动放行等于静默执行；
 *   B4 每任务配额是人退出环路后唯一的跑飞刹车；
 *   B5 档位/等级来自不受信来源（preload 不校验、配置可被手改），非法值一律 fail-closed。
 */
import type { ApprovalMode } from '@ximo-visagent/shared-types';

export const APPROVAL_MODES = ['manual', 'auto', 'autonomous'] as const;

/** 每任务自动放行上限（B4）。L3 含不可逆类别（PowerShell/银行/设置），上限必须远小于 L2 */
export const AUTO_APPROVAL_QUOTA = { l2: 20, l3: 3 } as const;

export interface ApprovalPolicyInput {
  mode: unknown;
  /** SafetyClassifier 的输出（0-3）；loop 只会在 >=2 时进来，这里仍不信任它 */
  level: unknown;
  tool: string;
  /** 任务是否由用户在岛上交互发起（B1）。非交互来源即使配置了档位也必须问人 */
  interactive: boolean;
  /** 岛窗口是否在场（B3） */
  islandVisible: boolean;
  /** 本任务已自动放行的 L2 / L3 次数（B4） */
  usedL2: number;
  usedL3: number;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * 放行真值表：
 *   manual      → 全部 ask
 *   auto        → L2 auto；custom_*（合成工具，实为跑脚本）与 L3 ask
 *   autonomous  → L2 / custom_* / L3 全 auto，L3 受配额约束
 */
export function resolveApprovalDecision(input: ApprovalPolicyInput): 'ask' | 'auto' {
  if (!isApprovalMode(input.mode) || input.mode === 'manual') return 'ask';
  if (!input.interactive) return 'ask';
  if (!input.islandVisible) return 'ask';
  if (input.level !== 2 && input.level !== 3) return 'ask';
  const autonomous = input.mode === 'autonomous';
  if (input.level === 3) {
    if (!autonomous) return 'ask';
    return input.usedL3 < AUTO_APPROVAL_QUOTA.l3 ? 'auto' : 'ask';
  }
  if (input.tool.startsWith('custom_') && !autonomous) return 'ask';
  return input.usedL2 < AUTO_APPROVAL_QUOTA.l2 ? 'auto' : 'ask';
}

/** 校验并返回合法档位；非法值抛错（不静默回落），错误信息必须可行动 */
export function parseApprovalMode(value: unknown): ApprovalMode {
  if (!isApprovalMode(value)) {
    throw new Error(`未知的审批档位「${String(value)}」，可选：${APPROVAL_MODES.join(' / ')}`);
  }
  return value;
}

/**
 * 档位变更门：切进 autonomous 必须带显式 ack（渲染层的确认仪式只是引导，
 * 这里才是可信校验点，engineering.md I7）。降档 / 切 auto / 同档重复提交不需要。
 * 必须 throw：updateConfig 的 handler 靠 catch 把异常转成 {ok:false, error}。
 */
export function assertModeChangeAllowed(current: ApprovalMode, next: ApprovalMode, ack: unknown): void {
  if (next === current || next !== 'autonomous') return;
  if (ack !== true) {
    throw new Error(
      '切换到「完全自主」需要显式确认风险：该档位会自动放行 PowerShell/命令行、银行域名页面与系统设置面板的操作，不再逐次询问',
    );
  }
}
