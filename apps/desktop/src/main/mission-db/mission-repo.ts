/**
 * mission-repo.ts — 任务知识库仓储
 *
 * 管理 capabilities / missions / subtasks / mission_artifacts 四张表。
 * FTS5 搜索仅用于能力卡。
 * JSON 列（toolsJson / visualAnchorsJson）在仓储边界序列化/反序列化。
 */
import type Database from 'better-sqlite3';
import type { CapabilityRow, MissionRow, SubtaskRow, MissionArtifactRow } from './rows';
import type {
  CapabilityCardPayload,
  CapabilityCreateRequest,
  CapabilityUpdateRequest,
  CapabilitySearchRequest,
} from '../../shared/schemas/capability';
import type {
  CapabilityMatchResultPayload,
  MissionRowPayload,
  SubtaskRowPayload,
  MissionArtifactRowPayload,
  MissionCreateRequest,
  SubtaskStatusUpdateRequest,
  ArtifactCreateRequest,
} from '../../shared/schemas/mission';
import type { CapabilityStatus, CapabilitySource, MissionOrigin, MissionPriority, MissionStatus, SubtaskStatus, ArtifactKind } from '@ximo-visagent/shared-types';

// ---------------------------------------------------------------------------
// 行 → Payload 转换
// ---------------------------------------------------------------------------

