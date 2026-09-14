/**
 * longtask-reconcile.ts — 断点落盘与工件对账（规划 §2.3/§3.5/§3.6，A-M4 核心）
 *
 * 两条写入路径共用本服务（Q5-C 双保险）：
 * - 宿主自动登记：写副作用工具成功后 orchestrator-executors.ts 调
 *   notifyWriteToolSuccess（确定性、模型忘不掉）；
 * - 模型显式补语义：checkpoint 工具（custom-tools.ts 注册）→ runCheckpointTool。
 * 同工件指纹（path+contentHash）双写在 checkpoint-store 去重合流，不重复成行。
 *
 * 重启对账（§2.3）：取 seq 最大检查点 → 逐工件现算 sha256 与登记指纹比对
 * （缺失/不符 → stale）→ { resumeCursor, redoItems, summaryText }。
 * 恢复窗口沿用 autoresume 24h 常量（§3.6）。对账是纯函数 + 可注入探针，单测不碰真库。
 *
 * 本文件禁止 import electron（vitest node 环境直跑）；hooks 未装配时全部函数静默降级，
 * 非锚定旧任务链路零回归。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CheckpointToolArgsSchema,
  type CheckpointArtifact,
  type CheckpointCursor,
  type CheckpointPreview,
} from '../shared/schemas/longtask';
import type { MigrationDb } from './db-migrations';
import { applyLongtaskCheckpointSchema } from './longtask-db/checkpoint-migrations';
import type { CheckpointStore, TaskCheckpoint } from './checkpoint-store';
import { createCheckpointStore } from './checkpoint-store';
import { RESUME_WINDOW_MS } from './orchestrator-autoresume';

/* ---------------------------------------------------------------------------
 * 工件探针（对账的 IO 面，纯函数经参数注入）
 * ------------------------------------------------------------------------- */

export interface ArtifactProbeResult {
  exists: boolean;
  size: number;
  hash: string | null;
}

export type ArtifactProbe = (artifactPath: string) => ArtifactProbeResult;

