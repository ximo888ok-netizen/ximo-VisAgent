/**
 * island-api.ts — 暴露给渲染进程的 islandAPI 类型定义。
 * 实现见 src/preload/island-preload.ts；主进程与后端 Agent 均按此接口对接。
 */
import type {
  AgentStepEvent,
  ApprovalRequest,
  ApprovalResult,
  EmergencyStopRequest,
} from "./island-contracts";
import type {
  StartTaskRequest,
  TaskStartedResult,
  TaskFinishedPayload,
  TaskStartedEvent,
  ActiveTasksPayload,
  AppConfigPayload,
  UpdateConfigRequest,
  QueryTasksRequest,
  TaskRowPayload,
  QueryAuditRequest,
  AuditRowPayload,
  ExportCsvResult,
  SopRowPayload,
  SimulateRuleResult,
  TestLlmResult,
  TestLlmWhich,
  StepDetailEvent,
  UsageEvent,
  MemoryRowPayload,
  MemoryToggleRequest,
  MemoryDeleteRequest,
  StatsResultPayload,
  StatsQueryRequest,
  ScheduledJobPayload,
  SchedulerCreateRequest,
  SchedulerToggleRequest,
  SchedulerDeleteRequest,
  SaveSopRequest,
  RunSopRequest,
  SimulateRuleRequest,
  SopExportRequest,
  SopImportRequest,
  RecommendSopRequest,
  RecommendResultPayload,
  SaveSopStepsRequest,
  ResumeInterruptedRequest,
  InterruptedTaskInfo,
  ConversationInfoPayload,
  WorldModelAddRequest,
  WorldModelSearchRequest,
  WorldModelSearchResult,
  WorldModelScanResult,
  MetaStatusResult,
  MetaPendingRequest,
  MetaPendingResult,
  MetaDecideRequest,
  MetaEnableRequest,
  PositionRowPayload,
  CreatePositionRequest,
  UpdatePositionRequest,
  OnboardingReportRowPayload,
  SearchFactCardsRequest,
  SearchFactCardsResult,
  CapabilityCardPayload,
  CapabilityCreateRequest,
  CapabilityUpdateRequest,
  CapabilitySearchRequest,
  CapabilityMatchRequest,
  CapabilityMatchResultPayload,
  MissionRowPayload,
  SubtaskRowPayload,
  MissionArtifactRowPayload,
  MissionCreateRequest,
  SubtaskStatusUpdateRequest,
  ArtifactCreateRequest,
} from "./island-contracts";

import type {
  UpdateWeChatConfigRequest,
  WeChatLoginResult,
} from "./schemas/wechat";

