/**
 * island-loader.ts — 岛窗口的加载与自愈（dev/prod 入口、崩溃重载、splash 握手）
 *
 * 与 windows/island.ts 的分工：那里管窗口几何与显隐，这里只管「内容怎么装进去」。
 */
import path from 'node:path';
import { createIslandWindow } from './island';
import { updateSplashStage, closeSplash } from './splash';
import { attachRendererDiagnostics } from '../diagnostics';

const isDev = process.env.NODE_ENV === 'development';

export function loadIslandWindow(): void {
  const island = createIslandWindow();
  const devUrl = process.env.ELECTRON_RENDERER_URL || `http://localhost:${process.env.PORT || 5173}`;
  const prodFile = path.join(__dirname, '..', 'renderer', 'island.html');
  island.webContents.on('did-finish-load', () => {
    console.log('[island] renderer loaded:', island.webContents.getURL());
    // 岛首帧就绪 → 进度打满并淡出 splash（崩溃重载时会再次触发，closeSplash 对已销毁窗口是 no-op）
    updateSplashStage('就绪', 1);
    setTimeout(() => closeSplash(), 300);
  });
  attachRendererDiagnostics('island', island.webContents);
  island.webContents.on('render-process-gone', (_e, d) => {
    console.error('[island] renderer crashed:', d.reason);
    // P1-6 修复：渲染进程崩溃后自动重载，避免灵动岛永久白屏
    if (d.reason !== 'clean-exit' && !island.isDestroyed()) {
      setTimeout(() => {
        if (!island.isDestroyed()) island.webContents.reload();
      }, 500);
    }
  });
  if (isDev) {
    void island.loadURL(`${devUrl.replace(/\/$/, '')}/island.html`);
  } else {
    void island.loadFile(prodFile);
  }
}