export function sha256OfFile(filePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/** 真实探针：内容 sha256 为准（mtime/size 变化只是先行信号，最终仍以内容比对定 stale） */
export function probeArtifact(artifactPath: string): ArtifactProbeResult {
  try {
    const st = statSync(artifactPath);
    return { exists: true, size: st.size, hash: sha256OfFile(artifactPath) };
  } catch {
    return { exists: false, size: 0, hash: null };
  }
}

/* ---------------------------------------------------------------------------
 * 对账（纯函数，规划 §2.3 恢复对账算法）
 * ------------------------------------------------------------------------- */

export interface RedoItem {
  path: string;
  reason: 'changed' | 'missing';
}

export interface ReconcileResult {
  seq: number;
  /** 检查点记录的原始游标（"上次进行到第 X 项"用这个） */
  checkpointCursor: CheckpointCursor;
  /** 对账后的续跑游标：stale 项退回重做基数（done - redo 数，钳 0） */
  resumeCursor: CheckpointCursor;
  redoItems: RedoItem[];
  summaryText: string;
}

export function reconcileCheckpoint(
  cp: TaskCheckpoint | null,
  probe: ArtifactProbe,
): ReconcileResult | null {
  if (!cp) return null;
  const redoItems = collectRedoItems(cp, probe);
  const done = Math.max(0, cp.cursor.done - redoItems.length);
  const resumeCursor: CheckpointCursor = { ...cp.cursor, done };
  return {
    seq: cp.seq,
    checkpointCursor: cp.cursor,
    resumeCursor,
    redoItems,
    summaryText: formatReconcileSummary(cp.cursor, redoItems.length),
  };
}

function collectRedoItems(cp: TaskCheckpoint, probe: ArtifactProbe): RedoItem[] {
  const seen = new Set<string>();
  const redo: RedoItem[] = [];
  for (const artifact of cp.artifacts) {
    if (seen.has(artifact.path)) continue;
    const item = checkArtifact(artifact, probe);
    if (item) {
      seen.add(artifact.path);
      redo.push(item);
    }
  }
  return redo;
}

function checkArtifact(artifact: CheckpointArtifact, probe: ArtifactProbe): RedoItem | null {
  const now = probe(artifact.path);
  if (!now.exists) return { path: artifact.path, reason: 'missing' };
  // 登记时不可读（''）或现算失败都按"内容变动"保守处理：重做比丢工件安全
  if (now.hash === null || now.hash !== artifact.contentHash) {
    return { path: artifact.path, reason: 'changed' };
  }
  return null;
}

/** 对账预览文案（Banner 锚定分支与自测共用同一纯函数口径） */
export function formatReconcileSummary(cursor: CheckpointCursor, redoCount: number): string {
  const base = `上次进行到第 ${cursor.done} ${cursor.unit}（读自工件核对）`;
  return redoCount > 0 ? `${base}，${redoCount} 项将重做` : `${base}，工件核对全部通过`;
}

/** 24h 恢复窗口：沿用 orchestrator-autoresume 常量（规划 §3.6，不另造第二真源） */
export function isWithinResumeWindow(createdAt: number, now = Date.now()): boolean {
  return now - createdAt <= RESUME_WINDOW_MS;
}

/* ---------------------------------------------------------------------------
 * 宿主装配钩子（longtask-runner 注入；未装配 = 全部静默 no-op，零回归）
 * ------------------------------------------------------------------------- */

export interface CheckpointHooks {
  store: CheckpointStore;
  /** 单并发恒 1（红线不动）：写检查点时刻的活动任务即当前任务 */
  currentTaskId: () => string | null;
}

let hooks: CheckpointHooks | null = null;

export function setCheckpointHooks(next: CheckpointHooks | null): void {
  hooks = next;
}

export function hasCheckpointHooks(): boolean {
  return hooks !== null;
}

/* ---------------------------------------------------------------------------
 * 路径一：写副作用工具成功后的宿主自动登记（orchestrator-executors 钩子）
 * ------------------------------------------------------------------------- */

/** 产出工件的写副作用工具 → 工件参数键；只读工具（file_read 等）天然不在表内 */
const WRITE_TOOL_ARTIFACT_ARG: Record<string, string> = {
  file_write: 'path',
  excel_write_cell: 'file',
};

/** 工具工件参数（相对沙箱）→ 绝对路径；非写副作用工具返回空 */
export function artifactsForWriteTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): string[] {
  const argKey = WRITE_TOOL_ARTIFACT_ARG[toolName];
  if (!argKey) return [];
  const rel = String(args[argKey] ?? '').trim();
  if (!rel) return [];
  return [path.resolve(workspaceDir, rel)];
}

/** 工具成功后调用；任何异常只留痕不上抛（检查点失败绝不能弄坏工具主链路） */
export function notifyWriteToolSuccess(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): void {
  if (!hooks) return;
  try {
    const taskId = hooks.currentTaskId();
    const artifactPaths = artifactsForWriteTool(toolName, args, workspaceDir);
    if (!taskId || artifactPaths.length === 0) return;
    const latest = hooks.store.latest(taskId);
    const lastPath = artifactPaths[artifactPaths.length - 1] ?? '';
    hooks.store.append({
      taskId,
      kind: 'host',
      cursor: {
        done: (latest?.cursor.done ?? 0) + artifactPaths.length,
        unit: '工件',
        lastItem: path.basename(lastPath),
      },
      artifacts: buildArtifacts(artifactPaths),
      summary: `工件落盘 ${artifactPaths.map((p) => path.basename(p)).join('、')}`,
    });
  } catch (err) {
    console.warn('[longtask-reconcile] 宿主检查点写入失败（不影响任务执行）:', err instanceof Error ? err.message : err);
  }
}

