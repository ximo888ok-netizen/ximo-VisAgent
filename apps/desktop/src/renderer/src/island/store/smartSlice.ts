/**
 * smartSlice.ts — 智能功能状态（记忆/统计/定时/推荐/中断任务/会话）
 *
 * B-M3：定时域扩展为长期任务管理面（FR-011 四操作中的「编辑 cron / 立即跑一次」
 * 走这里，暂停·删除复用既有 toggleJob/deleteJob；FR-012 metrics 四数卡状态同域）。
 */
import type { IpcResult } from "@shared/island-api";
import type {
  MemoryRowPayload,
  StatsResultPayload,
  ScheduledJobPayload,
  SchedulerCreateRequest,
  SchedulerRunNowRequest,
  SchedulerUpdateRequest,
  RecommendResultPayload,
  InterruptedTaskInfo,
  LongTaskMetrics,
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
  createJob(req: SchedulerCreateRequest): Promise<{ ok: boolean; error?: string }>;
  toggleJob(id: string, enabled: boolean): Promise<void>;
  deleteJob(id: string): Promise<void>;
  /** B-M3：编辑 cron（返回新 nextRunAt 供即时回显） */
  updateJobCron(req: SchedulerUpdateRequest): Promise<IpcResult<{ nextRunAt: number | null }>>;
  /** B-M3：立即跑一次（复用触发链；status 供 ≤1s 回显徽标） */
  runJobNow(req: SchedulerRunNowRequest): Promise<IpcResult<{ status: 'started' | 'skipped-busy' | 'done' | 'failed' }>>;

  /** FR-012 度量聚合（B-M3 面板四数卡） */
  metrics: LongTaskMetrics | null;
  metricsLoading: boolean;
  metricsError: string | null;
  loadMetrics(): Promise<void>;
  /** 面板轮询定时器句柄（复用 longtask:status 轮询节奏；离开面板清定时器） */
  longTaskPollTimer: number | null;
  startLongTaskPoll(): void;
  stopLongTaskPoll(): void;

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
    metrics: null,
    metricsLoading: false,
    metricsError: null,
    longTaskPollTimer: null,
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

    async updateJobCron(req) {
      const res = await window.islandAPI.schedulerUpdate(req);
      // 成功后拉权威列表（cron/下次触发/历史一次到位；乐观回显与真源不打架）
      if (res.ok) await get().loadJobs();
      return res;
    },

    async runJobNow(req) {
      const res = await window.islandAPI.schedulerRunNow(req);
      if (res.ok) await get().loadJobs();
      return res;
    },

    async loadMetrics() {
      set({ metricsLoading: true, metricsError: null });
      const res = await window.islandAPI.longTaskMetrics();
      if (res.ok) set({ metrics: res.data, metricsLoading: false });
      else set({ metricsError: res.error, metricsLoading: false });
    },

    /** 面板可见期轮询（5s：job 徽标/游标推进/度量刷新；同 longtask:status 轮询纪律，不做事件推流） */
    startLongTaskPoll() {
      const existing = get().longTaskPollTimer;
      if (existing !== null) window.clearInterval(existing);
      set({
        longTaskPollTimer: window.setInterval(() => {
          void get().loadJobs();
          void get().loadMetrics();
        }, 5_000),
      });
    },

    stopLongTaskPoll() {
      const timer = get().longTaskPollTimer;
      if (timer !== null) window.clearInterval(timer);
      set({ longTaskPollTimer: null });
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
