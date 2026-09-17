// koffi FFI 绑定：user32.dll 窗口枚举/激活/关闭 + 系统 DPI（从 win32.ts 拆出）
import koffi from 'koffi';
import { Worker } from 'node:worker_threads';
import type { MonitorInfo, Rect, WindowInfo } from '@ximo-visagent/shared-types';

const lib = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// EnumProc 签名必须先于引用它的 lib.func 注册（否则运行期报 Unknown or invalid type name）
koffi.proto('bool EnumProc(int64 hwnd, int64 lParam)');
const EnumWindows = lib.func('bool EnumWindows(EnumProc *cb, int64 lParam)');
const GetWindowTextW = lib.func('int32 GetWindowTextW(int64 hwnd, _Out_ char* lpString, int32 nMaxCount)');
const GetClassNameW = lib.func('int32 GetClassNameW(int64 hwnd, _Out_ char* lpClassName, int32 nMaxCount)');
const IsWindowVisible = lib.func('bool IsWindowVisible(int64 hwnd)');
// 廉价标志查询（不发消息、不阻塞）：枚举时先跳过无响应窗口，避免 GetWindowText 的 WM_GETTEXT 卡住主线程
const IsHungAppWindow = lib.func('bool IsHungAppWindow(int64 hwnd)');
const GetWindowRect = lib.func('bool GetWindowRect(int64 hwnd, void* lpRect)');
const GetWindowThreadProcessId = lib.func('uint32 GetWindowThreadProcessId(int64 hwnd, _Out_ uint32* pid)');
const SetForegroundWindow = lib.func('bool SetForegroundWindow(int64 hwnd)');
const PostMessageW = lib.func('bool PostMessageW(int64 hwnd, uint32 msg, uint64 wParam, int64 lParam)');
const GetForegroundWindow = lib.func('int64 GetForegroundWindow()');
// 前台锁兜底所需：允许抢前台 / 线程输入队列挂接 / 置顶 / 还原最小化
const AllowSetForegroundWindow = lib.func('bool AllowSetForegroundWindow(int32 dwProcessId)');
const AttachThreadInput = lib.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
const BringWindowToTop = lib.func('bool BringWindowToTop(int64 hwnd)');
const ShowWindow = lib.func('bool ShowWindow(int64 hwnd, int32 nCmdShow)');
const IsIconic = lib.func('bool IsIconic(int64 hwnd)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const GetAncestor = lib.func('int64 GetAncestor(int64 hwnd, uint32 gaFlags)');
// 注册 POINT 结构类型（WindowFromPoint 按值传参需先注册；返回值本身无需持有）
koffi.struct('POINT', { x: 'int32', y: 'int32' });
const WindowFromPoint = lib.func('int64 WindowFromPoint(POINT pt)');

const WM_CLOSE = 0x0010;
/** ASFW_ANY：允许任意进程抢前台 */
const ASFW_ANY = -1;
const SW_RESTORE = 9;
const GA_ROOT = 2;

function readWindowTitle(hwnd: number): string {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 255);
  if (n > 0) {
    const s = buf.toString('utf16le', 0, n * 2);
    return s.replace(/\0+$/, '');
  }
  return '';
}

function readClassName(hwnd: number): string {
  const buf = Buffer.alloc(256);
  const n = GetClassNameW(hwnd, buf, 255);
  if (n > 0) return buf.toString('utf16le', 0, n * 2).replace(/\0+$/, '');
  return '';
}

function readWindowRect(hwnd: number): Rect | null {
  const b = new ArrayBuffer(16);
  const v = new DataView(b);
  if (!GetWindowRect(hwnd, b)) return null;
  return {
    left: v.getInt32(0, true),
    top: v.getInt32(4, true),
    width: v.getInt32(8, true) - v.getInt32(0, true),
    height: v.getInt32(12, true) - v.getInt32(4, true),
  };
}

/** 进程内同步枚举（worker 不可用/超时时的兜底；已含 IsHungAppWindow 跳过僵尸窗）。 */
function listWindowsSync(): WindowInfo[] {
  const windows: WindowInfo[] = [];
  EnumWindows((hwnd: number) => {
    // 跳过无响应窗口：GetWindowTextW 会向它发 WM_GETTEXT 并阻塞到消息超时，拖死主线程
    if (IsHungAppWindow(hwnd)) return true;
    const pidBuf = Buffer.alloc(4);
    const pid = GetWindowThreadProcessId(hwnd, pidBuf) ? pidBuf.readUInt32LE(0) : 0;
    const title = readWindowTitle(hwnd);
    const rect = readWindowRect(hwnd);
    if (!title && !rect) return true;
    windows.push({
      hwnd,
      title,
      className: readClassName(hwnd),
      rect: rect ?? { left: 0, top: 0, width: 0, height: 0 },
      visible: IsWindowVisible(hwnd),
      pid,
    });
    return true; // continue
  }, 0n);
  return windows;
}

