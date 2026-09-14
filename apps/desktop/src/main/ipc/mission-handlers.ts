/**
 * mission-handlers.ts — 任务知识库 IPC handler
 *
 * 全部 payload 主进程侧 Zod 复校，统一 { ok, data | error } 返回。
 * 能力知识库写纪律（mission-knowledge-development-plan §3.4 / §8 不变量3）：
 * capabilities 表的 IPC 写入一律只登记宪法门提案（capability_*），人工批准后
 * 由 meta-appliers 执行器落库并审计留痕；本文件不存在直写路径。
 */
import { ipcMain } from 'electron';
import {
  ISLAND_CHANNELS,
  CapabilityCreateSchema,
  CapabilityUpdateSchema,
  CapabilitySearchSchema,
  CapabilityMatchSchema,
  MissionCreateSchema,
  SubtaskStatusUpdateSchema,
  ArtifactCreateSchema,
} from '../../shared/island-contracts';
import type { CapabilityProposeResult } from '../../shared/island-contracts';
import type { MissionRepo } from '../mission-db/mission-repo';
import { getLastViolation, metaGuard } from '../meta-gate';
import type { MetaActionType, MetaAudit, MetaStore } from '../meta-gate';

export interface MissionHandlerDeps {
  repo: MissionRepo;
  audit: MetaAudit;
  experience: MetaStore;
}

let missionRegistered = false;

/** 能力卡提案的 targetId 命名空间：cap:{id}。非法字符本地拒绝，避免误触越权停用。 */
function capTargetId(id: string): string | null {
  const target = `cap:${id}`;
  return /^cap:[^;'"\\,]+$/.test(target) ? target : null;
}

type ProposeOutcome = { ok: true; data: CapabilityProposeResult } | { ok: false; error: string };

function proposeCapabilityWrite(
  deps: MissionHandlerDeps,
  action: MetaActionType,
  id: string,
  reason: string,
  payload: Record<string, unknown>,
): ProposeOutcome {
  const targetId = capTargetId(id);
  if (!targetId) return { ok: false, error: '能力卡 ID 含非法字符，宪法门提案未提交' };
  const proposal = metaGuard(deps.audit, deps.experience, action, targetId, reason, payload);
  if (!proposal) {
    return { ok: false, error: `宪法门未受理：${getLastViolation(deps.experience) ?? '元层已停用，需人工恢复'}` };
  }
  return { ok: true, data: { proposalId: proposal.id, targetId: proposal.targetId, status: proposal.status } };
}

export function registerMissionHandlers(deps: MissionHandlerDeps): void {
  if (missionRegistered) return;
  missionRegistered = true;

  // ---- 能力卡（读路径直查仓储） ----
  ipcMain.handle(ISLAND_CHANNELS.capabilityList, (_e, raw: unknown) => {
    const parsed = CapabilitySearchSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const items = deps.repo.listCapabilities(parsed.data);
      return { ok: true as const, data: items };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'list failed' };
    }
  });

  // ---- 能力卡写入：只登记宪法门提案，批准后才由执行器落库 ----
  ipcMain.handle(ISLAND_CHANNELS.capabilityCreate, (_e, raw: unknown) => {
    const parsed = CapabilityCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      return proposeCapabilityWrite(
        deps,
        'capability_upsert',
        parsed.data.id,
        '面板人工创建能力卡，需宪法门批准后生效',
        { ...parsed.data, operator: 'user_direct' },
      );
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'propose failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.capabilityUpdate, (_e, raw: unknown) => {
    const parsed = CapabilityUpdateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const d = parsed.data;
      const hasFieldEdits = d.title !== undefined || d.description !== undefined
        || d.tools !== undefined || d.precondition !== undefined
        || d.acceptance !== undefined || d.visualAnchors !== undefined;
      if (d.status === 'retired' && !hasFieldEdits) {
        return proposeCapabilityWrite(
          deps,
          'capability_disable',
          d.id,
          '面板人工退役能力卡，需宪法门批准后生效',
          { id: d.id, operator: 'user_direct' },
        );
      }
      return proposeCapabilityWrite(
        deps,
        'capability_upsert',
        d.id,
        '面板人工编辑能力卡，需宪法门批准后生效',
        { ...d, operator: 'user_direct' },
      );
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'propose failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.capabilityMatch, (_e, raw: unknown) => {
    const parsed = CapabilityMatchSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const result = deps.repo.matchCapabilities(parsed.data.missionGoal);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'match failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.capabilitySeed, () => {
    try {
      return proposeCapabilityWrite(
        deps,
        'capability_seed',
        'seed',
        '面板人工导入种子能力集，需宪法门批准后生效',
        { operator: 'user_direct' },
      );
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'propose failed' };
    }
  });

  // ---- 任务 ----
  ipcMain.handle(ISLAND_CHANNELS.missionCreate, (_e, raw: unknown) => {
    const parsed = MissionCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const result = deps.repo.createMission(parsed.data);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'create failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.missionList, () => {
    try {
      const items = deps.repo.listMissions();
      return { ok: true as const, data: items };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'list failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.missionGet, (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false as const, error: 'invalid id' };
    try {
      const result = deps.repo.getMission(id);
      if (!result) return { ok: false as const, error: 'mission not found' };
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'get failed' };
    }
  });

  // ---- 子任务 ----
  ipcMain.handle(ISLAND_CHANNELS.subtaskUpdateStatus, (_e, raw: unknown) => {
    const parsed = SubtaskStatusUpdateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      deps.repo.updateSubtaskStatus(parsed.data);
      return { ok: true as const, data: {} };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'update failed' };
    }
  });

  // ---- 产物 ----
  ipcMain.handle(ISLAND_CHANNELS.artifactCreate, (_e, raw: unknown) => {
    const parsed = ArtifactCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const result = deps.repo.createArtifact(parsed.data);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'create failed' };
    }
  });
}
