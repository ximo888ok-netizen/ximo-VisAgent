/**
 * panels/sop.ts — SOP 域 preload 绑定（模板 CRUD / 运行 / 回放 / 规则模拟 / 导入导出 / 推荐 / 教学录制）
 */
import type { IslandApi } from "../../shared/island-api";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  RecommendResultPayload,
  SimulateRuleResult,
  SopRowPayload,
  TaskStartedResult,
} from "../../shared/island-contracts";
import { invokeOk, type PanelIpc, type SafeInvoke } from "./deps";

export type SopPanelApi = Pick<
  IslandApi,
  | "listSops"
  | "saveSopFromTask"
  | "runSop"
  | "deleteSop"
  | "replayImage"
  | "simulateRule"
  | "sopExport"
  | "sopImport"
  | "recommendSop"
  | "saveSopSteps"
>;

export function registerSopApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): SopPanelApi {
  return {
    async listSops() {
      return safeInvoke<SopRowPayload[]>(ISLAND_CHANNELS.listSops);
    },

    async saveSopFromTask(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.saveSopFromTask, req);
    },

    async runSop(req) {
      return safeInvoke<TaskStartedResult>(ISLAND_CHANNELS.runSop, req);
    },

    async deleteSop(sopId) {
      return invokeOk(ipc, ISLAND_CHANNELS.deleteSop, { sopId });
    },

    async replayImage(taskId, stepIndex) {
      return safeInvoke<{ dataUrl: string }>(ISLAND_CHANNELS.replayImage, { taskId, stepIndex });
    },

    async simulateRule(req) {
      return safeInvoke<SimulateRuleResult>(ISLAND_CHANNELS.simulateRule, req);
    },

    async sopExport(req) {
      return safeInvoke<{ json: string }>(ISLAND_CHANNELS.sopExport, req);
    },

    async sopImport(req) {
      return safeInvoke<{ id: string; name: string }>(ISLAND_CHANNELS.sopImport, req);
    },

    async recommendSop(req) {
      return safeInvoke<RecommendResultPayload | null>(ISLAND_CHANNELS.recommendSop, req);
    },

    async saveSopSteps(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.saveSopSteps, req);
    },
  };
}