/** worker 线程枚举脚本（eval 模式，自带 koffi 绑定，与主线程各一份 FFI 句柄）。
 *  把同步 EnumWindows 移出主线程：任一窗口无响应导致的原生调用阻塞只冻住 worker，不冻结主进程。 */
const LIST_WORKER_CODE = String.raw`
const { parentPort } = require('node:worker_threads');
const koffi = require('koffi');
const lib = koffi.load('user32.dll');
koffi.proto('bool EnumProc(int64 hwnd, int64 lParam)');
const EnumWindows = lib.func('bool EnumWindows(EnumProc *cb, int64 lParam)');
const GetWindowTextW = lib.func('int32 GetWindowTextW(int64 hwnd, _Out_ char* lpString, int32 nMaxCount)');
const GetClassNameW = lib.func('int32 GetClassNameW(int64 hwnd, _Out_ char* lpClassName, int32 nMaxCount)');
const IsWindowVisible = lib.func('bool IsWindowVisible(int64 hwnd)');
const IsHungAppWindow = lib.func('bool IsHungAppWindow(int64 hwnd)');
const GetWindowRect = lib.func('bool GetWindowRect(int64 hwnd, void* lpRect)');
const GetWindowThreadProcessId = lib.func('uint32 GetWindowThreadProcessId(int64 hwnd, _Out_ uint32* pid)');
function readTitle(hwnd){ const b = Buffer.alloc(512); const n = GetWindowTextW(hwnd, b, 255); return n > 0 ? b.toString('utf16le', 0, n * 2).replace(/\0+$/, '') : ''; }
function readCls(hwnd){ const b = Buffer.alloc(256); const n = GetClassNameW(hwnd, b, 255); return n > 0 ? b.toString('utf16le', 0, n * 2).replace(/\0+$/, '') : ''; }
function readRect(hwnd){ const b = new ArrayBuffer(16); const v = new DataView(b); if (!GetWindowRect(hwnd, b)) return null; return { left: v.getInt32(0,true), top: v.getInt32(4,true), width: v.getInt32(8,true)-v.getInt32(0,true), height: v.getInt32(12,true)-v.getInt32(4,true) }; }
parentPort.on('message', (msg) => {
  if (!msg || msg.id === undefined) return;
  const windows = [];
  try {
    EnumWindows((hwnd) => {
      if (IsHungAppWindow(hwnd)) return true;
      const pb = Buffer.alloc(4);
      const pid = GetWindowThreadProcessId(hwnd, pb) ? pb.readUInt32LE(0) : 0;
      const title = readTitle(hwnd);
      const rect = readRect(hwnd);
      if (!title && !rect) return true;
      windows.push({ hwnd, title, className: readCls(hwnd), rect: rect || { left: 0, top: 0, width: 0, height: 0 }, visible: IsWindowVisible(hwnd), pid });
      return true;
    }, 0n);
    parentPort.postMessage({ id: msg.id, windows });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) });
  }
});
`;

