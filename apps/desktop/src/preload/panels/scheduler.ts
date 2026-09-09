/**
 * panels/scheduler.ts — 定时任务域 preload 绑定
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type { ScheduledJobPayload } from "../../shared/island-contracts";
import { invokeOk, type PanelIpc, type SafeInvoke } from "./deps";

export type SchedulerPanelApi = Pick<
  IslandApi,
  "schedulerList" | "schedulerCreate" | "schedulerToggle" | "schedulerDelete"
>;

export function registerSchedulerApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): SchedulerPanelApi {
  return {
    async schedulerList() {
      return safeInvoke<ScheduledJobPayload[]>(ISLAND_CHANNELS.schedulerList);
    },

    async schedulerCreate(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.schedulerCreate, req);
    },

    async schedulerToggle(req) {
      return invokeOk(ipc, ISLAND_CHANNELS.schedulerToggle, req);
    },

    async schedulerDelete(req) {
      return invokeOk(ipc, ISLAND_CHANNELS.schedulerDelete, req);
    },
  };
}
