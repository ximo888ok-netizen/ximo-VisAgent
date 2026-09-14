/**
 * apps.ts — 应用目录服务 preload 绑定（A-M1）
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断。
 * 方法签名取 IslandApi 切片，不再手抄（I2）。
 */
import type { IslandApi } from "../../shared/island-api";
import type { SafeInvoke } from "./deps";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type { AppEntry, AppIconPayload } from "../../shared/schemas/longtask";

export type AppsPanelApi = Pick<
  IslandApi,
  "listApps" | "getAppIcons" | "listRecentApps"
>;

export function registerAppsApi(safeInvoke: SafeInvoke): AppsPanelApi {
  return {
    async listApps(req) {
      return safeInvoke<AppEntry[]>(ISLAND_CHANNELS.appsList, req ?? {});
    },
    async getAppIcons(req) {
      return safeInvoke<AppIconPayload[]>(ISLAND_CHANNELS.appsIcons, req);
    },
    async listRecentApps() {
      return safeInvoke<AppEntry[]>(ISLAND_CHANNELS.appsRecent);
    },
  };
}
