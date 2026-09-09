/**
 * experienceSlice.ts — 世界模型状态
 */
import type {
  EnvFactRowPayload,
  WorldModelAddRequest,
} from "@shared/island-contracts";

export interface ExperienceSliceState {
  // 世界模型
  envFacts: EnvFactRowPayload[];
  envFactsLoading: boolean;
  envScanning: boolean;

  loadEnvFacts(query?: string): Promise<void>;
  addEnvFact(req: WorldModelAddRequest): Promise<boolean>;
  scanEnvFacts(): Promise<{ added: number; updated: number }>;
}

export function createExperienceSlice(
  set: (fn: Partial<ExperienceSliceState> | ((s: ExperienceSliceState) => Partial<ExperienceSliceState>)) => void,
): ExperienceSliceState {
  return {
    envFacts: [],
    envFactsLoading: false,
    envScanning: false,

    async loadEnvFacts(query) {
      set({ envFactsLoading: true });
      const res = await window.islandAPI.worldmodelSearch({ query });
      if (res.ok) {
        set({ envFacts: res.data.items, envFactsLoading: false });
      } else {
        set({ envFactsLoading: false });
      }
    },

    async addEnvFact(req) {
      const res = await window.islandAPI.worldmodelAdd(req);
      if (!res.ok) return false;
      // 刷新列表
      set({ envFactsLoading: true });
      const list = await window.islandAPI.worldmodelSearch({});
      if (list.ok) {
        set({ envFacts: list.data.items, envFactsLoading: false });
      } else {
        set({ envFactsLoading: false });
      }
      return true;
    },

    async scanEnvFacts() {
      set({ envScanning: true });
      const res = await window.islandAPI.worldmodelScan();
      set({ envScanning: false });
      if (!res.ok) return { added: 0, updated: 0 };
      // 刷新列表
      const list = await window.islandAPI.worldmodelSearch({});
      if (list.ok) {
        set({ envFacts: list.data.items });
      }
      return res.data;
    },
  };
}
