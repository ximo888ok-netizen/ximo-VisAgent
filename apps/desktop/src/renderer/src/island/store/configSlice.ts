/**
 * configSlice.ts — 配置管理状态 slice
 */
import type { AppConfigPayload, UpdateConfigRequest } from "@shared/island-contracts";

export interface ConfigSliceState {
  config: AppConfigPayload | null;
  configLoading: boolean;
  configError: string | null;
  loadConfig(): Promise<void>;
  saveConfig(req: UpdateConfigRequest): Promise<{ ok: boolean; error?: string }>;
}

export function createConfigSlice(
  set: (fn: Partial<ConfigSliceState> | ((s: ConfigSliceState) => Partial<ConfigSliceState>)) => void,
  _get: () => ConfigSliceState,
): ConfigSliceState {
  return {
    config: null,
    configLoading: false,
    configError: null,

    async loadConfig() {
      set({ configLoading: true, configError: null });
      const res = await window.islandAPI.getConfig();
      if (res.ok) {
        set({ config: res.data, configLoading: false });
      } else {
        set({ configError: res.error, configLoading: false });
      }
    },

    async saveConfig(req) {
      const res = await window.islandAPI.updateConfig(req);
      if (res.ok) {
        // 重新拉取全量配置，确保 UI 同步
        await _get().loadConfig();
      }
      return res;
    },
  };
}
