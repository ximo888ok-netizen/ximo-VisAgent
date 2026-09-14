// Mission / Subtask / Artifact 类型定义（任务执行子系统）
// zod schema 正源在 apps/desktop/src/shared/schemas/mission.ts

/** 任务优先级 */
export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent';

/** 任务来源 */
export type MissionOrigin = 'manual' | 'scheduled' | 'sop' | 'api';

/** 子任务状态机 */
export type SubtaskStatus =
  | 'pending'        // 尚未开始
  | 'running'        // 正在执行
  | 'awaiting_review' // 等待人工确认
  | 'done'           // 已完成
  | 'failed'         // 执行失败
  | 'skipped';       // 用户跳过

/** 子任务产物类型 */
export type ArtifactKind = 'file' | 'screenshot' | 'data' | 'text';

/** 子任务风险预估（规划侧标注，执行侧以 SafetyClassifier 为准） */
export type SubtaskRisk = 'L0' | 'L1' | 'L2' | 'L3';

/** 任务整体状态 */
export type MissionStatus =
  | 'draft'          // 任务编辑中，尚未入队
  | 'planning'       // 规划中（能力匹配/子任务分解进行）
  | 'queued'         // 已入队等待执行
  | 'awaiting_confirm' // 计划已入库，等待人工确认（确认闸，不可跳过）
  | 'running'        // 正在执行（有子任务在 running）
  | 'paused'         // 用户暂停 / 子任务失败等待人工决定
  | 'completed'      // 全部子任务 done
  | 'failed'         // 有子任务 failed 且无法继续
  | 'cancelled';     // 用户取消

/** 子任务产物 */
export interface MissionArtifact {
  id: string;
  subtaskId: string;
  kind: ArtifactKind;
  path: string;               // 文件路径或标识
  label: string;              // 人类可读标签
  contentHash?: string | null; // file 类产物的内容指纹（下游消费前复核）
  stale?: boolean;            // hash 不匹配（文件被外部改动）时标 stale
  createdAt: number;
}

/** 子任务 */
export interface Subtask {
  id: string;
  missionId: string;
  capabilityId: string | null; // 关联能力卡，null 表示待匹配
  title: string;
  instruction: string;         // 给 Agent 的自然语言指令
  status: SubtaskStatus;
  order: number;               // 执行序号
  dependsOn?: string[];        // DAG 依赖（兄弟子任务 id）
  risk?: SubtaskRisk | null;   // 规划侧风险预估
  attempts?: number;           // 已派发次数（人工重试计数）
  taskId?: string | null;      // 最近一次派发的审计库任务 id
  startedAt: number | null;
  finishedAt: number | null;
  reviewNote: string;          // 审核备注
  // 关联产物（join 出来，不在 subtasks 表中直接存储）
  artifacts?: MissionArtifact[];
}

/** 任务 */
export interface Mission {
  id: string;
  goal: string;                // 用户原始目标
  origin: MissionOrigin;
  priority: MissionPriority;
  status: MissionStatus;
  planJson?: string | null;    // 规划产物快照（zod 校验后入库）
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  // 关联子任务（join 出来，不在 missions 表中直接存储）
  subtasks?: Subtask[];
}
