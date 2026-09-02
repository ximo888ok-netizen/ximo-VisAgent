// koffi FFI 绑定：user32.dll 键鼠注入（SendInput）、窗口枚举/激活、DPI
import koffi from 'koffi';
import type { MonitorInfo, Point, Rect, WindowInfo } from '@desktop-agi/shared-types';

const lib = koffi.load('user32.dll');

// SendInput 安全调用：INPUT 结构(40B x64)手工字节填充，避免 koffi union 兼容问题
const SendInput = lib.func('uint32 SendInput(uint32 cInputs, void* pInputs, int32 cbSize)');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const WHEEL_DELTA = 120;

const INPUT_SIZE = 40; // x64 LINPUT

function sendInputBuf(buf: ArrayBuffer): boolean {
  const res = SendInput(1, new Uint8Array(buf), INPUT_SIZE);
  return res === 1;
}

function mouseInput(dx: number, dy: number, flags: number, mouseData = 0): ArrayBuffer {
  const b = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(b);
  v.setUint32(0, INPUT_MOUSE, true);
  v.setInt32(8, dx, true); // mi.dx
  v.setInt32(12, dy, true); // mi.dy
  v.setUint32(16, mouseData, true); // mi.mouseData
  v.setUint32(20, flags, true); // mi.dwFlags
  v.setUint32(24, 0, true); // mi.time
  v.setBigUint64(28, 0n, true); // mi.dwExtraInfo
  return b;
}

function kbdInput(wVk: number, wScan: number, flags: number): ArrayBuffer {
  const b = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(b);
  v.setUint32(0, INPUT_KEYBOARD, true);
  v.setUint16(8, wVk, true); // ki.wVk
  v.setUint16(10, wScan, true); // ki.wScan
  v.setUint32(12, flags, true); // ki.dwFlags
  v.setUint32(16, 0, true); // ki.time
  v.setBigUint64(20, 0n, true); // ki.dwExtraInfo
  return b;
}

// ---------- 鼠标 ----------
export type MouseButton = 'left' | 'right' | 'middle';

const MOUSE_BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

