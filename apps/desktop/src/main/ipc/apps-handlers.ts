/**
 * apps-handlers.ts — 应用目录服务 IPC handler（A-M1）
 *
 * 三通道（规划 §4.4）：apps:list / apps:icons / apps:recent。
 * handler 只做「Zod 复校 → 调用服务 → {ok,data|error}」（engineering.md §3/§5），
 * 缓存、侧车、图标文件淘汰等业务全在 app-catalog-client / app-recent-store。
 * 图标批量并发 ≤2 在客户端限流（渲染层虚拟列表滚动高频，这里天然单入口收口）。
 */
import { ipcMain } from 'electron';
import { AppsIconsSchema, AppsListSchema, ISLAND_CHANNELS } from '../../shared/island-contracts';
import type { AppCatalogService } from '../app-catalog-client';
import type { AppRecentStore } from '../app-recent-store';

export interface AppsHandlerDeps {
  catalog: Pick<AppCatalogService, 'listApps' | 'getIcons'>;
  recent: AppRecentStore;
}

let appsRegistered = false;

export function registerAppsHandlers(deps: AppsHandlerDeps): void {
  if (appsRegistered) return;
  appsRegistered = true;

  ipcMain.handle(ISLAND_CHANNELS.appsList, async (_e, raw: unknown) => {
    const parsed = AppsListSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      // listApps 内部：内存缓存命中直返；冷枚举异步、失败回空表（不抛）
      const apps = await deps.catalog.listApps(parsed.data.refresh ?? false);
      return { ok: true as const, data: apps };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'apps:list failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.appsIcons, async (_e, raw: unknown) => {
    const parsed = AppsIconsSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const icons = await deps.catalog.getIcons(parsed.data.exePaths, parsed.data.size);
      return { ok: true as const, data: icons };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'apps:icons failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.appsRecent, () => {
    try {
      return { ok: true as const, data: deps.recent.listRecent() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'apps:recent failed' };
    }
  });
}
