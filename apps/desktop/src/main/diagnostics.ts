/**
 * diagnostics.ts — 启动自检与渲染层错误转发
 *
 * 经验教训（灵动岛空白事故）：主进程日志一切正常、`did-finish-load` 正常打出，
 * 但渲染层 preload 挂掉 → `window.xxxAPI` undefined → React 全树崩 →
 * 透明窗口画不出任何东西，且旧日志里没有任何信号。
 * 因此渲染层的 warning/error 必须转发到主进程 stdout，启动时打印窗口实况。
 */
import type { WebContents } from 'electron';
import { getIslandWindow } from './windows/island';
import { auraWindowReport } from './windows/aura';

/** 把渲染层 console 的 warning/error 转发到主进程 stdout */
export function attachRendererDiagnostics(label: string, webContents: WebContents): void {
  webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[${label}:renderer] ${message} (${sourceId}:${line})`);
  });
  webContents.on('preload-error', (_e, p, err) => console.error(`[${label}:preload-error]`, p, err.message));
}

/** 启动 2.5s 后打印岛与边框窗口实况（"看不见"时先看这行） */
export function scheduleStartupDiagnostics(isForegroundFullscreen: () => boolean): void {
  setTimeout(() => {
    const island = getIslandWindow();
    if (island && !island.isDestroyed()) {
      console.log('[diag] island', JSON.stringify({
        bounds: island.getBounds(),
        visible: island.isVisible(),
        onTop: island.isAlwaysOnTop(),
        minimized: island.isMinimized(),
      }));
    } else {
      console.log('[diag] island window missing');
    }
    console.log('[diag] aura', JSON.stringify(auraWindowReport()));
    console.log('[diag] foreground fullscreen?', isForegroundFullscreen());
  }, 2_500);
}