/** 统一 IPC 返回 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface IslandApi {
  // ---- 订阅（main -> renderer）----
  onAgentStep(cb: (event: AgentStepEvent) => void): () => void;
  onApprovalPending(cb: (request: ApprovalRequest) => void): () => void;
  /** main -> renderer：托盘/主进程请求打开指定面板 */
  onOpenPanel(cb: (mode: string) => void): () => void;
  onThemeChanged(cb: (isDark: boolean) => void): () => void;
  onTaskFinished(cb: (payload: TaskFinishedPayload) => void): () => void;
  onTaskStarted(cb: (payload: TaskStartedEvent) => void): () => void;
  onStepDetail(cb: (ev: StepDetailEvent) => void): () => void;
  onUsage(cb: (ev: UsageEvent) => void): () => void;
  onFocusQuickInput(cb: () => void): () => void;
  // ---- 原有操作 ----
  expand(): Promise<boolean>;
  emergencyStop(
    req?: EmergencyStopRequest,
  ): Promise<{ ok: boolean; error?: string }>;
  sendApprovalResult(
    result: ApprovalResult,
  ): Promise<{ ok: boolean; error?: string }>;
  getTheme(): Promise<boolean>;
  setPassthrough(enabled: boolean): void;
  resize(width: number, height: number): void;
  setKeyboardInput(active: boolean): void;

  // ---- 任务管理 ----
  startTask(
    req: StartTaskRequest,
  ): Promise<IpcResult<TaskStartedResult>>;
  cancelTask(taskId: string): Promise<{ ok: boolean; error?: string }>;
  pauseTask(taskId: string): Promise<{ ok: boolean; error?: string }>;
  resumeTask(taskId: string): Promise<{ ok: boolean; error?: string }>;
  getActiveTasks(): Promise<IpcResult<ActiveTasksPayload>>;

  // ---- 配置管理 ----
  getConfig(): Promise<IpcResult<AppConfigPayload>>;
  updateConfig(
    req: UpdateConfigRequest,
  ): Promise<{ ok: boolean; error?: string }>;

  // ---- 审计查询 ----
  queryTasks(
    req?: QueryTasksRequest,
  ): Promise<IpcResult<TaskRowPayload[]>>;
  queryAudit(
    req?: QueryAuditRequest,
  ): Promise<IpcResult<AuditRowPayload[]>>;
  exportCsv(): Promise<IpcResult<ExportCsvResult>>;
  exportJson(): Promise<IpcResult<ExportCsvResult>>;

  // ---- SOP 模板库 ----
  listSops(): Promise<IpcResult<SopRowPayload[]>>;
  saveSopFromTask(req: SaveSopRequest): Promise<IpcResult<{ id: string }>>;
  runSop(req: RunSopRequest): Promise<IpcResult<TaskStartedResult>>;
  deleteSop(sopId: string): Promise<{ ok: boolean; error?: string }>;

  // ---- 回放 / 规则模拟 / 杂项 ----
  replayImage(taskId: string, stepIndex: number): Promise<IpcResult<{ dataUrl: string }>>;
  simulateRule(req: SimulateRuleRequest): Promise<IpcResult<SimulateRuleResult>>;
  pickWorkspaceDir(): Promise<IpcResult<{ dir: string }>>;
  testLlmConnectivity(which: TestLlmWhich): Promise<IpcResult<TestLlmResult>>;

  // ---- 记忆 ----
  memoryList(): Promise<IpcResult<MemoryRowPayload[]>>;
  memoryToggle(req: MemoryToggleRequest): Promise<{ ok: boolean; error?: string }>;
  memoryDelete(req: MemoryDeleteRequest): Promise<{ ok: boolean; error?: string }>;
  memoryClear(): Promise<{ ok: boolean; error?: string }>;

  // ---- 统计 ----
  statsGet(req?: StatsQueryRequest): Promise<IpcResult<StatsResultPayload>>;

  // ---- 定时任务 ----
  schedulerList(): Promise<IpcResult<ScheduledJobPayload[]>>;
  schedulerCreate(req: SchedulerCreateRequest): Promise<IpcResult<{ id: string }>>;
  schedulerToggle(req: SchedulerToggleRequest): Promise<{ ok: boolean; error?: string }>;
  schedulerDelete(req: SchedulerDeleteRequest): Promise<{ ok: boolean; error?: string }>;

  // ---- SOP 导入导出 / 推荐 ----
  sopExport(req: SopExportRequest): Promise<IpcResult<{ json: string }>>;
  sopImport(req: SopImportRequest): Promise<IpcResult<{ id: string; name: string }>>;
  recommendSop(req: RecommendSopRequest): Promise<IpcResult<RecommendResultPayload | null>>;

  // ---- 断点续跑 / 会话 ----
  resumeInterrupted(req: ResumeInterruptedRequest): Promise<IpcResult<TaskStartedResult>>;
  listInterrupted(): Promise<IpcResult<InterruptedTaskInfo[]>>;
  conversationInfo(): Promise<IpcResult<ConversationInfoPayload>>;
  conversationClear(): Promise<{ ok: boolean; error?: string }>;

  // ---- 教学模式录制 ----
  saveSopSteps(req: SaveSopStepsRequest): Promise<IpcResult<{ id: string }>>;

  // ---- v3 P8: 世界模型 ----
  worldmodelAdd(req: WorldModelAddRequest): Promise<IpcResult<{ id: string }>>;
  worldmodelSearch(req?: WorldModelSearchRequest): Promise<IpcResult<WorldModelSearchResult>>;
  /** 快速扫描环境，让 Agent 主动熟悉并提炼事实入库 */
  worldmodelScan(): Promise<IpcResult<WorldModelScanResult>>;

  // ---- v3 P9: 元层 ----
  metaStatus(): Promise<IpcResult<MetaStatusResult>>;
  /** 元层待办：提案队列（默认待决） */
  metaPending(req?: MetaPendingRequest): Promise<IpcResult<MetaPendingResult>>;
  /** 人工批准/拒绝提案（批准后由执行器真正生效） */
  metaDecide(req: MetaDecideRequest): Promise<IpcResult<{ status: string }>>;
  /** 人工恢复/停用元层 */
  metaEnable(req: MetaEnableRequest): Promise<IpcResult<MetaStatusResult>>;

  // ---- 任务知识库（Mission / Capability）----
  /** 能力卡列表（含搜索） */
  capabilityList(req?: CapabilitySearchRequest): Promise<IpcResult<CapabilityCardPayload[]>>;
  /** 创建能力卡 */
  capabilityCreate(req: CapabilityCreateRequest): Promise<IpcResult<{ id: string }>>;
  /** 更新能力卡 */
  capabilityUpdate(req: CapabilityUpdateRequest): Promise<IpcResult<Record<string, never>>>;
  /** 能力卡匹配（给定任务目标，返回候选） */
  capabilityMatch(req: CapabilityMatchRequest): Promise<IpcResult<CapabilityMatchResultPayload>>;
  /** 重新导入种子能力集 */
  capabilitySeed(): Promise<IpcResult<{ imported: number; skipped: number }>>;
  /** 创建任务（含子任务分解） */
  missionCreate(req: MissionCreateRequest): Promise<IpcResult<{ id: string }>>;
  /** 任务列表 */
  missionList(): Promise<IpcResult<MissionRowPayload[]>>;
  /** 获取单个任务（含子任务 + 产物） */
  missionGet(id: string): Promise<IpcResult<{ mission: MissionRowPayload; subtasks: Array<SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] }> }>>;
  /** 更新子任务状态 */
  subtaskUpdateStatus(req: SubtaskStatusUpdateRequest): Promise<IpcResult<Record<string, never>>>;
  /** 登记子任务产物 */
  artifactCreate(req: ArtifactCreateRequest): Promise<IpcResult<{ id: string }>>;

  // ---- 员工域（M1 数据底座）----
  employeeListPositions(): Promise<IpcResult<PositionRowPayload[]>>;
  employeeGetPosition(id: string): Promise<IpcResult<PositionRowPayload>>;
  employeeCreatePosition(req: CreatePositionRequest): Promise<IpcResult<{ id: string }>>;
  employeeUpdatePosition(req: { id: string } & UpdatePositionRequest): Promise<IpcResult<Record<string, never>>>;
  employeeDeletePosition(id: string): Promise<IpcResult<Record<string, never>>>;
  employeeSearchFactCards(req?: SearchFactCardsRequest): Promise<IpcResult<SearchFactCardsResult>>;
  employeeListReports(positionId?: string): Promise<IpcResult<OnboardingReportRowPayload[]>>;
  employeeGetReport(id: string): Promise<IpcResult<OnboardingReportRowPayload>>;
  employeeSaveReport(req: { id: string; positionId: string; reportJson?: string; questionsJson?: string; lastCursorJson?: string; coverage?: number; status?: string }): Promise<IpcResult<Record<string, never>>>;
  employeeConfirmReport(req: { id: string; positionId: string }): Promise<IpcResult<{ confirmed: number }>>;
  employeeStartOnboarding(req: { positionId: string; skipCodebase?: boolean }): Promise<IpcResult<{ positionId: string }>>;
  onEmployeeOnboardingProgress(cb: (ev: { stage: string; detail: string }) => void): () => void;

  // ---- 微信 Bot 通讯渠道（扫码登录）----
  /** 更新微信 Bot 配置（落库 + 重连） */
  wechatUpdateConfig(req: UpdateWeChatConfigRequest): Promise<{ ok: boolean; error?: string }>;
  /** 发起扫码登录（启动 Bot 生成二维码） */
  wechatLogin(): Promise<IpcResult<WeChatLoginResult>>;
  /** 登出微信 */
  wechatLogout(): Promise<{ ok: boolean; error?: string }>;
  /** 订阅二维码数据（前端渲染为图片） */
  onWeChatQr(cb: (data: { qrCode: string }) => void): () => void;
  /** 订阅扫码状态变化 */
  onWeChatScanStatus(cb: (ev: { status: string }) => void): () => void;
  /** 订阅登录成功 */
  onWeChatLoginSuccess(cb: (ev: { user: string }) => void): () => void;
  /** 订阅登出通知 */
  onWeChatLogout(cb: () => void): () => void;
  /** 订阅微信 Bot 连接状态变化 */
  onWeChatStatus(cb: (ev: { connected: boolean; error?: string }) => void): () => void;
  /** 订阅收到的微信消息 */
  onWeChatMessage(cb: (msg: {
    msgId: string; fromWxid: string; fromNickname: string;
    type: string; content: string; isGroup: boolean; groupId?: string;
    timestamp: number;
  }) => void): () => void;
}
