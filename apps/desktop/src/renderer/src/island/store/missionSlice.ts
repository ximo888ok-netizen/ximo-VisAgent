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
  /** 提交宪法门提案（capability_upsert），返回 proposalId；批准后才会落库 */
  createCapability(req: { id: string; title: string; description?: string; tools?: string[]; precondition?: string; acceptance?: string }): Promise<string | null>;
  /** 提交宪法门提案（编辑=upsert，纯退役=disable），返回 proposalId */
  updateCapability(req: { id: string; title?: string; description?: string; tools?: string[]; precondition?: string; acceptance?: string; status?: 'active' | 'retired' }): Promise<string | null>;
  matchCapabilities(missionGoal: string): Promise<void>;
  /** 提交种子导入提案，返回 proposalId（批准后生效） */
  seedCapabilities(): Promise<string | null>;

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
      // 写入已改为宪法门提案：批准后由主进程执行器落库，列表在下次加载时反映
      return res.ok ? res.data.proposalId : null;
    },

    async updateCapability(req) {
      const res = await window.islandAPI.capabilityUpdate(req);
      return res.ok ? res.data.proposalId : null;
    },

    async matchCapabilities(missionGoal) {
      set({ capMatchLoading: true });
      const res = await window.islandAPI.capabilityMatch({ missionGoal });
      set({ capMatchResult: res.ok ? res.data : null, capMatchLoading: false });
    },

    async seedCapabilities() {
      const res = await window.islandAPI.capabilitySeed();
      return res.ok ? res.data.proposalId : null;
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