interface VirtualScreen {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 虚拟屏幕范围（GetSystemMetrics），用于 SendInput 归一化坐标 */
function virtualScreen(): VirtualScreen {
  const GetSystemMetrics = lib.func('int32 GetSystemMetrics(int32 nIndex)');
  const SM_XVIRTUALSCREEN = 76;
  const SM_YVIRTUALSCREEN = 77;
  const SM_CXVIRTUALSCREEN = 78;
  const SM_CYVIRTUALSCREEN = 79;
  return {
    left: GetSystemMetrics(SM_XVIRTUALSCREEN),
    top: GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

/**
 * 绝对坐标移动（SendInput MOUSEEVENTF_ABSOLUTE 需要 0-65535 归一化到虚拟屏幕）。
 * x,y 为物理像素（虚拟屏幕坐标系，含负偏移）。
 */
export function mouseMoveTo(x: number, y: number): void {
  const vs = virtualScreen();
  if (vs.width <= 0 || vs.height <= 0) return;
  const nx = Math.round(((x - vs.left) * 65535) / (vs.width - 1));
  const ny = Math.round(((y - vs.top) * 65535) / (vs.height - 1));
  sendInputBuf(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
}

export function mouseClick(x: number, y: number, button: MouseButton = 'left', times = 1): void {
  mouseMoveTo(x, y);
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  for (let i = 0; i < times; i++) {
    sendInputBuf(mouseInput(0, 0, down));
    sendInputBuf(mouseInput(0, 0, up));
  }
}

export function mouseScroll(delta: number): void {
  // delta 数量级：1 格 = 1 个 WHEEL_DELTA
  sendInputBuf(mouseInput(0, 0, MOUSEEVENTF_WHEEL, delta * WHEEL_DELTA));
}

export function mouseDrag(from: { x: number; y: number }, to: { x: number; y: number }, button: MouseButton = 'left'): void {
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  mouseMoveTo(from.x, from.y);
  sendInputBuf(mouseInput(0, 0, down));
  const steps = Math.max(4, Math.min(24, Math.floor(Math.hypot(to.x - from.x, to.y - from.y) / 6)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    mouseMoveTo(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t));
  }
  sendInputBuf(mouseInput(0, 0, up));
}

// ---------- 键盘 ----------
export function keyboardType(text: string, intervalMs = 10): void {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    sendInputBuf(kbdInput(0, code, KEYEVENTF_UNICODE));
    sendInputBuf(kbdInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    if (intervalMs > 0) busyWait(intervalMs);
  }
}

const VK_MAP: Record<string, number> = {
  CTRL: 0x11, CONTROL: 0x11, ALT: 0x12, SHIFT: 0x10,
  WIN: 0x5b, LWIN: 0x5b, RWIN: 0x5c,
  ENTER: 0x0d, RETURN: 0x0d, ESC: 0x1b, ESCAPE: 0x1b, TAB: 0x09, SPACE: 0x20,
  BACKSPACE: 0x08, BKSP: 0x08, DELETE: 0x2e, DEL: 0x2e, INSERT: 0x2d, INS: 0x2d,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  HOME: 0x24, END: 0x23, PAGEUP: 0x21, PGDN: 0x22, PAGEDOWN: 0x22,
  CAPSLOCK: 0x14, NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  APPS: 0x5d, MENU: 0x5d, PRINTSCREEN: 0x2c, PAUSE: 0x13,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5a, ZERO: 0x30, ONE: 0x31, TWO: 0x32, THREE: 0x33, FOUR: 0x34,
  FIVE: 0x35, SIX: 0x36, SEVEN: 0x37, EIGHT: 0x38, NINE: 0x39,
  NUMPAD0: 0x60, NUMPAD1: 0x61, NUMPAD2: 0x62, NUMPAD3: 0x63, NUMPAD4: 0x64,
  NUMPAD5: 0x65, NUMPAD6: 0x66, NUMPAD7: 0x67, NUMPAD8: 0x68, NUMPAD9: 0x69,
  MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f,
};

function parseCombo(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim().toUpperCase()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    if (VK_MAP[p]) out.push(VK_MAP[p]);
    else if (/^[0-9]$/.test(p)) out.push(0x30 + parseInt(p, 10));
    else throw new Error(`未知按键: ${p}`);
  }
  if (out.length === 0) throw new Error('空组合键');
  return out;
}

export function keyboardPress(combo: string): void {
  const keys = parseCombo(combo);
  for (const k of keys) sendInputBuf(kbdInput(k, 0, 0));
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (k !== undefined) sendInputBuf(kbdInput(k, 0, KEYEVENTF_KEYUP));
  }
}

// ---------- 窗口 ----------
koffi.proto('bool EnumProc(int64 hwnd, int64 lParam)');
const EnumWindows = lib.func('bool EnumWindows(EnumProc *cb, int64 lParam)');
const GetWindowTextW = lib.func('int32 GetWindowTextW(int64 hwnd, _Out_ char* lpString, int32 nMaxCount)');
const GetClassNameW = lib.func('int32 GetClassNameW(int64 hwnd, _Out_ char* lpClassName, int32 nMaxCount)');
const IsWindowVisible = lib.func('bool IsWindowVisible(int64 hwnd)');
const GetWindowRect = lib.func('bool GetWindowRect(int64 hwnd, void* lpRect)');
const GetWindowThreadProcessId = lib.func('uint32 GetWindowThreadProcessId(int64 hwnd, _Out_ uint32* pid)');
const SetForegroundWindow = lib.func('bool SetForegroundWindow(int64 hwnd)');
const PostMessageW = lib.func('bool PostMessageW(int64 hwnd, uint32 msg, uint64 wParam, int64 lParam)');
const GetForegroundWindow = lib.func('int64 GetForegroundWindow()');

const WM_CLOSE = 0x0010;

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

export async function listWindows(): Promise<WindowInfo[]> {
  const windows: WindowInfo[] = [];
  const done = new Promise<void>((resolve) => {
    EnumWindows((hwnd: number) => {
      const pidBuf = Buffer.alloc(4);
      const pid = GetWindowThreadProcessId(hwnd, pidBuf) ? (pidBuf.readUInt32LE(0) as unknown as number) : 0;
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
    resolve();
  });
  await done;
  return windows;
}

export async function getForegroundWindow(): Promise<{ hwnd: number; title: string }> {
  const hwnd = GetForegroundWindow() as unknown as number;
  return { hwnd, title: readWindowTitle(hwnd) };
}

export function activateWindow(hwnd: number): void {
  SetForegroundWindow(hwnd);
}

export function closeWindow(hwnd: number): void {
  PostMessageW(hwnd, WM_CLOSE, 0n, 0);
}

// ---------- DPI ----------
export function getSystemDpi(): number {
  const GetDpiForSystem = lib.func('uint32 GetDpiForSystem()');
  try {
    return GetDpiForSystem() as unknown as number;
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

function busyWait(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) { /* nop */ }
}

export type { Point, Rect, MonitorInfo, WindowInfo };