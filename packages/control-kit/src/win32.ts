// koffi FFI 绑定：user32.dll 键鼠注入（SendInput）、窗口枚举/激活、DPI
import koffi from 'koffi';
import type { MonitorInfo, Point, Rect, WindowInfo } from '@ximo-visagent/shared-types';

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
export const KEYEVENTF_UNICODE = 0x0004;
export const KEYEVENTF_KEYUP = 0x0002;
const WHEEL_DELTA = 120;

const INPUT_SIZE = 40; // x64 LINPUT

function sendInputBuf(buf: ArrayBuffer): boolean {
  const res = SendInput(1, new Uint8Array(buf), INPUT_SIZE);
  if (res !== 1) console.error('[win32] SendInput 失败, 返回', res);
  return res === 1;
}

/** 批量发送多个 INPUT 结构（一次 SendInput 调用，更可靠）。键盘注入模块（win32-keyboard）复用此原语 */
export function sendInputBatch(bufs: ArrayBuffer[]): boolean {
  if (bufs.length === 0) return true;
  const total = bufs.length * INPUT_SIZE;
  const combined = new ArrayBuffer(total);
  const view = new Uint8Array(combined);
  for (let i = 0; i < bufs.length; i++) {
    const buf = bufs[i];
    if (buf) view.set(new Uint8Array(buf), i * INPUT_SIZE);
  }
  const res = SendInput(bufs.length, view, INPUT_SIZE);
  if (res !== bufs.length) console.error(`[win32] SendInput 批量失败, 预期 ${bufs.length} 实际 ${res}`);
  return res === bufs.length;
}

function mouseInput(dx: number, dy: number, flags: number, mouseData = 0, time = 0): ArrayBuffer {
  const b = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(b);
  v.setUint32(0, INPUT_MOUSE, true);
  v.setInt32(8, dx, true); // mi.dx
  v.setInt32(12, dy, true); // mi.dy
  v.setUint32(16, mouseData, true); // mi.mouseData
  v.setUint32(20, flags, true); // mi.dwFlags
  v.setUint32(24, time, true); // mi.time (0=系统自动)
  v.setBigUint64(28, 0n, true); // mi.dwExtraInfo
  return b;
}

