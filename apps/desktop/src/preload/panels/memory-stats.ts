/**
 * panels/memory-stats.ts — 记忆与统计域 preload 绑定
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  MemoryRowPayload,
  StatsResultPayload,
} from "../../shared/island-contracts";
import { invokeOk, type PanelIpc, type SafeInvoke } from "./deps";

export type MemoryStatsPanelApi = Pick<
  IslandApi,
  "memoryList" | "memoryToggle" | "memoryDelete" | "memoryClear" | "statsGet"
>;

export function registerMemoryStatsApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): MemoryStatsPanelApi {
  return {
    async memoryList() {
      return safeInvoke<MemoryRowPayload[]>(ISLAND_CHANNELS.memoryList);
    },

    async memoryToggle(req) {
      return invokeOk(ipc, ISLAND_CHANNELS.memoryToggle, req);
    },

    async memoryDelete(req) {
      return invokeOk(ipc, ISLAND_CHANNELS.memoryDelete, req);
    },

    async memoryClear() {
      return invokeOk(ipc, ISLAND_CHANNELS.memoryClear);
    },

    async statsGet(req) {
      return safeInvoke<StatsResultPayload>(ISLAND_CHANNELS.statsGet, req ?? {});
    },
  };
}
