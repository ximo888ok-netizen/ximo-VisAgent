/**
 * smartSlice.ts — 智能功能状态（记忆/统计/定时/推荐/中断任务/会话）
 */
import type {
  MemoryRowPayload,
  StatsResultPayload,
  ScheduledJobPayload,
  RecommendResultPayload,
  InterruptedTaskInfo,
} from "@shared/island-contracts";

export interface SmartSliceState {
  memories: MemoryRowPayload[];
  memoryLoading: boolean;
  memoryError: string | null;
  loadMemories(): Promise<void>;
  toggleMemory(id: string, enabled: boolean): Promise<boolean>;
  deleteMemory(id: string): Promise<boolean>;
  clearMemories(): Promise<void>;

  stats: StatsResultPayload | null;
  statsLoading: boolean;
  statsError: string | null;
  statsDays: number;
  loadStats(days?: number): Promise<void>;
  setStatsDays(days: number): void;

  jobs: ScheduledJobPayload[];
  jobsLoading: boolean;
  jobsError: string | null;
  loadJobs(): Promise<void>;
  createJob(req: { name: string; sopId?: string; goal?: string; cron: string }): Promise<{ ok: boolean; error?: string }>;
  toggleJob(id: string, enabled: boolean): Promise<void>;
  deleteJob(id: string): Promise<void>;

  recommendation: RecommendResultPayload | null;
  recommendGoalText: string;
  setRecommendation(rec: RecommendResultPayload | null, goal: string): void;
  fetchRecommendation(goal: string): Promise<void>;

  interrupted: InterruptedTaskInfo[];
  interruptedLoading: boolean;
  loadInterrupted(): Promise<void>;
  resumeTask(taskId: string): Promise<{ ok: boolean; error?: string }>;
  dismissInterrupted(): void;

  conversationTurns: number;
  loadConversationInfo(): Promise<void>;
  clearConversation(): Promise<void>;
}

export function createSmartSlice(
  set: (fn: Partial<SmartSliceState> | ((s: SmartSliceState) => Partial<SmartSliceState>)) => void,
  get: () => SmartSliceState,
): SmartSliceState {
  return {
    memories: [],
    memoryLoading: false,
    memoryError: null,
    stats: null,
    statsLoading: false,
    statsError: null,
    statsDays: 30,
    jobs: [],
    jobsLoading: false,
    jobsError: null,
    recommendation: null,
    recommendGoalText: "",
    interrupted: [],
    interruptedLoading: false,
    conversationTurns: 0,

    async loadMemories() {
      set({ memoryLoading: true, memoryError: null });
      const res = await window.islandAPI.memoryList();
      if (res.ok) set({ memories: res.data, memoryLoading: false });
      else set({ memoryError: res.error, memoryLoading: false });
    },

    async toggleMemory(id, enabled) {
      const res = await window.islandAPI.memoryToggle({ id, enabled });
      if (res.ok) {
        set((s) => ({ memories: s.memories.map((m) => (m.id === id ? { ...m, enabled } : m)) }));
        return true;
      }
      return false;
    },

    async deleteMemory(id) {
      const res = await window.islandAPI.memoryDelete({ id });
      if (res.ok) {
        set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
        return true;
      }
      return false;
    },

    async clearMemories() {
      await window.islandAPI.memoryClear();
      set({ memories: [] });
    },

    async loadStats(days) {
      const d = days ?? get().statsDays;
      set({ statsLoading: true, statsError: null });
      const res = await window.islandAPI.statsGet({ days: d });
      if (res.ok) set({ stats: res.data, statsLoading: false });
      else set({ statsError: res.error, statsLoading: false });
    },

    setStatsDays(days) {
      set({ statsDays: days });
    },

    async loadJobs() {
      set({ jobsLoading: true, jobsError: null });
      const res = await window.islandAPI.schedulerList();
      if (res.ok) set({ jobs: res.data, jobsLoading: false });
      else set({ jobsError: res.error, jobsLoading: false });
    },

    async createJob(req) {
      const res = await window.islandAPI.schedulerCreate(req);
      if (res.ok) {
        await get().loadJobs();
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },

    async toggleJob(id, enabled) {
      await window.islandAPI.schedulerToggle({ id, enabled });
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)) }));
    },

    async deleteJob(id) {
      await window.islandAPI.schedulerDelete({ id });
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    },

    setRecommendation(rec, goal) {
      set({ recommendation: rec, recommendGoalText: goal });
    },

    async fetchRecommendation(goal) {
      const text = goal.trim();
      if (text.length < 2) {
        set({ recommendation: null, recommendGoalText: "" });
        return;
      }
      const res = await window.islandAPI.recommendSop({ goal: text });
      set({ recommendation: res.ok ? res.data : null, recommendGoalText: text });
    },

    async loadInterrupted() {
      set({ interruptedLoading: true });
      const res = await window.islandAPI.listInterrupted();
      set({ interrupted: res.ok ? res.data : [], interruptedLoading: false });
    },

    async resumeTask(taskId) {
      const res = await window.islandAPI.resumeInterrupted({ taskId });
      if (res.ok) {
        set((s) => ({ interrupted: s.interrupted.filter((t) => t.taskId !== taskId) }));
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },

    dismissInterrupted() {
      set({ interrupted: [] });
    },

    async loadConversationInfo() {
      const res = await window.islandAPI.conversationInfo();
      if (res.ok) set({ conversationTurns: res.data.turns });
    },

    async clearConversation() {
      await window.islandAPI.conversationClear();
      set({ conversationTurns: 0 });
    },
  };
}
