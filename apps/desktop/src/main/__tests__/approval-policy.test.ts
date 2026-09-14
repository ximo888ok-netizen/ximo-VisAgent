/**
 * approval-policy.test.ts — 审批档位放行判定的门禁
 *
 * 关键是「天花板锁」：任何把 DEFAULT_TOOL_POLICY / DEFAULT_SAFETY_RULES
 * 等级下调的改动都必须在这里变红，而不是在真机上被发现。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveApprovalDecision,
  assertModeChangeAllowed,
  parseApprovalMode,
  isApprovalMode,
  AUTO_APPROVAL_QUOTA,
} from '../approval-policy';
import type { ActiveGrant } from '../preauth-scope';
import { DEFAULT_TOOL_POLICY, DEFAULT_SAFETY_RULES } from '@ximo-visagent/safety';
import type { ScopePackage } from '../../shared/schemas/longtask';

const base = {
  mode: 'auto',
  level: 2,
  tool: 'file_write',
  interactive: true,
  islandVisible: true,
  usedL2: 0,
  usedL3: 0,
};

describe('放行真值表（档位 × 操作类别）', () => {
  it('manual 档：L2 / custom_* / L3 全部询问', () => {
    for (const input of [
      { ...base, mode: 'manual', tool: 'file_write' },
      { ...base, mode: 'manual', tool: 'custom_clean' },
      { ...base, mode: 'manual', level: 3 },
    ]) {
      expect(resolveApprovalDecision(input)).toBe('ask');
    }
  });

  it('auto 档：L2 放行，custom_* 与 L3 询问', () => {
    expect(resolveApprovalDecision({ ...base, tool: 'file_write' })).toBe('auto');
    expect(resolveApprovalDecision({ ...base, tool: 'custom_clean' })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, level: 3, tool: 'keyboard_press' })).toBe('ask');
  });

  it('autonomous 档：L2 / custom_* / L3 全放行', () => {
    for (const input of [
      { ...base, mode: 'autonomous' },
      { ...base, mode: 'autonomous', tool: 'custom_clean' },
      { ...base, mode: 'autonomous', level: 3, tool: 'keyboard_press' },
    ]) {
      expect(resolveApprovalDecision(input)).toBe('auto');
    }
  });
});

describe('五道刹车', () => {
  it('B1 非交互来源（定时/基准/进化/E2E）不得继承档位', () => {
    expect(resolveApprovalDecision({ ...base, mode: 'autonomous', level: 3, interactive: false })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, interactive: false })).toBe('ask');
  });

  it('B3 岛窗口不在场 → 无可见性，一律询问', () => {
    expect(resolveApprovalDecision({ ...base, islandVisible: false })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, mode: 'autonomous', level: 3, islandVisible: false })).toBe('ask');
  });

  it('B4 每任务配额：L2 超过 20 次、L3 超过 3 次回落询问', () => {
    expect(resolveApprovalDecision({ ...base, usedL2: AUTO_APPROVAL_QUOTA.l2 })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, usedL2: AUTO_APPROVAL_QUOTA.l2 - 1 })).toBe('auto');
    expect(
      resolveApprovalDecision({ ...base, mode: 'autonomous', level: 3, usedL3: AUTO_APPROVAL_QUOTA.l3 }),
    ).toBe('ask');
    expect(
      resolveApprovalDecision({ ...base, mode: 'autonomous', level: 3, usedL3: AUTO_APPROVAL_QUOTA.l3 - 1 }),
    ).toBe('auto');
  });

  it('B5 非法档位 / 非法等级 fail-closed 到询问', () => {
    expect(resolveApprovalDecision({ ...base, mode: 'weird' })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, mode: undefined })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, level: 9 })).toBe('ask');
    expect(resolveApprovalDecision({ ...base, level: '2' })).toBe('ask');
    expect(isApprovalMode('autonomous')).toBe(true);
    expect(isApprovalMode('AUTO')).toBe(false);
  });
});

describe('档位变更门（I7：主进程是唯一可信校验点）', () => {
  it('manual → autonomous 无 ack 抛错，错误信息必须具体可行动', () => {
    expect(() => assertModeChangeAllowed('manual', 'autonomous', undefined)).toThrow(/PowerShell/);
    expect(() => assertModeChangeAllowed('manual', 'autonomous', false)).toThrow();
  });

  it('带 ack 放行；autonomous→autonomous 与降档不需要 ack', () => {
    expect(() => assertModeChangeAllowed('manual', 'autonomous', true)).not.toThrow();
    expect(() => assertModeChangeAllowed('autonomous', 'autonomous', undefined)).not.toThrow();
    expect(() => assertModeChangeAllowed('autonomous', 'manual', undefined)).not.toThrow();
    expect(() => assertModeChangeAllowed('manual', 'auto', undefined)).not.toThrow();
  });

  it('非法目标档位抛错（不静默回落）', () => {
    expect(() => parseApprovalMode('yolo')).toThrow(/未知的审批档位/);
    expect(() => parseApprovalMode(undefined)).toThrow();
    expect(parseApprovalMode('auto')).toBe('auto');
  });
});

describe('天花板锁：安全分级快照（下调即红）', () => {
  it('关键工具分级不得低于基线', () => {
    const levelOf = (tool: string): number => {
      const policy = DEFAULT_TOOL_POLICY[tool];
      if (!policy) throw new Error(`内置策略缺少 ${tool}`);
      return policy.level;
    };
    for (const tool of ['ocr_region', 'get_clipboard', 'file_read', 'file_list']) {
      expect(levelOf(tool), `${tool} 应保持 L0`).toBe(0);
    }
    for (const tool of [
      'mouse_click',
      'mouse_drag',
      'mouse_scroll',
      'keyboard_type',
      'keyboard_press',
      'open_app',
      'activate_window',
      'set_clipboard',
      'wait',
    ]) {
      expect(levelOf(tool), `${tool} 应保持 L1`).toBe(1);
    }
    for (const tool of ['file_write', 'submit_form', 'send_message', 'approve_payment', 'close_window']) {
      expect(levelOf(tool), `${tool} 应保持 L2`).toBe(2);
    }
  });

  it('不可逆类别黑名单（cmd/设置/银行）保持 L3 且启用', () => {
    const byId = new Map(DEFAULT_SAFETY_RULES.map((r) => [r.id, r]));
    for (const id of ['block-cmd', 'block-settings', 'block-banking']) {
      const rule = byId.get(id);
      expect(rule, `缺少内置规则 ${id}`).toBeDefined();
      expect(rule?.levelOverride).toBe(3);
      expect(rule?.enabled).toBe(true);
    }
  });
});

/* ===========================================================================
 * A-M6 预授权 grant（规划 §3.3 真值表新增行，先跑红后改码）
 *
 * 铁律：grant 只是将「用户已逐项确认过的作用域包」代入既有判定；
 * 五道刹车任何一条不被触碰——三生效条件缺一、超范围、敏感排除、
 * manual/L3/非法档位，全部回落 ask（= 超范围必挂起，永不静默执行）。
 * ========================================================================= */

