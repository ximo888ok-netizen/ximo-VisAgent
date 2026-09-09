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

/** 任务整体状态 */
export type MissionStatus =
  | 'draft'          // 任务编辑中，尚未入队
  | 'queued'         // 已入队等待执行
  | 'running'        // 正在执行（有子任务在 running）
  | 'paused'         // 用户暂停
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
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  // 关联子任务（join 出来，不在 missions 表中直接存储）
  subtasks?: Subtask[];
}