/** 单个键盘 INPUT 结构（键盘注入模块复用） */
export function kbdInput(wVk: number, wScan: number, flags: number): ArrayBuffer {
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

/** 虚拟屏幕范围（GetSystemMetrics），用于 SendInput 归一化坐标。
 *  注意：GetSystemMetrics 返回的是物理像素，而模型给的坐标是截图坐标系
 *  （宿主当前按物理分辨率截图，但比例仍由宿主每帧设置，不在此处假设）。 */
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

/** 截图坐标↔物理像素换算已拆至 screen-scale.ts，此处转出保持既有导入路径可用 */
export { setScreenScale, getScreenScale, screenshotToPhysical, physicalToScreenshot } from './screen-scale';
import { screenshotToPhysical, physicalToScreenshot } from './screen-scale';

/** 归一化到 0-65535 的绝对坐标（输入为截图坐标系坐标，先换算到物理像素） */
function toAbsolute(x: number, y: number): { nx: number; ny: number } {
  const vs = virtualScreen();
  if (vs.width <= 0 || vs.height <= 0) return { nx: 0, ny: 0 };
  // 截图坐标 → 物理像素
  const phys = screenshotToPhysical(x, y);
  return {
    nx: Math.round(((phys.x - vs.left) * 65535) / (vs.width - 1)),
    ny: Math.round(((phys.y - vs.top) * 65535) / (vs.height - 1)),
  };
}

// ---------- 人类轨迹生成 ----------
/** 人类鼠标轨迹：三阶贝塞尔 + 抖动（纯函数，见 cursor-path.ts） */
import { generatePath } from './cursor-path';

/** 系统双击时间阈值（ms），用于双击间隔 */
const GetDoubleClickTime = lib.func('uint32 GetDoubleClickTime()');

function getDoubleClickTime(): number {
  try {
    // koffi 对 uint32 返回 number；Number() 显式收敛，避免用双重断言闭嘴
    return Number(GetDoubleClickTime());
  } catch {
    return 500; // 默认
  }
}

/** 当前光标位置（GetCursorPos 物理像素 → 截图坐标系）。
 *  不做缓存：用户或其他程序移动光标后缓存即失效，轨迹起点会从屏幕另一头甩过来。
 *  每次调用只读一次 GetCursorPos，代价远低于错误起点带来的横扫。 */
const GetCursorPos = lib.func('bool GetCursorPos(_Out_ int64* lpPoint)');

function getCurPos(): { x: number; y: number } {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  if (GetCursorPos(buf)) {
    // GetCursorPos 返回物理像素，转成截图坐标系
    return physicalToScreenshot(v.getInt32(0, true), v.getInt32(4, true));
  }
  return { x: 0, y: 0 };
}
/**
 * 沿人类轨迹移动到 (x, y)，逐步发送 SendInput MOVE。
 * 轨迹由 generatePath 生成，每步间隔 ~2ms（快但不瞬移）。
 * 移动结束后用 GetCursorPos 验证光标确实到位。
 */
export async function mouseMoveTo(toX: number, toY: number): Promise<void> {
  const from = getCurPos();
  const path = generatePath(from.x, from.y, toX, toY);
  for (const pt of path) {
    const { nx, ny } = toAbsolute(pt.x, pt.y);
    sendInputBuf(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
    if (path.length > 1) await sleep(2);
  }
  // 落地确认：用 GetCursorPos 验证光标确实到达目标位置（截图系比对，容差 3px）
  // 失败则强制发一次绝对坐标移动
  const verify = verifyCurPos(toX, toY);
  if (!verify) {
    const { nx, ny } = toAbsolute(toX, toY);
    sendInputBuf(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
    await sleep(5);
  }
}

/** 用 GetCursorPos 验证光标是否到达目标位置（截图坐标系比对，容差 3px）。
 *  GetCursorPos 返回物理像素，须先转截图坐标再比。 */
function verifyCurPos(targetX: number, targetY: number): boolean {
  try {
    const buf = new ArrayBuffer(8);
    if (!GetCursorPos(buf)) return false;
    const v = new DataView(buf);
    const p = physicalToScreenshot(v.getInt32(0, true), v.getInt32(4, true));
    return Math.abs(p.x - targetX) <= 3 && Math.abs(p.y - targetY) <= 3;
  } catch {
    return false;
  }
}

export async function mouseClick(x: number, y: number, button: MouseButton = 'left', times = 1): Promise<void> {
  // 先沿人类轨迹移动到目标位置
  await mouseMoveTo(x, y);
  // 移动后短暂等待，确保光标落定再点击（提高一次命中率）
  await sleep(10);
  const { nx, ny } = toAbsolute(x, y);
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  if (times === 1) {
    // 单击：down + up 一次 SendInput（光标已在目标位置）
    sendInputBatch([
      mouseInput(nx, ny, down | MOUSEEVENTF_ABSOLUTE),
      mouseInput(nx, ny, up | MOUSEEVENTF_ABSOLUTE),
    ]);
    return;
  }
  // 双击：两次 down+up 必须在各自的一次 SendInput 调用内完成（原子性），
  // 否则目标窗口会把分开调用的 down/up 视为独立单击而非双击。
  // 两次点击之间用 sleep 保证落在系统双击时间窗口内。
  const interval = Math.max(10, Math.floor(getDoubleClickTime() / 3));
  for (let i = 0; i < times; i++) {
    sendInputBatch([
      mouseInput(nx, ny, down | MOUSEEVENTF_ABSOLUTE),
      mouseInput(nx, ny, up | MOUSEEVENTF_ABSOLUTE),
    ]);
    if (i < times - 1) await sleep(interval);
  }
}

export async function mouseScroll(delta: number, x?: number, y?: number): Promise<void> {
  // 先沿人类轨迹移动到目标位置（如有指定）
  if (x !== undefined && y !== undefined) {
    await mouseMoveTo(x, y);
  }
  const inputs: ArrayBuffer[] = [];
  if (x !== undefined && y !== undefined) {
    const { nx, ny } = toAbsolute(x, y);
    inputs.push(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
  }
  inputs.push(mouseInput(0, 0, MOUSEEVENTF_WHEEL, delta * WHEEL_DELTA));
  sendInputBatch(inputs);
}

export async function mouseDrag(from: { x: number; y: number }, to: { x: number; y: number }, button: MouseButton = 'left'): Promise<void> {
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  // 先沿人类轨迹移动到起点
  await mouseMoveTo(from.x, from.y);
  const fromAbs = toAbsolute(from.x, from.y);
  // 按下按钮
  sendInputBuf(mouseInput(fromAbs.nx, fromAbs.ny, down | MOUSEEVENTF_ABSOLUTE));
  // 沿人类轨迹拖拽到终点
  const path = generatePath(from.x, from.y, to.x, to.y);
  for (const pt of path) {
    const { nx, ny } = toAbsolute(pt.x, pt.y);
    sendInputBuf(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
    if (path.length > 1) await sleep(2);
  }
  // 释放按钮
  const toAbs = toAbsolute(to.x, to.y);
  sendInputBuf(mouseInput(toAbs.nx, toAbs.ny, up | MOUSEEVENTF_ABSOLUTE));
}

/** 长按：移动到目标位置，按下按钮保持 holdMs 毫秒后释放。
 *  典型场景：长按桌面图标进入拖拽准备态、长按列表项触发右键菜单、
 *  长按文件触发 Windows 上下文菜单、模拟"按住不放"的持续交互。 */
export async function mouseHold(x: number, y: number, button: MouseButton = 'left', holdMs = 500): Promise<void> {
  await mouseMoveTo(x, y);
  await sleep(10);
  const { nx, ny } = toAbsolute(x, y);
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  // 按下
  sendInputBuf(mouseInput(nx, ny, down | MOUSEEVENTF_ABSOLUTE));
  // 保持
  await sleep(holdMs);
  // 释放
  sendInputBuf(mouseInput(nx, ny, up | MOUSEEVENTF_ABSOLUTE));
}

/** 长按拖拽：移动到起点，按下按钮保持 holdMs 毫秒（让系统识别拖拽源），
 *  再沿人类轨迹拖拽到终点释放。
 *  典型场景：拖拽文件/文件夹（Windows 需要长按一下让系统识别拖拽源）、
 *  拖拽排序列表项、框选文本（长按起点 → 拖到终点）。 */
export async function mouseDragHold(
  from: { x: number; y: number },
  to: { x: number; y: number },
  button: MouseButton = 'left',
  holdMs = 300,
): Promise<void> {
  const { down, up } = MOUSE_BUTTON_FLAGS[button];
  // 先沿人类轨迹移动到起点
  await mouseMoveTo(from.x, from.y);
  const fromAbs = toAbsolute(from.x, from.y);
  // 按下按钮
  sendInputBuf(mouseInput(fromAbs.nx, fromAbs.ny, down | MOUSEEVENTF_ABSOLUTE));
  // 保持一段时间，让目标窗口识别长按 / 进入拖拽态
  await sleep(holdMs);
  // 沿人类轨迹拖拽到终点
  const path = generatePath(from.x, from.y, to.x, to.y);
  for (const pt of path) {
    const { nx, ny } = toAbsolute(pt.x, pt.y);
    sendInputBuf(mouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
    if (path.length > 1) await sleep(2);
  }
  // 释放按钮
  const toAbs = toAbsolute(to.x, to.y);
  sendInputBuf(mouseInput(toAbs.nx, toAbs.ny, up | MOUSEEVENTF_ABSOLUTE));
}

// ---------- 键盘 ----------
// keyboardType / keyboardPress 已拆至 win32-keyboard.ts（见 index.ts 的 re-export）

// 窗口枚举/激活/关闭与 DPI 已拆至 win32-window.ts（见 index.ts 的 re-export）

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Point, Rect, MonitorInfo, WindowInfo };