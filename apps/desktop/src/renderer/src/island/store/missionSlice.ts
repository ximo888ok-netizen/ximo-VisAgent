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
  MissionResolveDecision,
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
  /** 本次会话内被「驳回」（停等不执行）的计划确认卡所属 mission id；无主进程驳回通道，仅本地收卡 */
  planDismissedIds: string[];

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
  /** 计划确认闸（mission-confirm）：成功返回 null，失败返回主进程闸拒绝原因（绝不误启动） */
  confirmMission(missionId: string): Promise<string | null>;
  /** 暂停 Mission 的人工处置（mission-resolve）：成功返回 null，失败返回原因 */
  resolveMission(missionId: string, decision: MissionResolveDecision): Promise<string | null>;
  /** 驳回＝本次会话收卡停等：主进程暂无 awaiting_confirm→cancelled 通道，Mission 保持待确认绝不派发 */
  dismissPlanConfirm(missionId: string): void;
  restorePlanConfirm(missionId: string): void;
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
    planDismissedIds: [],

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

    async confirmMission(missionId) {
      const res = await window.islandAPI.missionConfirm({ missionId });
      if (!res.ok) return res.error;
      // 确认闸已过（awaiting_confirm → running）：刷新列表与详情，确认卡随之退役
      const list = await window.islandAPI.missionList();
      const detail = await window.islandAPI.missionGet(missionId);
      set((s) => ({
        missions: list.ok ? list.data : s.missions,
        missionDetail: detail.ok ? detail.data : s.missionDetail,
        planDismissedIds: s.planDismissedIds.filter((id) => id !== missionId),
      }));
      return null;
    },

    async resolveMission(missionId, decision) {
      const res = await window.islandAPI.missionResolve({ missionId, decision });
      if (!res.ok) return res.error;
      const list = await window.islandAPI.missionList();
      const detail = await window.islandAPI.missionGet(missionId);
      set((s) => ({
        missions: list.ok ? list.data : s.missions,
        missionDetail: detail.ok ? detail.data : s.missionDetail,
      }));
      return null;
    },

    dismissPlanConfirm(missionId) {
      set((s) => ({
        planDismissedIds: s.planDismissedIds.includes(missionId)
          ? s.planDismissedIds
          : [...s.planDismissedIds, missionId],
      }));
    },

    restorePlanConfirm(missionId) {
      set((s) => ({ planDismissedIds: s.planDismissedIds.filter((id) => id !== missionId) }));
    },
  };
}
