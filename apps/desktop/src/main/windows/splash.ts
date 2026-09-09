/**
 * windows/splash.ts — 启动动画窗口（一次性，生命期 ~2s）
 *
 * 视觉上是「岛在苏醒」：与灵动岛同位置、同尺寸（共用 getIslandInitialBounds，
 * 含用户持久化的位置/宽度）、同主题（nativeTheme 经 URL 参数传入），
 * 岛首帧就绪后与真岛同几何重叠，交接即无缝变身。
 *
 * 其余设计约束：
 * 1. 进度锚点是主进程真实启动节点（存储→自定义工具→感知服务→岛就绪），
 *    不是匀速假进度——假进度违背 E5"打点必须闭环"的项目哲学；
 * 2. 不走 IPC 通道推阶段：splash 无交互且生命期极短，为它扩 preload/契约
 *    违背简洁优先（IPC 四步铁律面向业务面板），主进程对自有窗口的
 *    executeJavaScript 是内部信任调用（字符串来自代码常量，非用户输入）；
 * 3. 8s 兜底关闭：岛渲染失败（did-finish-load 不来）时 splash 不能永挂，
 *    强制关闭并留警告（失败必须可见，E1）。
 */
import path from 'node:path';
import { BrowserWindow, nativeTheme } from 'electron';
import { getIslandInitialBounds, ISLAND_COLLAPSED_HEIGHT } from './island';

/** 兜底生命期：覆盖 sidecar 启动 + 岛首帧的最坏情况，又不至于挂太久 */
const MAX_LIFETIME_MS = 8000;

let splash: BrowserWindow | null = null;
/** 页面未 ready 时缓存的最新阶段（did-finish-load 后补投） */
let pendingStage: { text: string; ratio: number } | null = null;
let loaded = false;

function entry(): string {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (process.env.NODE_ENV === 'development' && url) return `${url.replace(/\/$/, '')}/splash.html`;
  return path.join(__dirname, '..', 'renderer', 'splash.html');
}

export function showSplash(): void {
  if (splash) return;
  // 与岛同位同尺寸：x/y/宽度取岛的初始边界（含持久化布局），高度恒为收起态 64
  const b = getIslandInitialBounds();
  splash = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: ISLAND_COLLAPSED_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 与岛同层级：岛创建后叠在 splash 之上（同级后建者在上），首帧就绪即完成视觉接管
  splash.setAlwaysOnTop(true, 'screen-saver');
  splash.webContents.on('did-finish-load', () => {
    loaded = true;
    if (pendingStage) applyStage(pendingStage);
  });
  // 主题经 URL 参数传入：静态页无 preload，不为此扩 IPC 契约
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const url = entry();
  if (url.startsWith('http')) void splash.loadURL(`${url}?theme=${theme}`);
  else void splash.loadFile(url, { query: { theme } });
  splash.once('ready-to-show', () => splash?.showInactive());
  setTimeout(() => closeSplash(true), MAX_LIFETIME_MS);
}

/** 推进到下一启动阶段：text 为面向用户的中文短语，ratio 为 0-1 真实进度 */
export function updateSplashStage(text: string, ratio: number): void {
  if (!splash) return;
  const stage = { text, ratio };
  if (!loaded) {
    pendingStage = stage;
    return;
  }
  applyStage(stage);
}

function applyStage(stage: { text: string; ratio: number }): void {
  const win = splash;
  if (!win || win.isDestroyed()) return;
  void win.webContents
    .executeJavaScript(`window.__splashStage && window.__splashStage(${JSON.stringify(stage.text)}, ${stage.ratio});`)
    .catch(() => undefined);
}

export function closeSplash(fromTimeout = false): void {
  const win = splash;
  splash = null;
  if (!win || win.isDestroyed()) return;
  if (fromTimeout) console.warn('[splash] 达到最大生命期强制关闭（岛可能未完成加载）');
  // 淡出兜底（岛若已接管则 splash 在其下方，淡出不可见；用户调低岛不透明度时避免残影）
  void win.webContents
    .executeJavaScript('window.__splashOut && window.__splashOut();')
    .catch(() => undefined)
    .finally(() => setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 320));
}
