/**
 * mission.ts — 任务知识库 preload 绑定
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断。
 * 方法签名取 IslandApi 切片，不再手抄（I2）。
 */
import type { IslandApi } from "../../shared/island-api";
import type { SafeInvoke } from "./deps";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  CapabilityCardPayload,
  CapabilityMatchResultPayload,
  MissionRowPayload,
  SubtaskRowPayload,
  MissionArtifactRowPayload,
} from "../../shared/island-contracts";

export type MissionPanelApi = Pick<
  IslandApi,
  | "capabilityList"
  | "capabilityCreate"
  | "capabilityUpdate"
  | "capabilityMatch"
  | "capabilitySeed"
  | "missionCreate"
  | "missionList"
  | "missionGet"
  | "subtaskUpdateStatus"
  | "artifactCreate"
>;

export function registerMissionApi(safeInvoke: SafeInvoke): MissionPanelApi {
  return {
    async capabilityList(req) {
      return safeInvoke<CapabilityCardPayload[]>(ISLAND_CHANNELS.capabilityList, req ?? {});
    },
    async capabilityCreate(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.capabilityCreate, req);
    },
    async capabilityUpdate(req) {
      return safeInvoke<Record<string, never>>(ISLAND_CHANNELS.capabilityUpdate, req);
    },
    async capabilityMatch(req) {
      return safeInvoke<CapabilityMatchResultPayload>(ISLAND_CHANNELS.capabilityMatch, req);
    },
    async capabilitySeed() {
      return safeInvoke<{ imported: number; skipped: number }>(ISLAND_CHANNELS.capabilitySeed);
    },
    async missionCreate(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.missionCreate, req);
    },
    async missionList() {
      return safeInvoke<MissionRowPayload[]>(ISLAND_CHANNELS.missionList);
    },
    async missionGet(id) {
      return safeInvoke<{
        mission: MissionRowPayload;
        subtasks: Array<SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] }>;
      }>(ISLAND_CHANNELS.missionGet, id);
    },
    async subtaskUpdateStatus(req) {
      return safeInvoke<Record<string, never>>(ISLAND_CHANNELS.subtaskUpdateStatus, req);
    },
    async artifactCreate(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.artifactCreate, req);
    },
  };
}