const LIST_TIMEOUT_MS = 3000;
let listWorker: Worker | null = null;
let listWorkerBroken = false;
let lastGoodWindows: WindowInfo[] = []; // worker 不可用/超时时的兜底：给上次结果，绝不在主线程跑同步枚举
const listPending = new Map<number, { resolve: (w: WindowInfo[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let listReqId = 1;

function killListWorker(reason: string): void {
  listWorkerBroken = true; // 永久回退同步版（打包环境可能 require 不到 koffi，别每次重试）
  for (const [, p] of listPending) { clearTimeout(p.timer); p.reject(new Error(`listWindows worker ${reason}`)); }
  listPending.clear();
  try { listWorker?.unref(); listWorker?.terminate(); } catch { /* ignore */ }
  listWorker = null;
}

function ensureListWorker(): Worker | null {
  if (listWorkerBroken) return null;
  // 仅真实 Electron 主进程启用 worker 卸载（纯 Node 单测/非 electron 走同步版，行为与改造前一致、避免 vitest 下 worker 抖动）
  if (typeof process.versions.electron !== 'string') return null;
  if (listWorker) return listWorker;
  try {
    const w = new Worker(LIST_WORKER_CODE, { eval: true });
    w.on('message', (msg: { id?: number; windows?: WindowInfo[]; error?: string }) => {
      if (msg?.id === undefined) return;
      const p = listPending.get(msg.id);
      if (!p) return;
      listPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.windows ?? []);
    });
    w.on('error', () => killListWorker('error'));
    w.on('exit', (code) => { if (code !== 0) killListWorker(`exit ${code}`); else listWorker = null; });
    listWorker = w;
    return w;
  } catch {
    listWorkerBroken = true;
    return null;
  }
}

/** 主线程安全的窗口枚举：非 Electron（单测）直接同步；Electron 一律走 worker，
 *  超时/不可用则返回上次缓存——绝不在主线程跑同步枚举（僵尸窗会让 GetWindowText 冻结主进程几十秒）。 */
export async function listWindows(): Promise<WindowInfo[]> {
  if (typeof process.versions.electron !== 'string') return listWindowsSync();
  const w = ensureListWorker();
  if (w) {
    const id = listReqId++;
    try {
      const list = await new Promise<WindowInfo[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (listPending.has(id)) { listPending.delete(id); reject(new Error('listWindows timeout')); }
        }, LIST_TIMEOUT_MS);
        listPending.set(id, { resolve, reject, timer });
        w.postMessage({ id });
      });
      lastGoodWindows = list;
      return list;
    } catch {
      /* worker 超时/出错：返回上次缓存，不在主线程跑同步枚举 */
    }
  }
  return lastGoodWindows;
}

export async function getForegroundWindow(): Promise<{ hwnd: number; title: string; className: string }> {
  // koffi 对 int64 返回 BigInt；HWND 实际是 32 位值，Number() 无精度损失
  const hwnd = Number(GetForegroundWindow());
  return { hwnd, title: readWindowTitle(hwnd), className: readClassName(hwnd) };
}

/** 把窗口激活到前台，返回是否真的成功（GetForegroundWindow 回读校验）。
 *  裸 SetForegroundWindow 在调用方不处于前台时会被 Windows 前台锁静默拒绝，
 *  故依次补：还原最小化 → AllowSetForegroundWindow → 挂接前台线程输入队列 → 重抢。 */
export function activateWindow(hwnd: number): boolean {
  if (!hwnd) return false;
  try {
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    AllowSetForegroundWindow(ASFW_ANY);
    SetForegroundWindow(hwnd);
    if (Number(GetForegroundWindow()) === hwnd) return true;
    const fg = Number(GetForegroundWindow());
    const fgThread = fg ? Number(GetWindowThreadProcessId(fg, Buffer.alloc(4))) : 0;
    const curThread = Number(GetCurrentThreadId());
    const attached = fgThread !== 0 && fgThread !== curThread;
    if (attached) AttachThreadInput(curThread, fgThread, true);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    if (attached) AttachThreadInput(curThread, fgThread, false);
    return Number(GetForegroundWindow()) === hwnd;
  } catch {
    return false;
  }
}

/** 物理像素坐标处的顶层窗口（点击前用它判断"这一点属于谁、是否在前台"）。
 *  返回 pid 便于识别本应用自己的窗口（灵动岛/边框会遮挡点击且不在截图里）。 */
export function windowAtPoint(x: number, y: number): { hwnd: number; title: string; className: string; pid: number } | null {
  try {
    const hwnd = Number(WindowFromPoint({ x: Math.round(x), y: Math.round(y) }));
    if (!hwnd) return null;
    const root = Number(GetAncestor(hwnd, GA_ROOT));
    const target = root || hwnd;
    const pidBuf = Buffer.alloc(4);
    const pid = GetWindowThreadProcessId(target, pidBuf) ? pidBuf.readUInt32LE(0) : 0;
    return { hwnd: target, title: readWindowTitle(target), className: readClassName(target), pid };
  } catch {
    return null;
  }
}

export function closeWindow(hwnd: number): void {
  PostMessageW(hwnd, WM_CLOSE, 0n, 0);
}

export function getSystemDpi(): number {
  const GetDpiForSystem = lib.func('uint32 GetDpiForSystem()');
  try {
    return Number(GetDpiForSystem());
  } catch {
    return 96;
  }
}

export function getMonitors(): MonitorInfo[] {
  // koffi 枚举显示器复杂；主进程用 electron.screen 提供（更权威），此处返回主屏占位
  const dpi = getSystemDpi();
  return [
    {
      index: 0,
      rect: { left: 0, top: 0, width: 1920, height: 1080 },
      scale: dpi / 96,
      isPrimary: true,
    },
  ];
}
