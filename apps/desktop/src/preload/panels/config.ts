/**
 * panels/config.ts — 配置域 preload 绑定（读写配置 / 工作目录 / LLM 连通性）
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type { AppConfigPayload, TestLlmResult } from "../../shared/island-contracts";
import { invokeOk, type PanelIpc, type SafeInvoke } from "./deps";

export type ConfigPanelApi = Pick<
  IslandApi,
  "getConfig" | "updateConfig" | "pickWorkspaceDir" | "testLlmConnectivity"
>;

export function registerConfigApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): ConfigPanelApi {
  return {
    async getConfig() {
      return safeInvoke<AppConfigPayload>(ISLAND_CHANNELS.getConfig);
    },

    async updateConfig(req) {
      return invokeOk(ipc, ISLAND_CHANNELS.updateConfig, req);
    },

    async pickWorkspaceDir() {
      return safeInvoke<{ dir: string }>(ISLAND_CHANNELS.pickWorkspaceDir);
    },

    async testLlmConnectivity(which) {
      return safeInvoke<TestLlmResult>(ISLAND_CHANNELS.testLlmConnectivity, { which });
    },
  };
}
