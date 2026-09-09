/**
 * win-effects.ts — 少量 Win32 窗口能力（koffi FFI，主进程侧）
 *
 * 存在的理由只有一个：让「Agent 在场」的边框窗口对屏幕采集不可见，
 * 否则它会出现在 Agent 自己每一步的截图里 —— 既白烧 token，
 * 又会让「画面没变就不重发截图」的优化永久失效（呼吸动画每帧都在变）。
 *
 * WDA_EXCLUDEFROMCAPTURE（Win10 2004+）正是为此而生：
 * 物理显示器上照常可见，采集 API 拿到的是没有它的画面。
 */
import fs from 'node:fs';
import path from 'node:path';

const WDA_NONE = 0x00000000;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

type AffinityFn = (hwnd: Buffer | null, affinity: number) => number;

let cached: AffinityFn | null | undefined;

/** 解析 user32.dll：System32 优先，回落到裸名由系统搜索路径决定 */
function resolveUser32(): string {
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const candidate = path.join(windir, 'System32', 'user32.dll');
  return fs.existsSync(candidate) ? candidate : 'user32.dll';
}

/** 拿 SetWindowDisplayAffinity；不可用（非 Windows / 老系统 / koffi 缺失）时返回 null 并由调用方降级 */
function loadAffinityFn(): AffinityFn | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') {
    cached = null;
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
    const koffi = require('koffi') as {
      proto: (name: string, ret: string, args: [string, string]) => unknown;
      load: (file: string) => Record<string, unknown>;
    };
    // 可选原生能力：非 Windows、缺 koffi 或老系统时必须让应用照常可用
    const user32 = koffi.load(resolveUser32());
    const fn = user32.SetWindowDisplayAffinity as AffinityFn | undefined;
    cached = typeof fn === 'function' ? fn : null;
  } catch (err) {
    console.warn('[aura] SetWindowDisplayAffinity 不可用，边框将出现在截屏里（仅影响 token 与画面变化判定）', err);
    cached = null;
  }
  return cached;
}

/**
 * 把窗口从屏幕采集中排除。
 * @returns 是否成功；false 时调用方应意识到边框会进截图。
 */
export function excludeWindowFromCapture(hwnd: Buffer | null, exclude = true): boolean {
  const fn = loadAffinityFn();
  if (!fn || !hwnd) return false;
  try {
    return fn(hwnd, exclude ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE) === 1;
  } catch (err) {
    console.warn('[aura] 设置采集排除失败', err);
    return false;
  }
}

/** 当前系统是否支持采集排除（用于在 UI 上如实说明能力） */
export function supportsCaptureExclusion(): boolean {
  return loadAffinityFn() !== null;
}
