/**
 * aura-handlers.ts — 边框窗口的 IPC（只读状态 + 强度设置）
 *
 * 边框窗口本身只被允许问「现在是什么状态」和「我该怎么画」，
 * 因此这里不放任何任务控制、配置写入或元层通道。
 */
import { ipcMain } from 'electron';
import { ISLAND_CHANNELS } from '../../shared/island-channels';
import { currentAuraFrame } from '../windows/aura';
import type { AuraFrame } from '../../shared/aura-contracts';

let registered = false;

export function registerAuraHandlers(): void {
  if (registered) return;
  registered = true;

  // 新显示器接入后窗口会被重建，渲染层起来时需要补一次当前状态
  ipcMain.handle(ISLAND_CHANNELS.auraGet, (): { ok: true; data: AuraFrame | null } => (
    { ok: true as const, data: currentAuraFrame() }
  ));
}
