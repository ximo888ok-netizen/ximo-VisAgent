/**
 * hotkeys.ts — 全局热键注册（急停 / 快速任务输入）
 *
 * 热键注册失败必须可见：静默失效会让「急停」形同虚设。
 */
import { globalShortcut } from 'electron';
import { focusQuickInput, notify } from './tray';
import type { Store } from './config-store';
import type { Orchestrator } from './orchestrator';

export function registerHotkeys(
  configStore: Store,
  orchestrator: Orchestrator,
): void {
  // 急停热键（可配置）
  const combo = configStore.get().agent.emergencyHotkey || 'Ctrl+Alt+Q';
  const ok = globalShortcut.register(combo, () => {
    console.warn('[emergency] 全局急停触发');
    orchestrator.emergencyStopAll();
  });
  if (!ok) {
    console.warn('[main] 急停热键注册失败:', combo);
    notify('急停热键注册失败', `「${combo}」可能被其他程序占用，请到设置中更换组合`);
  }

  // 快速任务输入热键
  const quickOk = globalShortcut.register('Ctrl+Alt+D', () => focusQuickInput());
  if (!quickOk) {
    console.warn('[main] 快速输入热键注册失败');
    notify('快速输入热键注册失败', 'Ctrl+Alt+D 可能被其他程序占用');
  }
}
