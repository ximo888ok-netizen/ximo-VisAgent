/**
 * island.ts — 灵动岛主进程窗口管理（预算 <300 行）
 *
 * 窗口特征（需求文档 3.1）：
 *   transparent / frame:false / alwaysOnTop / skipTaskbar /
 *   focusable:false（审批编辑时临时放行）/ resizable:false
 *
 * 对外（后端 Agent / 其他主进程模块）：
 *   getIslandWindow()       取窗口
 *   publishStep() / publishApprovalPending()  向 UI 推事件
 */
import {
  BrowserWindow,
  screen,
  nativeTheme,
  type Rectangle,
} from "electron";
import * as path from "node:path";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  AgentStepEvent,
  ApprovalRequest,
} from "../../shared/island-contracts";

export const ISLAND_MAX_WIDTH = 900;
export const ISLAND_MIN_WIDTH = 400;
export const ISLAND_COLLAPSED_HEIGHT = 64;
export const ISLAND_EXPANDED_HEIGHT = 280;
/** 屏幕顶部留白（需求：距边缘 10px） */
const TOP_MARGIN = 10;

let islandWindow: BrowserWindow | null = null;

/* ------------------------------------------------------------------ */
/* 窗口创建                                                             */
/* ------------------------------------------------------------------ */

export function createIslandWindow(): BrowserWindow {
  if (islandWindow && !islandWindow.isDestroyed()) {
    return islandWindow;
  }

  const primary = screen.getPrimaryDisplay().workArea;
  const width = ISLAND_MIN_WIDTH;
  const height = ISLAND_COLLAPSED_HEIGHT;

  islandWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + TOP_MARGIN),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false, // 阴影由 CSS box-shadow 提供，避免透明窗口黑边
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/island.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 默认忽略鼠标事件（穿透到桌面图标）；渲染层命中交互区后动态放开
  islandWindow.setIgnoreMouseEvents(true, { forward: true });
  // Windows 上 alwaysOnTop(true) 默认 normal 级别，会被其他置顶窗口覆盖。
  // 使用 screen-saver 级别确保始终在最顶层。
  islandWindow.setAlwaysOnTop(true, "screen-saver");

  // focusable:false 的透明窗口在 Windows 上不会自动显示，需显式 showInactive
  islandWindow.showInactive();

  islandWindow.on("closed", () => {
    islandWindow = null;
  });

  // 主题变化 -> 推送渲染层切换 dark 类
  const onTheme = (): void => {
    broadcast(ISLAND_CHANNELS.themeChanged, nativeTheme.shouldUseDarkColors);
  };
  nativeTheme.on("updated", onTheme);
  islandWindow.on("closed", () => nativeTheme.removeListener("updated", onTheme));
  islandWindow.webContents.on("did-finish-load", onTheme);

  // 全屏隐身检测
  startFullscreenWatcher(islandWindow);

  // 多显示器变更 -> 重新居中到光标所在显示器
  const onMetrics = (): void => reAnchor();
  screen.on("display-metrics-changed", onMetrics);
  islandWindow.on("closed", () => screen.removeListener("display-metrics-changed", onMetrics));

  return islandWindow;
}

export function getIslandWindow(): BrowserWindow | null {
  return islandWindow && !islandWindow.isDestroyed() ? islandWindow : null;
}

/* ------------------------------------------------------------------ */
/* 布局                                                               */
/* ------------------------------------------------------------------ */

/** 将窗口锚定到屏幕顶部居中；display 缺省时取窗口所在显示器 */
export function reAnchor(): void {
  const win = getIslandWindow();
  if (!win) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;
  const size = win.getSize();
  const w = size[0] ?? 0;
  const h = size[1] ?? 0;
  const x = Math.round(area.x + (area.width - w) / 2);
  const y = Math.round(area.y + TOP_MARGIN);
  win.setBounds({ x, y, width: w, height: h }, false);
}

