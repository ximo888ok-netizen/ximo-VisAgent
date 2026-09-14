/**
 * preauth-scope.test.ts — 预授权作用域匹配纯函数（A-M6，规划 §2.2/§3.3）
 *
 * 铁律用例集中在此：sensitiveExcludes 命中优先于一切放行（不可被作用域覆盖）；
 * 生效三条件（acked ∧ active ∧ 未过期）缺一即回落；一切歧义按 miss（fail-closed）。
 */
import { describe, it, expect } from 'vitest';
import {
  findPreauthHit,
  isGrantActive,
  matchGrant,
  opClassForTool,
  type ActiveGrant,
} from '../preauth-scope';
import type { ScopePackage } from '../../shared/schemas/longtask';

const NOW = 1_700_000_000_000;

function scope(over: Partial<ScopePackage> = {}): ScopePackage {
  return {
    appId: 'app-target',
    dirs: [],
    opClasses: ['type_text', 'click', 'scroll', 'read_only'],
    sensitiveExcludes: ['删除', 'uninstall'],
    budget: { maxDurationMs: 3_600_000, maxSteps: 600, maxTokens: 8_000_000 },
    ...over,
  };
}

function grant(over: Partial<ActiveGrant> = {}): ActiveGrant {
  return {
    id: 'g_0123456789ab',
    acked: true,
    status: 'active',
    expiresAt: NOW + 86_400_000,
    scope: scope(),
    ...over,
  };
}

describe('opClassForTool：工具名 → 操作类别（未映射永不命中）', () => {
  it('FR-012 默认勾选四类 + 文件写映射存在', () => {
    expect(opClassForTool('keyboard_type')).toBe('type_text');
    expect(opClassForTool('mouse_click')).toBe('click');
    expect(opClassForTool('mouse_scroll')).toBe('scroll');
    expect(opClassForTool('ocr_region')).toBe('read_only');
    expect(opClassForTool('file_write')).toBe('file_write');
  });

  it('脚本/消息/支付类工具不映射（预授权不覆盖，逐个回落 ask）', () => {
    for (const tool of ['custom_run_powershell', 'send_message', 'approve_payment', 'close_window', 'open_app']) {
      expect(opClassForTool(tool)).toBeNull();
    }
  });
});

describe('matchGrant：作用域命中判定', () => {
  it('UI 操作类别在 opClasses 内 → hit', () => {
    expect(matchGrant(scope(), { opClass: 'type_text' })).toBe('hit');
    expect(matchGrant(scope(), { opClass: 'click' })).toBe('hit');
  });

  it('opClasses 未含该类别 → miss（超范围必挂起）', () => {
    expect(matchGrant(scope(), { opClass: 'hotkey' })).toBe('miss');
    expect(matchGrant(scope({ opClasses: [] }), { opClass: 'type_text' })).toBe('miss');
  });

  it('sensitiveExcludes 命中 windowText/路径 → 强制 miss，且不可被 opClasses/dirs 覆盖', () => {
    // 「删除」按钮也在 type_text 允许范围内、路径也在白名单目录内，仍 miss
    expect(matchGrant(scope(), { opClass: 'type_text', windowText: '确认删除' })).toBe('miss');
    expect(matchGrant(scope({ dirs: ['C:/订单/**'], opClasses: ['file_write'] }), {
      opClass: 'file_write',
      targetPath: 'C:/订单/删除.xlsx',
    })).toBe('miss');
    // 关键词大小写不敏感
    expect(matchGrant(scope(), { opClass: 'click', windowText: 'Uninstall Wizard' })).toBe('miss');
  });

  it('file_write/export：路径必须在 dirs 前缀白名单内；无路径即 miss（fail-closed）', () => {
    const fs = scope({ dirs: ['C:/发票/**'], opClasses: ['file_write', 'export'] });
    expect(matchGrant(fs, { opClass: 'file_write', targetPath: 'C:/发票/1.pdf' })).toBe('hit');
    // Windows 反斜杠 + 大小写不敏感
    expect(matchGrant(fs, { opClass: 'file_write', targetPath: 'c:\\发票\\子\\2.pdf' })).toBe('hit');
    expect(matchGrant(fs, { opClass: 'file_write', targetPath: 'C:/Windows/system.ini' })).toBe('miss');
    expect(matchGrant(fs, { opClass: 'file_write' })).toBe('miss');
    expect(matchGrant(scope({ dirs: [], opClasses: ['file_write'] }), {
      opClass: 'file_write',
      targetPath: 'C:/anywhere.txt',
    })).toBe('miss');
  });

  it('dirs 前缀边界：/C:/发票 不得被 /C:/发票存根 误命中', () => {
    const fs = scope({ dirs: ['C:/发票'], opClasses: ['file_write'] });
    expect(matchGrant(fs, { opClass: 'file_write', targetPath: 'C:/发票存根/a.txt' })).toBe('miss');
    expect(matchGrant(fs, { opClass: 'file_write', targetPath: 'C:/发票/a.txt' })).toBe('hit');
  });
});

describe('isGrantActive：三生效条件（acked ∧ active ∧ 未过期）', () => {
  it('三者齐备才生效；缺一即不生效', () => {
    expect(isGrantActive(grant(), NOW)).toBe(true);
    expect(isGrantActive(grant({ acked: false }), NOW)).toBe(false);
    expect(isGrantActive(grant({ status: 'revoked' }), NOW)).toBe(false);
    expect(isGrantActive(grant({ status: 'expired' }), NOW)).toBe(false);
    expect(isGrantActive(grant({ expiresAt: NOW }), NOW)).toBe(false); // now < expires_at 严格小于
    expect(isGrantActive(grant({ expiresAt: NOW - 1 }), NOW)).toBe(false);
  });
});

describe('findPreauthHit：仓储列表 + 操作上下文 → 放行 grant（或 null）', () => {
  it('命中返回该 grant；未过期未 acked 等一律 null', () => {
    const g = grant();
    expect(findPreauthHit([g], { tool: 'keyboard_type', now: NOW })).toEqual(g);
    expect(findPreauthHit([grant({ acked: false })], { tool: 'keyboard_type', now: NOW })).toBeNull();
    expect(findPreauthHit([grant({ status: 'revoked' })], { tool: 'keyboard_type', now: NOW })).toBeNull();
  });

  it('超范围动作（hotkey 未勾选 / 敏感词 / 脚本工具）→ null，回落既有实时审批', () => {
    const g = grant();
    expect(findPreauthHit([g], { tool: 'keyboard_press', now: NOW })).toBeNull(); // hotkey 不在 opClasses
    expect(findPreauthHit([g], { tool: 'mouse_click', windowText: '删除', now: NOW })).toBeNull();
    expect(findPreauthHit([g], { tool: 'custom_clean', now: NOW })).toBeNull();
    expect(findPreauthHit([], { tool: 'keyboard_type', now: NOW })).toBeNull();
  });
});
