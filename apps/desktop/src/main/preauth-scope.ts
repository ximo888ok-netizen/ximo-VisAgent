/**
 * preauth-scope.ts — 预授权作用域匹配纯函数（A-M6，规划 §2.2/§3.3）
 *
 * 不 import electron/sqlite：判定全部可单测。铁律（§6 最高风险行）：
 * - sensitiveExcludes 命中即 miss，优先于一切放行条件，不可被 dirs/opClasses 覆盖；
 * - 生效三条件 acked ∧ status='active' ∧ now < expires_at，缺一不生效；
 * - 一切歧义（未映射工具、file_write 无路径、空作用域）按 miss 回落实时审批——
 *   超范围必挂起，永不静默执行。
 */
import type { GrantOpClass, ScopePackage } from '../shared/schemas/longtask';

export type GrantStatus = 'active' | 'revoked' | 'expired';

/** 策略层消费的最小授权形态（仓储行解析后的应用层形状） */
export interface ActiveGrant {
  id: string;
  acked: boolean;
  status: GrantStatus;
  expiresAt: number;
  scope: ScopePackage;
}

export interface GrantMatchContext {
  opClass: GrantOpClass;
  /** 写入/导出目标路径（file_write/export 必填才可能命中） */
  targetPath?: string;
  /** 目标窗口/控件文本（敏感排除的比对面之一） */
  windowText?: string;
}

/**
 * 工具名 → L2 操作类别。刻意不映射 send_message/approve_payment/close_window/
 * open_app/custom_*（脚本即任意代码）等：不在枚举内即永不被 grant 覆盖。
 */
const TOOL_OP_CLASS: Readonly<Record<string, GrantOpClass>> = {
  keyboard_type: 'type_text',
  mouse_click: 'click',
  mouse_drag: 'click',
  activate_window: 'click',
  keyboard_press: 'hotkey',
  mouse_scroll: 'scroll',
  screen_capture: 'read_only',
  get_ui_tree: 'read_only',
  ocr_region: 'read_only',
  get_clipboard: 'read_only',
  file_read: 'read_only',
  file_list: 'read_only',
  wait: 'read_only',
  file_write: 'file_write',
  export_file: 'export',
};

export function opClassForTool(tool: string): GrantOpClass | null {
  return TOOL_OP_CLASS[tool] ?? null;
}

/** Windows 路径归一：正斜杠 + 小写（大小写不敏感文件系统）；去尾部斜杠 */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** glob 前缀语义：'C:/发票/**' → 'C:/发票'；目录本体或其子路径算命中（非字符串裸前缀） */
function dirMatches(dirs: string[], targetPath: string): boolean {
  const target = normalizePath(targetPath);
  return dirs.some((entry) => {
    const dir = normalizePath(entry).replace(/\*\*?$/, '').replace(/\/+$/, '');
    if (!dir) return false;
    return target === dir || target.startsWith(`${dir}/`);
  });
}

function hitsSensitive(excludes: string[], text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return excludes.some((kw) => kw.trim() !== '' && lower.includes(kw.trim().toLowerCase()));
}

/** 作用域命中判定（不含生效三条件，那是 isGrantActive 的职责） */
export function matchGrant(scope: ScopePackage, ctx: GrantMatchContext): 'hit' | 'miss' {
  // 敏感排除先行：命中即 miss，不可被作用域覆盖（§2.2 铁律）
  if (hitsSensitive(scope.sensitiveExcludes, ctx.windowText)) return 'miss';
  if (ctx.targetPath && hitsSensitive(scope.sensitiveExcludes, ctx.targetPath)) return 'miss';
  if (!scope.opClasses.includes(ctx.opClass)) return 'miss';
  if (ctx.opClass === 'file_write' || ctx.opClass === 'export') {
    if (!ctx.targetPath) return 'miss'; // 无路径不可核对 → fail-closed
    return dirMatches(scope.dirs, ctx.targetPath) ? 'hit' : 'miss';
  }
  return 'hit';
}

/** 生效三条件：acked=1 ∧ status='active' ∧ now < expires_at（§2.2） */
export function isGrantActive(grant: ActiveGrant, now = Date.now()): boolean {
  return grant.acked && grant.status === 'active' && now < grant.expiresAt;
}

export interface PreauthLookup {
  tool: string;
  /** 缺省按 L2（本函数唯一调用方是 L2 预授权判定；L3 由调用方先行挡下） */
  level?: number;
  targetPath?: string;
  windowText?: string;
  now?: number;
}

/** 五道刹车全过后仍然失败时的兜底 null；找到使本次操作生效放行的 grant */
export function findPreauthHit(grants: ActiveGrant[], lookup: PreauthLookup): ActiveGrant | null {
  if ((lookup.level ?? 2) !== 2 || !grants.length) return null;
  const opClass = opClassForTool(lookup.tool);
  if (!opClass) return null;
  const now = lookup.now ?? Date.now();
  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue;
    if (matchGrant(grant.scope, { opClass, targetPath: lookup.targetPath, windowText: lookup.windowText }) === 'hit') {
      return grant;
    }
  }
  return null;
}
