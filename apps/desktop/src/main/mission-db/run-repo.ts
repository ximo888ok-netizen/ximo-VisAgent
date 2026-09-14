/**
 * run-repo.ts — Mission 编排运行态仓储（mission-runner 的写入口）
 *
 * 与 mission-repo.ts 分文件：那边是面板/查询契约，这里是执行状态机专属转移。
 * DDL 仍由 migrations.ts 拥有；本文件只做 UPDATE/SELECT。
 * capabilities 表仅动 usageCount/failCount 统计列——能力卡内容写入仍只走
 * 种子脚本/宪法门（mission 计划 §3.4 / §8 不变量 3）。
 *
 * 所有状态转移带 WHERE 守卫（非法来源态改了也不生效，返回 false），
 * 状态机的闸（计划确认前绝不 running）在这里是数据库层事实，不靠调用方自觉。
 */
import type Database from 'better-sqlite3';
import type { MissionRow, SubtaskRow } from './rows';
import type { MissionRowPayload, SubtaskRowPayload } from '../../shared/schemas/mission';
import type { MissionStatus, SubtaskStatus } from '@ximo-visagent/shared-types';
import { missionRowToPayload, subtaskRowToPayload } from './mission-repo';

/** 子任务的执行终态（人工跳过也是一种终态） */
export type SubtaskTerminal = Extract<SubtaskStatus, 'done' | 'failed' | 'skipped'>;

export interface MissionRunRepo {
  getMission(id: string): MissionRowPayload | null;
  listMissionsByStatus(statuses: MissionStatus[]): MissionRowPayload[];
  listSubtasks(missionId: string): SubtaskRowPayload[];
  /** draft/planning/queued + planJson 入库 → awaiting_confirm（计划确认闸入口） */
  savePlanAwaitConfirm(missionId: string, planJson: string): boolean;
  /** awaiting_confirm → running（人工确认后才有 true） */
  confirmMission(missionId: string): boolean;
  /** paused → running（人工处置后继续排队拓扑执行） */
  resumeMission(missionId: string): boolean;
  setMissionStatus(missionId: string, status: MissionStatus): void;
  /** 派发回执：绑定审计任务 id + running + attempts+1 */
  attachTask(subtaskId: string, taskId: string): void;
  finishSubtask(subtaskId: string, status: SubtaskTerminal, reviewNote?: string): void;
  /** 人工重试：failed → pending（attempts 保留累计） */
  reopenSubtask(subtaskId: string): boolean;
  bumpCapabilityUsage(capabilityId: string | null, success: boolean): void;
}

const TERMINAL_MISSION_STATUSES: MissionStatus[] = ['completed', 'failed', 'cancelled'];

export function createMissionRunRepo(db: Database.Database): MissionRunRepo {
  const missionGet = db.prepare<unknown[], MissionRow>('SELECT * FROM missions WHERE id = ?');
  const subtaskList = db.prepare<unknown[], SubtaskRow>('SELECT * FROM subtasks WHERE missionId = ? ORDER BY "order" ASC');

  const planSave = db.prepare(
    `UPDATE missions SET planJson = @planJson, status = 'awaiting_confirm'
     WHERE id = @missionId AND status IN ('draft', 'planning', 'queued')`,
  );
  const confirm = db.prepare(
    `UPDATE missions SET status = 'running', startedAt = COALESCE(startedAt, @now)
     WHERE id = @missionId AND status = 'awaiting_confirm'`,
  );
  const resume = db.prepare(
    `UPDATE missions SET status = 'running' WHERE id = @missionId AND status = 'paused'`,
  );
  const setStatus = db.prepare(
    `UPDATE missions SET status = @status,
       startedAt = CASE WHEN @status = 'running' AND startedAt IS NULL THEN @now ELSE startedAt END,
       finishedAt = CASE WHEN @finished THEN @now ELSE finishedAt END
     WHERE id = @missionId`,
  );
  const attach = db.prepare(
    `UPDATE subtasks SET status = 'running', taskId = @taskId, attempts = attempts + 1,
       startedAt = COALESCE(startedAt, @now)
     WHERE id = @subtaskId`,
  );
  const finish = db.prepare(
    `UPDATE subtasks SET status = @status, finishedAt = @now, reviewNote = @reviewNote
     WHERE id = @subtaskId`,
  );
  const reopen = db.prepare(
    `UPDATE subtasks SET status = 'pending', startedAt = NULL, finishedAt = NULL, reviewNote = ''
     WHERE id = @subtaskId AND status = 'failed'`,
  );
  const capUsageUp = db.prepare('UPDATE capabilities SET usageCount = usageCount + 1 WHERE id = ?');
  const capFailUp = db.prepare('UPDATE capabilities SET failCount = failCount + 1 WHERE id = ?');

  function getMission(id: string): MissionRowPayload | null {
    const row = missionGet.get(id);
    return row ? missionRowToPayload(row) : null;
  }

  function listMissionsByStatus(statuses: MissionStatus[]): MissionRowPayload[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = db
      .prepare<unknown[], MissionRow>(
        `SELECT * FROM missions WHERE status IN (${placeholders}) ORDER BY createdAt ASC`,
      )
      .all(...statuses);
    return rows.map(missionRowToPayload);
  }

  function listSubtasks(missionId: string): SubtaskRowPayload[] {
    return subtaskList.all(missionId).map(subtaskRowToPayload);
  }

  return {
    getMission,
    listMissionsByStatus,
    listSubtasks,
    savePlanAwaitConfirm(missionId, planJson) {
      return planSave.run({ missionId, planJson }).changes > 0;
    },
    confirmMission(missionId) {
      return confirm.run({ missionId, now: Date.now() }).changes > 0;
    },
    resumeMission(missionId) {
      return resume.run({ missionId }).changes > 0;
    },
    setMissionStatus(missionId, status) {
      setStatus.run({
        missionId,
        status,
        now: Date.now(),
        finished: TERMINAL_MISSION_STATUSES.includes(status) ? 1 : 0,
      });
    },
    attachTask(subtaskId, taskId) {
      attach.run({ subtaskId, taskId, now: Date.now() });
    },
    finishSubtask(subtaskId, status, reviewNote) {
      finish.run({ subtaskId, status, now: Date.now(), reviewNote: reviewNote ?? '' });
    },
    reopenSubtask(subtaskId) {
      return reopen.run({ subtaskId }).changes > 0;
    },
    bumpCapabilityUsage(capabilityId, success) {
      if (!capabilityId) return;
      if (success) capUsageUp.run(capabilityId);
      else capFailUp.run(capabilityId);
    },
  };
}
