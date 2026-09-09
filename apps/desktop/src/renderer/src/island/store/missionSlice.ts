/**
 * missionSlice.ts — 任务知识库状态（能力卡 + 任务）
 */
import type {
  CapabilityCardPayload,
  CapabilitySearchRequest,
  CapabilityMatchResultPayload,
  MissionRowPayload,
  SubtaskRowPayload,
  MissionArtifactRowPayload,
  MissionCreateRequest,
  SubtaskStatusUpdateRequest,
  ArtifactCreateRequest,
} from '@shared/island-contracts';

export interface MissionDetailPayload {
  mission: MissionRowPayload;
  subtasks: Array<SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] }>;
}

export interface MissionSliceState {
  // ---- 能力卡 ----
  capabilities: CapabilityCardPayload[];
  capabilitiesLoading: boolean;
  capMatchResult: CapabilityMatchResultPayload | null;
  capMatchLoading: boolean;

  // ---- 任务 ----
  missions: MissionRowPayload[];
  missionsLoading: boolean;
  missionDetail: MissionDetailPayload | null;
  missionDetailLoading: boolean;

  // ---- actions ----
  loadCapabilities(req?: CapabilitySearchRequest): Promise<void>;
  createCapability(req: { id: string; title: string; description?: string; tools?: string[]; precondition?: string; acceptance?: string }): Promise<boolean>;
  updateCapability(req: { id: string; title?: string; description?: string; tools?: string[]; precondition?: string; acceptance?: string; status?: 'active' | 'retired' }): Promise<boolean>;
  matchCapabilities(missionGoal: string): Promise<void>;
  seedCapabilities(): Promise<{ imported: number; skipped: number }>;

  loadMissions(): Promise<void>;
  loadMissionDetail(id: string): Promise<void>;
  createMission(req: MissionCreateRequest): Promise<string | null>;
  updateSubtaskStatus(req: SubtaskStatusUpdateRequest): Promise<boolean>;
  createArtifact(req: ArtifactCreateRequest): Promise<string | null>;
}

export function createMissionSlice(
  set: (fn: Partial<MissionSliceState> | ((s: MissionSliceState) => Partial<MissionSliceState>)) => void,
): MissionSliceState {
  return {
    capabilities: [],
    capabilitiesLoading: false,
    capMatchResult: null,
    capMatchLoading: false,
    missions: [],
    missionsLoading: false,
    missionDetail: null,
    missionDetailLoading: false,

    async loadCapabilities(req) {
      set({ capabilitiesLoading: true });
      const res = await window.islandAPI.capabilityList(req ?? {});
      if (res.ok) {
        set({ capabilities: res.data, capabilitiesLoading: false });
      } else {
        set({ capabilitiesLoading: false });
      }
    },

    async createCapability(req) {
      const res = await window.islandAPI.capabilityCreate({
        id: req.id,
        title: req.title,
        description: req.description ?? '',
        tools: req.tools ?? [],
        precondition: req.precondition ?? '',
        acceptance: req.acceptance ?? '',
        visualAnchors: [],
      });
      if (!res.ok) return false;
      // 刷新列表
      const list = await window.islandAPI.capabilityList({});
      if (list.ok) set({ capabilities: list.data });
      return true;
    },

    async updateCapability(req) {
      const res = await window.islandAPI.capabilityUpdate(req);
      if (!res.ok) return false;
      // 刷新列表
      const list = await window.islandAPI.capabilityList({});
      if (list.ok) set({ capabilities: list.data });
      return true;
    },

    async matchCapabilities(missionGoal) {
      set({ capMatchLoading: true });
      const res = await window.islandAPI.capabilityMatch({ missionGoal });
      set({ capMatchResult: res.ok ? res.data : null, capMatchLoading: false });
    },

    async seedCapabilities() {
      const res = await window.islandAPI.capabilitySeed();
      // 刷新列表
      const list = await window.islandAPI.capabilityList({});
      if (list.ok) set({ capabilities: list.data });
      return res.ok ? res.data : { imported: 0, skipped: 0 };
    },

    async loadMissions() {
      set({ missionsLoading: true });
      const res = await window.islandAPI.missionList();
      set({ missions: res.ok ? res.data : [], missionsLoading: false });
    },

    async loadMissionDetail(id) {
      set({ missionDetailLoading: true });
      const res = await window.islandAPI.missionGet(id);
      set({ missionDetail: res.ok ? res.data : null, missionDetailLoading: false });
    },

    async createMission(req) {
      const res = await window.islandAPI.missionCreate(req);
      if (!res.ok) return null;
      // 刷新列表
      const list = await window.islandAPI.missionList();
      if (list.ok) set({ missions: list.data });
      return res.data.id;
    },

    async updateSubtaskStatus(req) {
      const res = await window.islandAPI.subtaskUpdateStatus(req);
      if (!res.ok) return false;
      // 刷新详情（如果有选中的任务）
      return true;
    },

    async createArtifact(req) {
      const res = await window.islandAPI.artifactCreate(req);
      if (!res.ok) return null;
      return res.data.id;
    },
  };
}
