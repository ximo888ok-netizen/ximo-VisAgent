// open_app 启动：搜索常见目录 + 直接执行，安全由审批系统兜底
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { listWindows, type WindowInfo } from '@ximo-visagent/control-kit';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 搜索目录：覆盖大多数 Windows 应用安装位置 */
const SEARCH_DIRS = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs'),
  path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files'),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'),
  path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.USERPROFILE ?? '', 'Desktop'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Desktop'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Apps'),
  'D:\\ximo',
  'C:\\ximo',
];

/** shell 元字符拦截（防注入）；冒号允许通过以支持 URI 协议（ms-settings:、control:） */
const SHELL_META = /["'&|<>^`$();%?\r\n]/;

/** Chromium 系应用 exe 名（不含扩展名，小写）。
 *  这些应用默认关闭 renderer accessibility，UIA 树为空壳 → Agent 只能靠视觉定位（不准）。
 *  启动时附加 --force-renderer-accessibility=complete 强制暴露完整无障碍树（UiPath 同款方案），
 *  ui_locate/ui_click 即可像素级命中。对非 Chromium 进程无此参数概念，不加。 */
const CHROMIUM_APPS = new Set([
  'chrome', 'msedge', 'brave', 'opera', 'vivaldi', 'code', 'cursor', 'trae',
  'wechat', 'weixin', 'qq', 'wxwork', 'dingtalk', 'feishu', 'lark', 'obsidian',
  'notion', 'discord', 'slack', 'teams', 'spotify',
]);

/** Chromium 启动参数：强制开启 renderer accessibility（完整无障碍树） */
const FORCE_A11Y_ARGS = ['--force-renderer-accessibility=complete'];

function chromiumArgsFor(exePath: string): string[] {
  const base = path.basename(exePath).toLowerCase().replace(/\.exe$/, '');
  return CHROMIUM_APPS.has(base) ? FORCE_A11Y_ARGS : [];
}

export class UnsafeAppError extends Error {
  constructor(reason: string) {
    super(`open_app 拒绝: ${reason}`);
    this.name = 'UnsafeAppError';
  }
}

/** Windows 内置 URI 协议白名单：通过 start 命令打开，不走文件搜索 */
const URI_PROTOCOLS = /^(ms-settings:|control:|ms-windows-store:|ms-calculator:|ms-paint:)/i;

/** 常见系统应用的别名映射：模型给出别名时自动转换 */
const APP_ALIASES: Record<string, string> = {
  '控制面板': 'control.exe',
  'control panel': 'control.exe',
  '设置': 'ms-settings:',
  'settings': 'ms-settings:',
  '应用和功能': 'ms-settings:appsfeatures',
  'appsfeatures': 'ms-settings:appsfeatures',
  '程序和功能': 'ms-settings:appsfeatures',
  'programs and features': 'ms-settings:appsfeatures',
  '卸载程序': 'ms-settings:appsfeatures',
  'uninstall': 'ms-settings:appsfeatures',
  '设备管理器': 'devmgmt.msc',
  'device manager': 'devmgmt.msc',
  '任务管理器': 'taskmgr.exe',
  'task manager': 'taskmgr.exe',
  '注册表编辑器': 'regedit.exe',
  'registry editor': 'regedit.exe',
  '服务': 'services.msc',
  'services': 'services.msc',
  '事件查看器': 'eventvwr.msc',
  'event viewer': 'eventvwr.msc',
};

/**
 * 启动应用。安全策略：
 * 1. 拦截 shell 元字符（防注入）
 * 2. URI 协议（ms-settings: 等）→ 通过 start 命令打开
 * 3. 绝对路径 → 直接执行（必须是 .exe）
 * 4. 应用别名 → 映射到实际命令
 * 5. 应用名 → 搜索常见目录找 .exe / .lnk，找到就启动
 * 6. 都找不到 → 尝试直接当命令执行（让 PATH 解析）
 */
export async function openAppSafe(nameOrPath: string): Promise<void> {
  const input = nameOrPath.trim();
  if (!input) throw new UnsafeAppError('空名称');
  if (SHELL_META.test(input)) throw new UnsafeAppError('名称包含非法字符');

  // 别名映射：模型给出「控制面板」等中文名时自动转换
  const aliased = APP_ALIASES[input.toLowerCase()] ?? input;

  // URI 协议（ms-settings:、control: 等）→ 通过 start 命令打开
  if (URI_PROTOCOLS.test(aliased)) {
    await execFileAsync('cmd.exe', ['/c', 'start', '', aliased], { shell: false, windowsHide: false }).catch(() => {
      throw new UnsafeAppError(`无法打开「${input}」（URI: ${aliased}）`);
    });
    return;
  }

  // 绝对路径 → 直接执行
  if (path.isAbsolute(aliased)) {
    const normalized = path.normalize(aliased);
    if (!existsSync(normalized)) throw new UnsafeAppError('文件不存在');
    await execFileAsync(normalized, chromiumArgsFor(normalized), { shell: false, windowsHide: false }).catch(() => undefined);
    return;
  }

  const lower = aliased.toLowerCase();
  const bare = lower.replace(/\.exe$/, '');

  // 搜索 .exe 和 .lnk
  const searchExe = bare + '.exe';
  const searchLnk = bare + '.lnk';
  for (const dir of SEARCH_DIRS) {
    if (!dir) continue;
    const found = await findFile(dir, searchExe, 3);
    if (found) {
      await execFileAsync(found, chromiumArgsFor(found), { shell: false, windowsHide: false }).catch(() => undefined);
      return;
    }
    // .lnk 经 explorer 启动无法附加参数；Chromium 系目标依赖 sidecar 的
    // SPI_SETSCREENREADER 宣告让其在运行中开启无障碍树
    const lnk = await findFile(dir, searchLnk, 3);
    if (lnk) {
      await execFileAsync('explorer.exe', [lnk], { shell: false, windowsHide: false }).catch(() => undefined);
      return;
    }
  }

  // 兜底：直接当命令执行，让 Windows PATH 解析
  await execFileAsync(aliased, [], { shell: false, windowsHide: false }).catch(() => {
    throw new UnsafeAppError(
      `「${input.slice(0, 60)}」未找到。替代方案：1) 用 keyboard_press 打开开始菜单（Win 键）后输入名称搜索；2) 桌面图标用 ui_locate 定位后双击；3) 如果是系统设置，试试 open_app("ms-settings:appsfeatures")`,
    );
  });
}

/** 启动后等待目标窗口出现：新增可见窗口，或标题命中应用名。
 *  启动是异步的，不等窗口就返回会让模型对着尚未渲染的界面点击（"点了没反应"的主因之一）。
 *  超时返回 null，由调用方如实回报当前前台窗口。 */
export async function waitForAppWindow(before: number[], nameHint: string, timeoutMs = 4000): Promise<WindowInfo | null> {
  const hint = path.basename(nameHint.trim()).replace(/\.(exe|lnk)$/i, '').toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const all = await listWindows().catch(() => []);
    const hit = all.find((w) =>
      w.visible && w.title && (!before.includes(w.hwnd) || (hint.length > 0 && w.title.toLowerCase().includes(hint))));
    if (hit) return hit;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 在 dir 下递归搜索同名文件（最多 maxDepth 层） */
async function findFile(dir: string, fileName: string, maxDepth: number): Promise<string | null> {
  if (maxDepth < 0 || !existsSync(dir)) return null;
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return full;
      }
      if (entry.isDirectory() && maxDepth > 0) {
        const found = await findFile(full, fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* 权限不足或不存在，跳过 */ }
  return null;
}
