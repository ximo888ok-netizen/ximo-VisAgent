/**
 * longtask.ts — 锚定长任务聚合态 preload 绑定（A-M7）
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断（数据源在主进程 runner）。
 * 方法签名取 IslandApi 切片，不手抄（I2）。
 */
import type { IslandApi } from "../../shared/island-api";
import type { SafeInvoke } from "./deps";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type { LongTaskCheckpointSummary, LongTaskStatusPayload } from "../../shared/schemas/longtask";

export type LongTaskPanelApi = Pick<IslandApi, "longTaskStatus" | "longTaskCheckpoints">;

export function registerLongTaskApi(safeInvoke: SafeInvoke): LongTaskPanelApi {
  return {
    async longTaskStatus(req) {
      return safeInvoke<LongTaskStatusPayload>(ISLAND_CHANNELS.longtaskStatus, req);
    },
    async longTaskCheckpoints(req) {
      return safeInvoke<LongTaskCheckpointSummary[]>(ISLAND_CHANNELS.longtaskCheckpoints, req);
    },
  };
}
