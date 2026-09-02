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
  PanelMode,
  StartTaskRequest,
  TaskStartedResult,
  TaskFinishedPayload,
  AppConfigPayload,
  UpdateConfigRequest,
  QueryTasksRequest,
  TaskRowPayload,
  QueryAuditRequest,
  AuditRowPayload,
  ExportCsvResult,
} from "./island-contracts";

/** 统一 IPC 返回 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface IslandApi {
  // ---- 订阅（main -> renderer）----
  onAgentStep(cb: (event: AgentStepEvent) => void): () => void;
  onApprovalPending(cb: (request: ApprovalRequest) => void): () => void;
  onThemeChanged(cb: (isDark: boolean) => void): () => void;
  onTaskFinished(cb: (payload: TaskFinishedPayload) => void): () => void;

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
}