const NOW = 1_700_000_000_000;

function grantScope(over: Partial<ScopePackage> = {}): ScopePackage {
  return {
    appId: 'app-target',
    dirs: ['C:/发票/**'],
    opClasses: ['type_text', 'click', 'scroll', 'read_only', 'file_write'],
    sensitiveExcludes: ['删除', 'uninstall'],
    budget: { maxDurationMs: 3_600_000, maxSteps: 600, maxTokens: 8_000_000 },
    ...over,
  };
}

function activeGrant(over: Partial<ActiveGrant> = {}): ActiveGrant {
  return { id: 'g_0123456789ab', acked: true, status: 'active', expiresAt: NOW + 86_400_000, scope: grantScope(), ...over };
}

/** 命中 grant 的最小输入：file_write 在授权目录内 */
const hitInput = { ...base, tool: 'file_write', grantCtx: { targetPath: 'C:/发票/1.pdf', now: NOW } };
const missOut = { ...base, tool: 'file_write', grantCtx: { targetPath: 'D:/其他/1.pdf', now: NOW } };

describe('预授权 B1 行：非交互来源 + 有效 grant 命中', () => {
  it('B1 非交互 ∧ grant 命中 → auto（预授权直通，仍经审计 decidedBy:preauth）', () => {
    expect(resolveApprovalDecision({ ...hitInput, interactive: false }, [activeGrant()])).toBe('auto');
  });

  it('B1 非交互 ∧ 无 grant / grant 未命中 → ask（现状零削弱）', () => {
    expect(resolveApprovalDecision({ ...hitInput, interactive: false })).toBe('ask');
    expect(resolveApprovalDecision({ ...hitInput, interactive: false }, [])).toBe('ask');
    expect(resolveApprovalDecision({ ...missOut, interactive: false }, [activeGrant()])).toBe('ask');
  });
});

