/**
 * sopSlice.ts — SOP 模板库状态
 */
import type { SopRowPayload } from "@shared/island-contracts";

export interface SopSliceState {
  sops: SopRowPayload[];
  sopLoading: boolean;
  sopError: string | null;
  loadSops(): Promise<void>;
  deleteSop(sopId: string): Promise<boolean>;
}

export function createSopSlice(
  set: (fn: Partial<SopSliceState> | ((s: SopSliceState) => Partial<SopSliceState>)) => void,
): SopSliceState {
  return {
    sops: [],
    sopLoading: false,
    sopError: null,

    async loadSops() {
      set({ sopLoading: true, sopError: null });
      const res = await window.islandAPI.listSops();
      if (res.ok) {
        set({ sops: res.data, sopLoading: false });
      } else {
        set({ sopError: res.error, sopLoading: false });
      }
    },

    async deleteSop(sopId) {
      // M01 修复：检查删除结果，返回成功/失败
      const delRes = await window.islandAPI.deleteSop(sopId);
      if (!delRes.ok) return false;
      const res = await window.islandAPI.listSops();
      if (res.ok) set({ sops: res.data });
      return true;
    },
  };
}