/* ---------------------------------------------------------------------------
 * 路径二：checkpoint 模型工具（custom-tools 注册，模型补结构化语义）
 * ------------------------------------------------------------------------- */

export interface CheckpointToolOutcome {
  ok: boolean;
  summary: string;
}

/**
 * 模型 checkpoint 工具执行体。args 契约见 CheckpointToolArgsSchema；
 * done 缺省继承宿主最新游标（宿主基数单调前进，模型忘报不错位）。
 */
export function runCheckpointTool(rawArgs: Record<string, unknown>): CheckpointToolOutcome {
  if (!hooks) return { ok: false, summary: '检查点服务未装配（长任务薄壳未启动）' };
  try {
    const taskId = hooks.currentTaskId();
    if (!taskId) return { ok: false, summary: '当前无运行中任务，检查点未登记' };
    const args = CheckpointToolArgsSchema.parse(rawArgs);
    const latest = hooks.store.latest(taskId);
    const result = hooks.store.append({
      taskId,
      kind: 'model',
      cursor: {
        done: args.done ?? latest?.cursor.done ?? 0,
        ...(args.total !== undefined ? { total: args.total } : {}),
        ...(args.unit !== undefined ? { unit: args.unit } : latest ? { unit: latest.cursor.unit } : { unit: '项' }),
        ...(args.lastItem !== undefined ? { lastItem: args.lastItem } : {}),
      },
      artifacts: buildArtifacts(args.artifacts ?? []),
      summary: args.summary,
    });
    return {
      ok: true,
      summary: result.deduped
        ? `检查点已与宿主登记合流（第 ${result.checkpoint.cursor.done} ${result.checkpoint.cursor.unit}）`
        : `检查点已登记：${args.summary}`,
    };
  } catch (err) {
    return { ok: false, summary: `检查点登记失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function buildArtifacts(absolutePaths: string[]): CheckpointArtifact[] {
  return absolutePaths.map((p) => ({
    path: p,
    contentHash: sha256OfFile(p) ?? '',
    role: 'output' as const,
  }));
}

/* ---------------------------------------------------------------------------
 * 恢复链喂给 InterruptedBanner 的预览（§3.6；listInterrupted 通道演进）
 * ------------------------------------------------------------------------- */

export interface InterruptedCandidate {
  taskId: string;
  createdAt: number;
  checkpoint?: CheckpointPreview;
}

/**
 * 给 24h 窗口内且有检查点的中断任务附加工件对账预览。
 * 表尚未随 longtask-runner 建好时静默跳过（非锚定旧任务展示与现状一致）。
 */
export function attachCheckpointPreviews(db: MigrationDb, items: InterruptedCandidate[], now = Date.now()): void {
  const candidates = items.filter((i) => isWithinResumeWindow(i.createdAt, now));
  if (candidates.length === 0) return;
  try {
    applyLongtaskCheckpointSchema(db);
    const store = createCheckpointStore(db);
    for (const item of candidates) {
      const preview = buildPreview(store.latest(item.taskId));
      if (preview) item.checkpoint = preview;
    }
  } catch (err) {
    console.warn('[longtask-reconcile] 对账预览附加失败（保留原横幅口径）:', err instanceof Error ? err.message : err);
  }
}

/** 检查点 → Banner 对账预览（纯装配，可单测）；无检查点返回 undefined */
export function buildPreview(cp: TaskCheckpoint | null, probe: ArtifactProbe = probeArtifact): CheckpointPreview | undefined {
  if (!cp) return undefined;
  const reconciled = reconcileCheckpoint(cp, probe);
  if (!reconciled) return undefined;
  const cursor = reconciled.checkpointCursor;
  return {
    done: cursor.done,
    ...(cursor.total !== undefined ? { total: cursor.total } : {}),
    unit: cursor.unit,
    summary: cp.summary,
    redoCount: reconciled.redoItems.length,
    redoItems: reconciled.redoItems.slice(0, 50),
  };
}
