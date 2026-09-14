/**
 * preauth.ts — 预授权作用域包 preload 绑定（A-M6）
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断（ack 的强校验在主进程）。
 * 方法签名取 IslandApi 切片，不手抄（I2）。
 */
import type { IslandApi } from "../../shared/island-api";
import type { SafeInvoke } from "./deps";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";

export type PreauthPanelApi = Pick<
  IslandApi,
  "grantCreate" | "grantAck" | "grantRevoke"
>;

export function registerPreauthApi(safeInvoke: SafeInvoke): PreauthPanelApi {
  return {
    async grantCreate(req) {
      return safeInvoke<{ grantId: string }>(ISLAND_CHANNELS.grantCreate, req);
    },
    async grantAck(req) {
      return safeInvoke<{ acked: boolean }>(ISLAND_CHANNELS.grantAck, req);
    },
    async grantRevoke(req) {
      return safeInvoke<{ revoked: boolean }>(ISLAND_CHANNELS.grantRevoke, req);
    },
  };
}
