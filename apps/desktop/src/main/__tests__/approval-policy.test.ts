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
import { DEFAULT_TOOL_POLICY, DEFAULT_SAFETY_RULES } from '@ximo-visagent/safety';

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