function capRowToPayload(row: CapabilityRow): CapabilityCardPayload {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tools: parseJsonArray(row.toolsJson),
    precondition: row.precondition,
    acceptance: row.acceptance,
    visualAnchors: parseJsonArray(row.visualAnchorsJson),
    status: row.status as CapabilityStatus,
    source: row.source as CapabilitySource,
    usageCount: row.usageCount,
    failCount: row.failCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function missionRowToPayload(row: MissionRow): MissionRowPayload {
  return {
    id: row.id,
    goal: row.goal,
    origin: row.origin as MissionOrigin,
    priority: row.priority as MissionPriority,
    status: row.status as MissionStatus,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function subtaskRowToPayload(row: SubtaskRow): SubtaskRowPayload {
  return {
    id: row.id,
    missionId: row.missionId,
    capabilityId: row.capabilityId,
    title: row.title,
    instruction: row.instruction,
    status: row.status as SubtaskStatus,
    order: row.order,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    reviewNote: row.reviewNote,
  };
}

function artifactRowToPayload(row: MissionArtifactRow): MissionArtifactRowPayload {
  return {
    id: row.id,
    subtaskId: row.subtaskId,
    kind: row.kind as ArtifactKind,
    path: row.path,
    label: row.label,
    createdAt: row.createdAt,
  };
}

function parseJsonArray(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 仓储接口
// ---------------------------------------------------------------------------

export interface MissionRepo {
  // ---- 能力卡 ----
  listCapabilities(req?: CapabilitySearchRequest): CapabilityCardPayload[];
  getCapability(id: string): CapabilityCardPayload | null;
  createCapability(req: CapabilityCreateRequest): { id: string };
  updateCapability(req: CapabilityUpdateRequest): void;
  searchCapabilitiesFTS(query: string): CapabilityCardPayload[];
  /** 简单匹配：按关键词命中 title/description 返回候选 */
  matchCapabilities(missionGoal: string): CapabilityMatchResultPayload;

  // ---- 任务 ----
  createMission(req: MissionCreateRequest): { id: string };
  listMissions(): MissionRowPayload[];
  getMission(id: string): { mission: MissionRowPayload; subtasks: Array<SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] }> } | null;

  // ---- 子任务 ----
  updateSubtaskStatus(req: SubtaskStatusUpdateRequest): void;

  // ---- 产物 ----
  createArtifact(req: ArtifactCreateRequest): { id: string };
  listArtifacts(subtaskId: string): MissionArtifactRowPayload[];

  // ---- 使用统计 ----
  incrementCapabilityUsage(id: string, success: boolean): void;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createMissionRepo(db: Database.Database): MissionRepo {
  // ---- 能力卡 prepared statements ----
  const capListAll = db.prepare<unknown[], CapabilityRow>('SELECT * FROM capabilities ORDER BY updatedAt DESC');
  const capListByStatus = db.prepare<unknown[], CapabilityRow>('SELECT * FROM capabilities WHERE status = ? ORDER BY updatedAt DESC');
  const capListBySource = db.prepare<unknown[], CapabilityRow>('SELECT * FROM capabilities WHERE source = ? ORDER BY updatedAt DESC');
  const capListByBoth = db.prepare<unknown[], CapabilityRow>('SELECT * FROM capabilities WHERE status = ? AND source = ? ORDER BY updatedAt DESC');
  const capGet = db.prepare<unknown[], CapabilityRow>('SELECT * FROM capabilities WHERE id = ?');
  const capInsert = db.prepare(
    `INSERT INTO capabilities (id, title, description, toolsJson, precondition, acceptance, visualAnchorsJson, status, source, usageCount, failCount, createdAt, updatedAt)
     VALUES (@id, @title, @description, @toolsJson, @precondition, @acceptance, @visualAnchorsJson, @status, @source, 0, 0, @createdAt, @updatedAt)`,
  );
  const capFtsInsert = db.prepare(
    `INSERT OR IGNORE INTO capability_fts (capabilityId, title, description, precondition, acceptance)
     VALUES (@capabilityId, @title, @description, @precondition, @acceptance)`,
  );
  const capFtsDelete = db.prepare('DELETE FROM capability_fts WHERE capabilityId = ?');
  const capFtsSearch = db.prepare<unknown[], CapabilityRow>(`
    SELECT c.* FROM capabilities c
    JOIN capability_fts f ON f.capabilityId = c.id
    WHERE capability_fts MATCH ?
    ORDER BY rank
    LIMIT 20
  `);
  const capMatchSearch = db.prepare<unknown[], { id: string; title: string; rank: number }>(`
    SELECT c.id, c.title, f.rank
    FROM capabilities c
    JOIN capability_fts f ON f.capabilityId = c.id
    WHERE capability_fts MATCH ? AND c.status = 'active'
    ORDER BY f.rank
    LIMIT 5
  `);
  const capUpdate = db.prepare(
    `UPDATE capabilities SET
       title = @title,
       description = @description,
       toolsJson = @toolsJson,
       precondition = @precondition,
       acceptance = @acceptance,
       visualAnchorsJson = @visualAnchorsJson,
       status = @status,
       updatedAt = @updatedAt
     WHERE id = @id`,
  );
  const capUpdateStatus = db.prepare('UPDATE capabilities SET status = ?, updatedAt = ? WHERE id = ?');
  const capIncrementUsage = db.prepare('UPDATE capabilities SET usageCount = usageCount + 1 WHERE id = ?');
  const capIncrementFail = db.prepare('UPDATE capabilities SET failCount = failCount + 1 WHERE id = ?');

  // ---- 任务 prepared statements ----
  const missionInsert = db.prepare(
    `INSERT INTO missions (id, goal, origin, priority, status, createdAt, startedAt, finishedAt)
     VALUES (@id, @goal, @origin, @priority, @status, @createdAt, NULL, NULL)`,
  );
  const missionList = db.prepare<unknown[], MissionRow>('SELECT * FROM missions ORDER BY createdAt DESC LIMIT 100');
  const missionGet = db.prepare<unknown[], MissionRow>('SELECT * FROM missions WHERE id = ?');
  const subtaskInsert = db.prepare(
    `INSERT INTO subtasks (id, missionId, capabilityId, title, instruction, status, "order", startedAt, finishedAt, reviewNote)
     VALUES (@id, @missionId, @capabilityId, @title, @instruction, @status, @order, NULL, NULL, '')`,
  );
  const subtaskListByMission = db.prepare<unknown[], SubtaskRow>('SELECT * FROM subtasks WHERE missionId = ? ORDER BY "order" ASC');
  const subtaskUpdateStatus = db.prepare(
    `UPDATE subtasks SET status = @status, reviewNote = @reviewNote,
     startedAt = CASE WHEN @status = 'running' AND startedAt IS NULL THEN @now ELSE startedAt END,
     finishedAt = CASE WHEN @status IN ('done','failed','skipped') THEN @now ELSE finishedAt END
     WHERE id = @subtaskId`,
  );

  // ---- 产物 prepared statements ----
  const artifactInsert = db.prepare(
    `INSERT INTO mission_artifacts (id, subtaskId, kind, path, label, createdAt)
     VALUES (@id, @subtaskId, @kind, @path, @label, @createdAt)`,
  );
  const artifactList = db.prepare<unknown[], MissionArtifactRow>('SELECT * FROM mission_artifacts WHERE subtaskId = ? ORDER BY createdAt ASC');

  // ---- 能力卡方法 ----
  function listCapabilities(req?: CapabilitySearchRequest): CapabilityCardPayload[] {
    let rows: CapabilityRow[];
    if (req?.status && req?.source) {
      rows = capListByBoth.all(req.status, req.source);
    } else if (req?.status) {
      rows = capListByStatus.all(req.status);
    } else if (req?.source) {
      rows = capListBySource.all(req.source);
    } else {
      rows = capListAll.all();
    }
    return rows.map(capRowToPayload);
  }

  function getCapability(id: string): CapabilityCardPayload | null {
    const row = capGet.get(id);
    return row ? capRowToPayload(row) : null;
  }

  function createCapability(req: CapabilityCreateRequest): { id: string } {
    const now = Date.now();
    capInsert.run({
      id: req.id,
      title: req.title,
      description: req.description,
      toolsJson: JSON.stringify(req.tools),
      precondition: req.precondition,
      acceptance: req.acceptance,
      visualAnchorsJson: JSON.stringify(req.visualAnchors),
      status: 'active',
      source: 'seed',
      createdAt: now,
      updatedAt: now,
    });
    capFtsInsert.run({
      capabilityId: req.id,
      title: req.title,
      description: req.description,
      precondition: req.precondition,
      acceptance: req.acceptance,
    });
    return { id: req.id };
  }

  function updateCapability(req: CapabilityUpdateRequest): void {
    const existing = capGet.get(req.id);
    if (!existing) return;

    const now = Date.now();
    const title = req.title ?? existing.title;
    const description = req.description ?? existing.description;
    const tools = req.tools ?? parseJsonArray(existing.toolsJson);
    const precondition = req.precondition ?? existing.precondition;
    const acceptance = req.acceptance ?? existing.acceptance;
    const visualAnchors = req.visualAnchors ?? parseJsonArray(existing.visualAnchorsJson);
    const status = req.status ?? (existing.status as CapabilityStatus);

    if (req.title || req.description || req.precondition || req.acceptance) {
      capFtsDelete.run(req.id);
      capFtsInsert.run({
        capabilityId: req.id,
        title,
        description,
        precondition,
        acceptance,
      });
    }

    if (req.status && req.status !== (existing.status as CapabilityStatus)) {
      capUpdateStatus.run(req.status, now, req.id);
    } else {
      capUpdate.run({
        id: req.id,
        title,
        description,
        toolsJson: JSON.stringify(tools),
        precondition,
        acceptance,
        visualAnchorsJson: JSON.stringify(visualAnchors),
        status,
        updatedAt: now,
      });
    }
  }

  function searchCapabilitiesFTS(query: string): CapabilityCardPayload[] {
    const sanitized = query.replace(/["*]/g, ' ').trim();
    if (!sanitized) return [];
    const ftsQuery = sanitized.split(/\s+/).map((w) => `"${w}"*`).join(' ');
    return capFtsSearch.all(ftsQuery).map(capRowToPayload);
  }

  function matchCapabilities(missionGoal: string): CapabilityMatchResultPayload {
    const sanitized = missionGoal.replace(/["*]/g, ' ').trim();
    if (!sanitized) return { items: [] };
    const ftsQuery = sanitized.split(/\s+/).map((w) => `"${w}"*`).join(' ');
    const rows = capMatchSearch.all(ftsQuery);
    return {
      items: rows.map((r) => ({
        capabilityId: r.id,
        score: 1 / (1 + Math.abs(r.rank)),
        title: r.title,
      })),
    };
  }

  function incrementCapabilityUsage(id: string, success: boolean): void {
    if (success) {
      capIncrementUsage.run(id);
    } else {
      capIncrementFail.run(id);
    }
  }

  // ---- 任务方法 ----
  function createMission(req: MissionCreateRequest): { id: string } {
    const missionId = `mis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const tx = db.transaction(() => {
      missionInsert.run({
        id: missionId,
        goal: req.goal,
        origin: req.origin,
        priority: req.priority,
        status: 'queued',
        createdAt: now,
      });
      req.subtasks.forEach((st, idx) => {
        const subtaskId = `sub-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
        subtaskInsert.run({
          id: subtaskId,
          missionId,
          capabilityId: st.capabilityId,
          title: st.title,
          instruction: st.instruction,
          status: 'pending',
          order: idx,
        });
      });
    });
    tx();
    return { id: missionId };
  }

  function listMissions(): MissionRowPayload[] {
    return missionList.all().map(missionRowToPayload);
  }

  function getMission(id: string): { mission: MissionRowPayload; subtasks: Array<SubtaskRowPayload & { artifacts?: MissionArtifactRowPayload[] }> } | null {
    const missionRow = missionGet.get(id);
    if (!missionRow) return null;

    const subtaskRows = subtaskListByMission.all(id);
    const subtasks = subtaskRows.map((sr) => {
      const artifacts = artifactList.all(sr.id).map(artifactRowToPayload);
      return { ...subtaskRowToPayload(sr), ...(artifacts.length > 0 ? { artifacts } : {}) };
    });

    return {
      mission: missionRowToPayload(missionRow),
      subtasks,
    };
  }

  function updateSubtaskStatus(req: SubtaskStatusUpdateRequest): void {
    const now = Date.now();
    const reviewNote = req.reviewNote ?? '';
    subtaskUpdateStatus.run({ subtaskId: req.subtaskId, status: req.status, reviewNote, now });
  }

  function createArtifact(req: ArtifactCreateRequest): { id: string } {
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    artifactInsert.run({
      id,
      subtaskId: req.subtaskId,
      kind: req.kind,
      path: req.path,
      label: req.label,
      createdAt: Date.now(),
    });
    return { id };
  }

  function listArtifacts(subtaskId: string): MissionArtifactRowPayload[] {
    return artifactList.all(subtaskId).map(artifactRowToPayload);
  }

  return {
    listCapabilities,
    getCapability,
    createCapability,
    updateCapability,
    searchCapabilitiesFTS,
    matchCapabilities,
    createMission,
    listMissions,
    getMission,
    updateSubtaskStatus,
    createArtifact,
    listArtifacts,
    incrementCapabilityUsage,
  };
}
