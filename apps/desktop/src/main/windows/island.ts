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
  nativeImage,
  screen,
  nativeTheme,
  type Rectangle,
} from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import { excludeWindowFromCapture, supportsCaptureExclusion } from "../win-effects";
import islandIconPath from "../../../resources/icon.png?asset";
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
/** 布局持久化文件（位置独立于 config，避免与 safeStorage 解密路径耦合） */
const LAYOUT_FILE = () =>
  path.join((process.env.APPDATA ?? process.cwd()), "ximo-VisAgent", "island-layout.json");

let islandWindow: BrowserWindow | null = null;
let saveLayoutTimer: NodeJS.Timeout | null = null;
/** P1-11：用户主动隐藏标记（区别于全屏自动隐身，watcher 不再强行弹回） */
let userHidden = false;

/** 读取持久化布局（失败返回 null，调用方走默认居中） */
function loadLayout(): { x: number; y: number; width: number; height: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LAYOUT_FILE(), "utf8")) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (typeof raw.x === "number" && typeof raw.y === "number") {
      return {
        x: raw.x,
        y: raw.y,
        width: typeof raw.width === "number" ? raw.width : ISLAND_MIN_WIDTH,
        height: typeof raw.height === "number" ? raw.height : ISLAND_COLLAPSED_HEIGHT,
      };
    }
  } catch { /* 无文件或损坏 */ }
  return null;
}

/** 防抖持久化窗口位置 */
function saveLayoutDebounced(): void {
  if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    const win = getIslandWindow();
    if (!win) return;
    try {
      const b = win.getBounds();
      fs.mkdirSync(path.dirname(LAYOUT_FILE()), { recursive: true });
      fs.writeFileSync(LAYOUT_FILE(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }), "utf8");
    } catch { /* 写盘失败忽略 */ }
  }, 500);
}

/** 把窗口位置 clamp 进某个显示器工作区（防拖出屏幕） */
function clampIntoWorkArea(x: number, y: number, w: number, h: number): Rectangle {
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const area = display.workArea;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - w)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - h)),
    width: w,
    height: h,
  };
}

/** 岛的初始边界（A1：恢复上次位置+尺寸并 clamp；无记录则顶部居中）。
 *  Y 恒为顶部吸附位（TOP_MARGIN）——历史持久化的 y 会被纠正，岛永远在屏幕顶部。
 *  splash 与岛共用此计算，保证启动动画与真岛同位置同尺寸交接（见 windows/splash.ts）。 */
export function getIslandInitialBounds(): Rectangle {
  const primary = screen.getPrimaryDisplay().workArea;
  const saved = loadLayout();
  const width = saved?.width ?? ISLAND_MIN_WIDTH;
  const height = saved?.height ?? ISLAND_COLLAPSED_HEIGHT;
  if (saved) return clampIntoWorkArea(saved.x, primary.y + TOP_MARGIN, width, height);
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + TOP_MARGIN),
    width,
    height,
  };
}

/* ------------------------------------------------------------------ */
/* 窗口创建                                                             */
/* ------------------------------------------------------------------ */

export function createIslandWindow(): BrowserWindow {
  if (islandWindow && !islandWindow.isDestroyed()) {
    return islandWindow;
  }

  islandWindow = new BrowserWindow({
    // A1：恢复上次位置+尺寸（clamp 进工作区）；无记录则默认顶部居中
    ...getIslandInitialBounds(),
    icon: nativeImage.createFromPath(islandIconPath), // Alt-Tab/任务组显示项目 logo
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    minWidth: ISLAND_MIN_WIDTH,
    minHeight: ISLAND_COLLAPSED_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, "../preload/island.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  islandWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  islandWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  islandWindow.setAlwaysOnTop(true, "screen-saver");
  islandWindow.showInactive();

  // 采集排除：岛不进 Agent 截图——自己的提示框会遮挡目标区域，模型还会浪费步数处理自己的 UI
  // （不影响用户肉眼所见；副作用是用户截图/镜像里也看不到岛）
  if (!excludeWindowFromCapture(islandWindow.getNativeWindowHandle()) && supportsCaptureExclusion()) {
    console.warn('[island] 采集排除未生效，岛会出现在 Agent 截图中');
  }

  islandWindow.on("closed", () => {
    islandWindow = null;
  });
  // 顶部吸附：拖拽只保留水平自由度，松手后 Y 弹回 TOP_MARGIN
  // （用户垂直拖动是肌肉记忆，强制锁死会打架；moved 纠正最顺滑）
  islandWindow.on("moved", () => {
    snapToTop();
    saveLayoutDebounced();
  });
  islandWindow.on("resize", () => saveLayoutDebounced());

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

/** 顶部吸附：把 Y 纠正回所在显示器工作区顶部 + TOP_MARGIN（水平位置不动）。
 *  moved 事件与 resize 通道都走这里——岛是「顶部吸附条」，只有水平自由度。 */
function snapToTop(): void {
  const win = getIslandWindow();
  if (!win) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const targetY = Math.round(area.y + TOP_MARGIN);
  if (b.y === targetY) return;
  win.setBounds({ x: b.x, y: targetY, width: b.width, height: b.height }, false);
}

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

/**
 * 由渲染层内容尺寸驱动窗口缩放。
 * A1：保持水平锚定（用户拖到哪就在哪），Y 恒锁定顶部吸附位。
 */
export function resizeIsland(width: number, height: number): void {
  const win = getIslandWindow();
  if (!win) return;
  const clampW = Math.max(ISLAND_MIN_WIDTH, Math.min(ISLAND_MAX_WIDTH, Math.round(width)));
  const clampH = Math.round(height);
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const clamped = clampIntoWorkArea(b.x, Math.round(area.y + TOP_MARGIN), clampW, clampH);
  win.setBounds(clamped, false);
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

/** 显示灵动岛（不抢焦点；清除用户主动隐藏标记） */
export function showIsland(): void {
  const win = getIslandWindow();
  if (!win) return;
  userHidden = false;
  win.showInactive();
}

/** 隐藏灵动岛（用户主动隐藏，全屏 watcher 不再自动复现） */
export function hideIsland(): void {
  const win = getIslandWindow();
  if (!win) return;
  userHidden = true;
  win.hide();
}

/** 切换灵动岛可见性，返回切换后状态 */
export function toggleIsland(): boolean {
  const win = getIslandWindow();
  if (!win) return false;
  if (win.isVisible()) {
    userHidden = true;
    win.hide();
    return false;
  } else {
    userHidden = false;
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

/** 通用岛窗口广播（镜像帧/步骤详情/用量等） */
export function broadcastToIsland(channel: string, payload: unknown): boolean {
  return broadcast(channel, payload);
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
     
    // 可选原生依赖：未安装时必须保持应用可用，因此不能顶部 import
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
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
    } else if (!fullscreen && !win.isVisible() && !userHidden && !win.isMinimized()) {
      win.showInactive(); // 退出全屏自动复现，但不抢焦点；用户主动隐藏时不弹回
    }
  }, 1000);
  win.on("closed", () => clearInterval(interval));
}