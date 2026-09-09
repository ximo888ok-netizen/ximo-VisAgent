/**
 * windows/aura.ts — Agent 在场指示边框（每显示器一个无边框穿透窗口）
 *
 * 三个不可妥协的约束：
 * 1. 不吃鼠标：click-through 且 forward，否则它会挡住 hover，正好破坏我们想解决的问题；
 * 2. 不进采屏：SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，见 win-effects.ts；
 * 3. 最小暴露面：与岛共用同一个 preload 文件（sandbox preload 必须单文件自包含，
 *    多入口会被 rollup 拆 chunk 后遭沙箱拒载——灵动岛空白事故根因），
 *    但渲染层约定边框页面只允许使用 auraAPI，绝不调用 islandAPI。
 */
import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { ISLAND_CHANNELS } from '../../shared/island-channels';
import type { AuraFrame } from '../../shared/aura-contracts';
import { excludeWindowFromCapture, supportsCaptureExclusion } from '../win-effects';

/** 顶到 screen-saver 层：与普通应用窗口和无边框全屏（borderless）争顺序时能赢 */
const AURA_LEVEL = 'screen-saver';

const windows = new Map<number, BrowserWindow>();
let frame: AuraFrame | null = null;
let intensity: 'off' | 'subtle' | 'full' = 'full';

const isDev = process.env.NODE_ENV === 'development';

function auraEntry(): string {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (isDev && url) return `${url.replace(/\/$/, '')}/aura.html`;
  return path.join(__dirname, '..', 'renderer', 'aura.html');
}

function createAuraWindow(displayId: number, bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'island.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, AURA_LEVEL);
  // 与岛同级的防护：边框页面不允许导航/开新窗
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 穿透 + forward：鼠标事件继续落到下面的真实窗口，边框只做视觉
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(auraEntry().startsWith('http') ? auraEntry() : `file:///${auraEntry().replace(/\\/g, '/')}`);
  win.once('ready-to-show', () => {
    if (intensity !== 'off' && frame && frame.state !== 'idle') win.showInactive();
  });

  // 采集排除必须在窗口拿到原生句柄之后
  const ok = excludeWindowFromCapture(win.getNativeWindowHandle());
  if (!ok && supportsCaptureExclusion()) {
    console.warn(`[aura] 显示器 ${displayId} 未生效采集排除，边框会进入 Agent 的截图`);
  }

  win.on('closed', () => {
    windows.delete(displayId);
  });
  return win;
}

/** 按当前显示器集合重建（热插拔/改分辨率后调用） */
function syncDisplays(): void {
  const live = new Set(screen.getAllDisplays().map((d) => d.id));

  for (const [id, win] of windows) {
    if (!live.has(id) || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy();
      windows.delete(id);
    }
  }
  for (const d of screen.getAllDisplays()) {
    const existing = windows.get(d.id);
    if (existing && !existing.isDestroyed()) {
      existing.setBounds(d.bounds);
      continue;
    }
    windows.set(d.id, createAuraWindow(d.id, d.bounds));
  }
}

/** 应用边框强度设置（来自「设置 → 外观」） */
export function setAuraIntensity(next: 'off' | 'subtle' | 'full'): void {
  intensity = next;
  if (next === 'off') {
    for (const win of windows.values()) if (!win.isDestroyed()) win.hide();
    return;
  }
  syncDisplays();
  applyVisibility();
  broadcast();
}

export function getAuraIntensity(): 'off' | 'subtle' | 'full' {
  return intensity;
}

/** 主进程唯一的状态入口：状态变了就推给所有边框窗口 */
export function pushAura(next: AuraFrame): void {
  const prev = frame?.state;
  frame = next;
  if (prev !== next.state) applyVisibility();
  broadcast();
}

export function currentAuraFrame(): AuraFrame | null {
  return frame;
}

/**
 * 只在「需要被看见」的时候显示。
 * idle 且任务不在跑时全部隐藏，避免用户桌面上长期有个发光框。
 */
function applyVisibility(): void {
  if (intensity === 'off' || !frame) {
    for (const win of windows.values()) if (!win.isDestroyed()) win.hide();
    return;
  }
  const shouldShow = frame.state !== 'idle';
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    if (shouldShow) win.showInactive();
    else win.hide();
  }
}

/** 虚拟指针落点：物理屏幕坐标 → 所在显示器的归一化坐标（幽灵指针渲染用） */
export function pushAuraPointer(screenX: number, screenY: number): void {
  if (intensity === 'off' || windows.size === 0) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(screenX), y: Math.round(screenY) });
  const win = windows.get(display.id);
  if (!win || win.isDestroyed() || display.workArea.width === 0) return;
  win.webContents.send(ISLAND_CHANNELS.auraPointer, {
    x: Math.min(1, Math.max(0, (screenX - display.bounds.x) / display.bounds.width)),
    y: Math.min(1, Math.max(0, (screenY - display.bounds.y) / display.bounds.height)),
    ts: Date.now(),
  });
}

function broadcast(): void {
  if (!frame) return;
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(ISLAND_CHANNELS.auraState, frame);
  }
}

/** 诊断用：每个边框窗口的可见状态 */
export function auraWindowReport(): Array<{ display: number; visible: boolean; bounds: Electron.Rectangle }> {
  return [...windows.entries()].map(([id, w]) => ({
    display: id,
    visible: !w.isDestroyed() && w.isVisible(),
    bounds: w.isDestroyed() ? { x: 0, y: 0, width: 0, height: 0 } : w.getBounds(),
  }));
}

/** 应用启动时调用一次 */
export function initAura(): void {
  syncDisplays();
  const onChange = () => {
    syncDisplays();
    broadcast();
  };
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
  screen.on('display-metrics-changed', onChange);
}
