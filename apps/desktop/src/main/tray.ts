/**
 * tray.ts — 系统托盘与岛的唤起入口
 *
 * 托盘是唯一常驻控制面：显隐岛、快速下达任务、面板直达、批量暂停/急停、退出。
 * orchestrator 以 deps 传入（组合根接线），不在模块内取全局单例。
 */
import { app, Menu, Notification, Tray, nativeImage } from 'electron';
import { ISLAND_CHANNELS } from '../shared/island-channels';
import { showIsland, hideIsland, broadcastToIsland } from './windows/island';
import type { Orchestrator } from './orchestrator';
import trayIconPath from '../../resources/tray.png?asset';

/** Electron 只在有强引用时保住 Tray；置空会被 GC 掉导致托盘消失 */
let tray: Tray | null = null;

export function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* noop */ }
}

/** 托盘/主进程请求打开指定面板（渲染层订阅 island:open-panel） */
export function openPanel(mode: string): void {
  showIsland();
  broadcastToIsland(ISLAND_CHANNELS.openPanel, { mode, ts: Date.now() });
}

/** 唤起岛并聚焦快速任务输入 */
export function focusQuickInput(): void {
  showIsland();
  broadcastToIsland(ISLAND_CHANNELS.focusQuickInput, { ts: Date.now() });
}

export function createTray(orchestrator: Orchestrator): void {
  // 项目 logo 圆角图标（scripts/make-icons.cjs 生成；?asset 在 dev/打包下都解析为实际路径）
  let icon = nativeImage.createFromPath(trayIconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGL8z4APMDBgAqSmGgwgOQYQTWDQmoZAAAAAVHRSTlMAQIDBAYGBgoKCgwAAAA5JREFUeF7twYEAAAAAgKD9n1aaCgAAAAAAAAD8GwAAf9cCmQAAAABJRU5ErkJggg==',
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('ximo-VisAgent');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示灵动岛',
      click: () => showIsland(),
    },
    {
      label: '隐藏灵动岛',
      click: () => hideIsland(),
    },
    {
      label: '快速下达任务（Ctrl+Alt+D）',
      click: () => focusQuickInput(),
    },
    { type: 'separator' },
    {
      label: '定时任务',
      click: () => openPanel('schedule'),
    },
    {
      label: '任务统计',
      click: () => openPanel('stats'),
    },
    {
      label: '暂停所有任务',
      click: () => {
        for (const id of orchestrator.runningTaskIds) orchestrator.pauseTask(id);
        notify('已暂停', '所有运行中任务已在步骤间暂停');
      },
    },
    {
      label: '急停（Ctrl+Alt+Q）',
      click: () => {
        orchestrator.emergencyStopAll();
        notify('已急停', '所有任务已终止执行');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]));
}
