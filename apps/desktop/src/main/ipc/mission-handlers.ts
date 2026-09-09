/**
 * mission-handlers.ts — 任务知识库 IPC handler
 *
 * 全部 payload 主进程侧 Zod 复校，统一 { ok, data | error } 返回。
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
import type { MissionRepo } from '../mission-db/mission-repo';
import type Database from 'better-sqlite3';
import { seedCapabilities } from '../mission-db/seed-capabilities';

export interface MissionHandlerDeps {
  db: Database.Database;
  repo: MissionRepo;
}

let missionRegistered = false;

export function registerMissionHandlers(deps: MissionHandlerDeps): void {
  if (missionRegistered) return;
  missionRegistered = true;

  // ---- 能力卡 ----
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

  ipcMain.handle(ISLAND_CHANNELS.capabilityCreate, (_e, raw: unknown) => {
    const parsed = CapabilityCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      const result = deps.repo.createCapability(parsed.data);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'create failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.capabilityUpdate, (_e, raw: unknown) => {
    const parsed = CapabilityUpdateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    try {
      deps.repo.updateCapability(parsed.data);
      return { ok: true as const, data: {} };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'update failed' };
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
      const result = seedCapabilities(deps.db);
      return { ok: true as const, data: result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'seed failed' };
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
