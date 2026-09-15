/**
 * panels/scheduler.ts — 定时任务域 preload 绑定
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type { ScheduledJobPayload } from "../../shared/island-contracts";
import { invokeOk, type PanelIpc, type SafeInvoke } from "./deps";

export type SchedulerPanelApi = Pick<
  IslandApi,
  "schedulerList" | "schedulerCreate" | "schedulerToggle" | "schedulerDelete" | "schedulerUpdate" | "schedulerRunNow"
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

    // B-M3 管理面板：编辑 cron / 立即跑一次（带 data 回显，走 safeInvoke 透传 {ok,data|error}）
    async schedulerUpdate(req) {
      return safeInvoke<{ nextRunAt: number | null }>(ISLAND_CHANNELS.schedulerUpdate, req);
    },

    async schedulerRunNow(req) {
      return safeInvoke<{ status: "started" | "skipped-busy" | "done" | "failed" }>(
        ISLAND_CHANNELS.schedulerRunNow,
        req,
      );
    },
  };
}