describe('预授权 B3 行（同构修正）：岛不在场 + 有效 grant 命中', () => {
  it('B3 岛不在场 ∧ grant 命中 → auto', () => {
    expect(resolveApprovalDecision({ ...hitInput, islandVisible: false }, [activeGrant()])).toBe('auto');
  });

  it('B3 岛不在场 ∧ grant 未命中 → ask', () => {
    expect(resolveApprovalDecision({ ...missOut, islandVisible: false }, [activeGrant()])).toBe('ask');
  });
});

describe('grant 三生效条件：acked ∧ active ∧ 未过期，缺一回落 ask', () => {
  it('未 ack / 已撤销 / 已过期 → ask（即便作用域完全命中）', () => {
    const unattended = { ...hitInput, interactive: false };
    expect(resolveApprovalDecision(unattended, [activeGrant({ acked: false })])).toBe('ask');
    expect(resolveApprovalDecision(unattended, [activeGrant({ status: 'revoked' })])).toBe('ask');
    expect(resolveApprovalDecision(unattended, [activeGrant({ status: 'expired' })])).toBe('ask');
    expect(resolveApprovalDecision(unattended, [activeGrant({ expiresAt: NOW - 1 })])).toBe('ask');
    expect(resolveApprovalDecision(unattended, [activeGrant({ expiresAt: NOW })])).toBe('ask');
  });

  it('条件齐备 → auto', () => {
    expect(resolveApprovalDecision(hitInput, [activeGrant()])).toBe('auto');
    expect(resolveApprovalDecision({ ...hitInput, interactive: false }, [activeGrant()])).toBe('auto');
  });
});

describe('sensitiveExcludes：强制 ask，不可被作用域覆盖', () => {
  it('目录在白名单内但路径/窗口文本命中敏感词 → ask（无人值守下也不放行）', () => {
    expect(
      resolveApprovalDecision(
        { ...base, interactive: false, grantCtx: { targetPath: 'C:/发票/删除.pdf', now: NOW } },
        [activeGrant()],
      ),
    ).toBe('ask');
    expect(
      resolveApprovalDecision(
        { ...base, tool: 'mouse_click', interactive: false, grantCtx: { windowText: 'Uninstall', now: NOW } },
        [activeGrant({ scope: grantScope({ opClasses: ['click'] }) })]),
    ).toBe('ask');
  });
});

describe('预授权边界负向用例：超范围必挂起（ask），永不静默执行', () => {
  it('manual 档不被 grant 覆盖（用户要求全部人审）', () => {
    expect(resolveApprovalDecision({ ...hitInput, mode: 'manual' }, [activeGrant()])).toBe('ask');
  });

  it('L3 永不可预授权（grant 只覆盖 L2 操作类别）', () => {
    expect(
      resolveApprovalDecision({ ...base, mode: 'autonomous', level: 3, interactive: false, grantCtx: { targetPath: 'C:/发票/1.pdf', now: NOW } }, [activeGrant()]),
    ).toBe('ask');
  });

  it('opClass 未勾选（hotkey）/ 未映射工具（custom_*）→ ask', () => {
    expect(
      resolveApprovalDecision({ ...base, tool: 'keyboard_press', interactive: false, grantCtx: { now: NOW } }, [activeGrant()]),
    ).toBe('ask');
    expect(resolveApprovalDecision({ ...base, tool: 'custom_clean' }, [activeGrant()])).toBe('ask');
  });

  it('file_write 无路径信息 → ask（fail-closed，不放行不可核对的写）', () => {
    expect(resolveApprovalDecision({ ...base, interactive: false, tool: 'file_write' }, [activeGrant()])).toBe('ask');
  });

  it('B5 非法档位/非法等级带 grant 仍 fail-closed', () => {
    expect(resolveApprovalDecision({ ...hitInput, mode: 'weird' }, [activeGrant()])).toBe('ask');
    expect(resolveApprovalDecision({ ...hitInput, level: 9 }, [activeGrant()])).toBe('ask');
  });

  it('grant 不消耗也不受 B4 配额约束（FR-007：preauth 放行不占 AUTO_APPROVAL_QUOTA）', () => {
    expect(resolveApprovalDecision({ ...hitInput, usedL2: AUTO_APPROVAL_QUOTA.l2 }, [activeGrant()])).toBe('auto');
    // 配额耗尽本身仍须约束既有 policy 自动路径（无 grant）
    expect(resolveApprovalDecision({ ...hitInput, usedL2: AUTO_APPROVAL_QUOTA.l2 })).toBe('ask');
  });
});
