/**
 * island-preload-v3.ts — 世界模型/宪法门的 preload 绑定（从 island-preload-panels.ts 拆出）
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断；单独成文件以守住 300 行上限。
 * 方法签名取 IslandApi 切片，不再手抄（I2）。
 */
import type { IslandApi, IpcResult } from "../shared/island-api";
import { ISLAND_CHANNELS } from "../shared/island-contracts";
import type {
  MetaPendingResult,
  MetaStatusResult,
  WorldModelScanResult,
  WorldModelSearchResult,
} from "../shared/island-contracts";

type SafeInvoke = <T>(channel: string, arg?: unknown) => Promise<IpcResult<T>>;

export type V3PanelApiMethods = Pick<
  IslandApi,
  | "worldmodelAdd"
  | "worldmodelSearch"
  | "worldmodelScan"
  | "metaStatus"
  | "metaPending"
  | "metaDecide"
  | "metaEnable"
>;

/** v3 通道：世界模型 / 宪法门 */
export function registerV3PanelApi(safeInvoke: SafeInvoke): V3PanelApiMethods {
  return {
    // ---- v3 P8: 世界模型 ----
    async worldmodelAdd(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.worldmodelAdd, req);
    },
    async worldmodelSearch(req) {
      return safeInvoke<WorldModelSearchResult>(ISLAND_CHANNELS.worldmodelSearch, req ?? {});
    },
    async worldmodelScan() {
      return safeInvoke<WorldModelScanResult>(ISLAND_CHANNELS.worldmodelScan);
    },

    // ---- v3 P9: 宪法门 ----
    async metaStatus() {
      return safeInvoke<MetaStatusResult>(ISLAND_CHANNELS.metaStatus);
    },
    async metaPending(req) {
      return safeInvoke<MetaPendingResult>(ISLAND_CHANNELS.metaPending, req ?? {});
    },
    async metaDecide(req) {
      return safeInvoke<{ status: string }>(ISLAND_CHANNELS.metaDecide, req);
    },
    async metaEnable(req) {
      return safeInvoke<MetaStatusResult>(ISLAND_CHANNELS.metaEnable, req);
    },
  };
}