/** 由渲染层内容尺寸驱动窗口缩放（锚定顶部中央不变） */
export function resizeIsland(width: number, height: number): void {
  const win = getIslandWindow();
  if (!win) return;
  const clampW = Math.max(ISLAND_MIN_WIDTH, Math.min(ISLAND_MAX_WIDTH, Math.round(width)));
  const clampH = Math.round(height);

  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const cx = win.getBounds().x + win.getBounds().width / 2;
  const x = Math.round(cx - clampW / 2);
  const y = Math.round(area.y + TOP_MARGIN);
  win.setBounds({
    x: Math.max(area.x, Math.min(x, area.x + area.width - clampW)),
    y,
    width: clampW,
    height: clampH,
  });
}

/** 唤出/聚焦全功能主窗口（由调用方通过 deps 提供真实实现） */
export function focusMainWindow(getMainWindow: () => BrowserWindow | null): boolean {
  const main = getMainWindow();
  if (!main) return false;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  return true;
}

/* ------------------------------------------------------------------ */
/* 显示 / 隐藏 / 鼠标穿透 / 输入焦点                                   */
/* ------------------------------------------------------------------ */

/** 显示灵动岛（不抢焦点） */
export function showIsland(): void {
  const win = getIslandWindow();
  if (!win) return;
  win.showInactive();
}

/** 隐藏灵动岛 */
export function hideIsland(): void {
  const win = getIslandWindow();
  if (!win) return;
  win.hide();
}

/** 切换灵动岛可见性，返回切换后状态 */
export function toggleIsland(): boolean {
  const win = getIslandWindow();
  if (!win) return false;
  if (win.isVisible()) {
    win.hide();
    return false;
  } else {
    win.showInactive();
    return true;
  }
}

export function setPassthrough(enabled: boolean): void {
  getIslandWindow()?.setIgnoreMouseEvents(enabled, { forward: true });
}

export function setKeyboardInputActive(active: boolean): void {
  const win = getIslandWindow();
  if (!win) return;
  win.setFocusable(active);
  if (active) win.webContents.focus();
}

/* ------------------------------------------------------------------ */
/* 事件推送（后端 Agent 调用）                                          */
/* ------------------------------------------------------------------ */

export function publishStep(event: AgentStepEvent): boolean {
  return broadcast(ISLAND_CHANNELS.step, event);
}

export function publishApprovalPending(request: ApprovalRequest): boolean {
  return broadcast(ISLAND_CHANNELS.approvalPending, request);
}

function broadcast(channel: string, payload: unknown): boolean {
  const win = getIslandWindow();
  if (!win || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

/* ------------------------------------------------------------------ */
/* 全屏隐身                                                            */
/* ------------------------------------------------------------------ */

/**
 * 检测前台是否处于全屏应用（游戏 / PPT 放映）。
 * 说明：Electron 不暴露第三方窗口句柄，生产环境推荐接入原生方案：
 *   - 方案 A：`node-window-manager` 的 getActiveWindow()
 *   - 方案 B：Win32 GetForegroundWindow + GetWindowRect 对比显示器边界
 * 本实现默认尝试 A，未安装依赖时安全降级为「不隐身」（返回 false）。
 */
export function isForegroundFullscreen(): boolean {
  if (process.platform !== "win32") return false;
  try {
    // 可选依赖：pnpm add node-window-manager
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wm = require("node-window-manager");
    const active = wm.windowManager.getActiveWindow();
    if (!active) return false;
    const rect = active.getBounds?.() as Rectangle | undefined;
    if (!rect) return false;
    const display = screen.getDisplayMatching(rect);
    return (
      Math.abs(rect.width - display.bounds.width) <= 1 &&
      Math.abs(rect.height - display.bounds.height) <= 1
    );
  } catch {
    return false;
  }
}

function startFullscreenWatcher(win: BrowserWindow): void {
  const interval = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(interval);
      return;
    }
    const fullscreen = isForegroundFullscreen();
    if (fullscreen && win.isVisible()) {
      win.hide();
    } else if (!fullscreen && !win.isVisible() && !win.isMinimized()) {
      win.showInactive(); // 退出全屏自动复现，但不抢焦点
    }
  }, 1000);
  win.on("closed", () => clearInterval(interval));
}