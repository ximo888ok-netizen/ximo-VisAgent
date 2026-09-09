/**
 * rows.ts — Mission 知识库的行类型（与 migrations.ts 的 DDL 逐列对应）
 *
 * 列的物理类型即行的类型：INTEGER→number、可空列→`T | null`（C4）。
 * JSON 列以字符串形态出现（*Json），解析发生在仓储内并带兜底。
 */
import type {
  CapabilityStatus,
  CapabilitySource,
  MissionOrigin,
  MissionPriority,
  MissionStatus,
  SubtaskStatus,
  ArtifactKind,
} from '@ximo-visagent/shared-types';

/** 能力卡行（与 capabilities 表逐列对应） */
export interface CapabilityRow {
  id: string;
  title: string;
  description: string;
  toolsJson: string;       // string[] 序列化
  precondition: string;
  acceptance: string;
  visualAnchorsJson: string; // string[] 序列化
  status: CapabilityStatus;
  source: CapabilitySource;
  usageCount: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 任务行（与 missions 表逐列对应） */
export interface MissionRow {
  id: string;
  goal: string;
  origin: MissionOrigin;
  priority: MissionPriority;
  status: MissionStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** 子任务行（与 subtasks 表逐列对应） */
export interface SubtaskRow {
  id: string;
  missionId: string;
  capabilityId: string | null;
  title: string;
  instruction: string;
  status: SubtaskStatus;
  order: number;
  startedAt: number | null;
  finishedAt: number | null;
  reviewNote: string;
}

/** 子任务产物行（与 mission_artifacts 表逐列对应） */
export interface MissionArtifactRow {
  id: string;
  subtaskId: string;
  kind: ArtifactKind;
  path: string;
  label: string;
  createdAt: number;
}
