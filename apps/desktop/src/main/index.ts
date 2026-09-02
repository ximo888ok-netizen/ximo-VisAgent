// 主进程入口：应用仅由「灵动岛」+ 托盘组成（原主窗口已完全移除）
import path from 'node:path';
import { app, Tray, Menu, globalShortcut } from 'electron';
import { getUiaClient } from '@desktop-agi/control-kit';
import { ZODB } from './audit-store';
import { appConfigStore } from './config-store';
import { Orchestrator } from './orchestrator';
import { initOcrCache, ocrShutdown } from './ocr';
import { createIslandWindow, getIslandWindow } from './windows/island';
import { registerIslandHandlers } from './ipc/island.handlers';
import { coerceArgs } from './island-bridge';

let tray: Tray | null = null;

const uiaClient = getUiaClient();
const auditDb = new ZODB(path.join(app.getPath('userData'), 'audit.db'));
const configStore = appConfigStore(path.join(app.getPath('userData'), 'config.json'));
const orchestrator = new Orchestrator(configStore, auditDb);

const isDev = process.env.NODE_ENV === 'development';

app.setName('Desktop AGI');

app.whenReady().then(async () => {
  try {
    await uiaClient.start();
    console.log('[main] UIA sidecar started');
  } catch (err) {
    console.error('[main] UIA sidecar start failed', err);
  }

  // OCR 语言模型后台预热到 userData（首次联网下载，不阻塞窗口启动）
  try {
    const cacheDir = path.join(app.getPath('userData'), 'tesseract-cache');
    void initOcrCache({ cacheDir })
      .then((dir) => console.log('[main] OCR cache ready:', dir))
      .catch((err) => console.error('[main] OCR cache warmup failed (将在首次识别时重试)', err));
  } catch (err) {
    console.warn('[main] OCR warmup skipped', err);
  }

  createIsland();
  createTray();
  registerHotkeys();
});

app.on('window-all-closed', () => {
  // 灵动岛常驻：仅当岛窗口也被关闭（如托盘退出）时才真正退出
  const island = getIslandWindow();
  if (island && !island.isDestroyed()) return;
  try { uiaClient.stop(); } catch { /* noop */ }
  try { auditDb.close(); } catch { /* noop */ }
  void ocrShutdown().catch(() => undefined);
  globalShortcut.unregisterAll();
  app.quit();
});

/** 灵动岛悬浮窗：透明置顶 + 独立 preload/renderer 入口 */
function createIsland() {
  const island = createIslandWindow();
  const devUrl = process.env.ELECTRON_RENDERER_URL || `http://localhost:${process.env.PORT || 5173}`;
  const prodFile = path.join(__dirname, '..', 'renderer', 'island.html');
  island.webContents.on('did-finish-load', () => console.log('[island] renderer loaded:', island.webContents.getURL()));
  island.webContents.on('render-process-gone', (_e, d) => console.error('[island] renderer crashed:', d.reason));
  if (isDev) {
    void island.loadURL(`${devUrl.replace(/\/$/, '')}/island.html`);
  } else {
    void island.loadFile(prodFile);
  }

  registerIslandHandlers({
    // 主窗口已移除：展开为无操作（island:expand 返回 false）
    getMainWindow: () => null,
    safety: {
      // Safety 层：真正中断 SendInput / 清空队列（与全局热键一致）
      emergencyStop: (reason) => {
        orchestrator.emergencyStopAll();
      },
    },
    onApprovalResult: (result) => {
      // 审批结论 → 审批中心（approvalKey 即审批 id）
      switch (result.decision) {
        case 'approved':
          orchestrator.approve(result.approvalKey);
          break;
        case 'rejected':
          orchestrator.reject(result.approvalKey, result.note ?? '用户拒绝');
          break;
        case 'revised':
          orchestrator.editAndApprove(result.approvalKey, coerceArgs(result.params ?? {}));
          break;
      }
    },
  });
}

function createTray() {
  const { nativeImage } = require('electron') as typeof import('electron');
  // 无图标文件时用程序化生成的 16x16 图标
  let icon = nativeImage.createEmpty();
  try {
    const p = path.join(__dirname, '..', 'resources', 'tray.png');
    if (require('node:fs').existsSync(p)) {
      icon = nativeImage.createFromPath(p);
    }
  } catch { /* noop */ }
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGL8z4APMDBgAqSmGgwgOQYQTWDQmoZAAAAAVHRSTlMAQIDBAYGBgoKCgwAAAA5JREFUeF7twYEAAAAAgKD9n1aaCgAAAAAAAAD8GwAAf9cCmQAAAABJRU5ErkJggg==',
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('Desktop AGI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '退出', click: () => app.quit() },
  ]));
}

function registerHotkeys() {
  const combo = configStore.get().agent.emergencyHotkey || 'Ctrl+Alt+Q';
  const ok = globalShortcut.register(combo, () => {
    console.warn('[emergency] 全局急停触发');
    orchestrator.emergencyStopAll();
  });
  if (!ok) console.warn('[main] 急停热键注册失败:', combo);
}