/**
 * longtask-reconcile.test.ts — 工件对账 + 双写去重 + 24h 窗口（A-M4 验收）
 *
 * 覆盖 FR-005 关键用例「篡改 1 工件 → stale 识别」：探针注入版（纯逻辑）与
 * 真实临时文件版各一组；双写去重走完整宿主钩子 + checkpoint 模型工具链路；
 * 对账预览纯函数（formatReconcileSummary/buildPreview/attachCheckpointPreviews）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationDb } from '../db-migrations';
import { applyLongtaskCheckpointSchema } from '../longtask-db/checkpoint-migrations';
import { createCheckpointStore } from '../checkpoint-store';
import {
  artifactsForWriteTool,
  attachCheckpointPreviews,
  formatReconcileSummary,
  isWithinResumeWindow,
  notifyWriteToolSuccess,
  probeArtifact,
  reconcileCheckpoint,
  runCheckpointTool,
  setCheckpointHooks,
  sha256OfFile,
  type ArtifactProbeResult,
  type InterruptedCandidate,
} from '../longtask-reconcile';
import { CustomToolRuntime, registerCheckpointTool } from '../custom-tools';
import { RESUME_WINDOW_MS } from '../orchestrator-autoresume';
import type { TaskCheckpoint } from '../checkpoint-store';

function toMigrationDb(sync: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => sync.exec(sql),
    prepare: (sql) => {
      const st = sync.prepare(sql) as {
        run: (...p: (string | number | null)[]) => unknown;
        get: (...p: (string | number | null)[]) => unknown;
        all: (...p: (string | number | null)[]) => unknown[];
      };
      return {
        run: (...p) => st.run(...(p as (string | number | null)[])),
        get: (...p) => st.get(...(p as (string | number | null)[])),
        all: (...p) => st.all(...(p as (string | number | null)[])),
      };
    },
  };
}

function makeStore(): { db: MigrationDb; store: ReturnType<typeof createCheckpointStore> } {
  const sync = new DatabaseSync(':memory:');
  const db = toMigrationDb(sync);
  applyLongtaskCheckpointSchema(db);
  return { db, store: createCheckpointStore(db) };
}

function checkpoint(seq: number, artifacts: TaskCheckpoint['artifacts'], done = artifacts.length): TaskCheckpoint {
  return {
    taskId: 't1',
    seq,
    kind: 'host',
    cursor: { done, unit: '张发票' },
    artifacts,
    summary: `已录入 ${done}/30 张发票`,
    createdAt: Date.now(),
  };
}

const ok = (hash: string): ArtifactProbeResult => ({ exists: true, size: 10, hash });

describe('恢复对账（规划 §2.3，探针注入纯逻辑）', () => {
  it('工件全部核对通过 → 无重做项，游标原样', () => {
    const cp = checkpoint(7, [
      { path: 'C:/inv/1.pdf', contentHash: 'h1', role: 'output' },
      { path: 'C:/inv/2.pdf', contentHash: 'h2', role: 'output' },
    ]);
    const r = reconcileCheckpoint(cp, (p) => ok(p.includes('1') ? 'h1' : 'h2'));
    expect(r?.redoItems).toEqual([]);
    expect(r?.resumeCursor.done).toBe(2);
    expect(r?.summaryText).toContain('工件核对全部通过');
  });

  it('篡改 1 工件（contentHash 变化）→ stale 识别 + 重做清单 + 续跑游标回退', () => {
    const cp = checkpoint(7, [
      { path: 'C:/inv/1.pdf', contentHash: 'h1', role: 'output' },
      { path: 'C:/inv/2.pdf', contentHash: 'h2', role: 'output' },
      { path: 'C:/src/in.xlsx', contentHash: 'h3', role: 'input-ref' },
    ]);
    const r = reconcileCheckpoint(cp, (p) => ok(p === 'C:/inv/2.pdf' ? 'TAMPERED' : 'h'));
    expect(r?.redoItems).toEqual([
      { path: 'C:/inv/1.pdf', reason: 'changed' },
      { path: 'C:/inv/2.pdf', reason: 'changed' },
      { path: 'C:/src/in.xlsx', reason: 'changed' },
    ]);
    expect(r?.resumeCursor.done).toBe(0);
    expect(r?.checkpointCursor.done).toBe(3);
    expect(r?.summaryText).toBe('上次进行到第 3 张发票（读自工件核对），3 项将重做');
  });

  it('文件缺失 → reason=missing；登记时无指纹（hash 空串）按需重做保守处理', () => {
    const cp = checkpoint(1, [
      { path: 'C:/gone.pdf', contentHash: 'h1', role: 'output' },
      { path: 'C:/nohash.pdf', contentHash: '', role: 'output' },
    ]);
    const r = reconcileCheckpoint(cp, (p) => (p === 'C:/gone.pdf' ? { exists: false, size: 0, hash: null } : ok('x')));
    expect(r?.redoItems).toEqual([
      { path: 'C:/gone.pdf', reason: 'missing' },
      { path: 'C:/nohash.pdf', reason: 'changed' },
    ]);
  });

  it('无检查点 → null（旧步骤骨架路径原样走现状）', () => {
    expect(reconcileCheckpoint(null, () => ok('h'))).toBeNull();
  });

  it('同路径重复登记只计一次重做（游标回退不虚高）', () => {
    const cp = checkpoint(1, [
      { path: 'C:/a.pdf', contentHash: 'h', role: 'output' },
      { path: 'C:/a.pdf', contentHash: 'h', role: 'output' },
    ]);
    expect(reconcileCheckpoint(cp, () => ok('other'))?.resumeCursor.done).toBe(1);
  });
});

describe('formatReconcileSummary（对账预览纯函数）', () => {
  it('Banner 口径文案：第 X 项 + N 项将重做', () => {
    expect(formatReconcileSummary({ done: 17, unit: '张发票' }, 2)).toBe('上次进行到第 17 张发票（读自工件核对），2 项将重做');
    expect(formatReconcileSummary({ done: 17, unit: '张发票' }, 0)).toContain('全部通过');
  });
});

describe('24h 恢复窗口（沿用 orchestrator-autoresume 常量）', () => {
  it('常量即 24h；窗口内 true / 窗口外 false', () => {
    expect(RESUME_WINDOW_MS).toBe(24 * 60 * 60_000);
    const now = 1_700_000_000_000;
    expect(isWithinResumeWindow(now - RESUME_WINDOW_MS, now)).toBe(true);
    expect(isWithinResumeWindow(now - RESUME_WINDOW_MS - 1, now)).toBe(false);
  });
});

describe('写副作用工具工件提取', () => {
  it('file_write/excel_write_cell → 沙箱内绝对路径；只读工具与非写工具 → 空', () => {
    const ws = 'C:/ws';
    expect(artifactsForWriteTool('file_write', { path: 'out/a.txt' }, ws)).toEqual([path.resolve(ws, 'out/a.txt')]);
    expect(artifactsForWriteTool('excel_write_cell', { file: 'book.xlsx' }, ws)).toEqual([path.resolve(ws, 'book.xlsx')]);
    expect(artifactsForWriteTool('file_read', { path: 'a.txt' }, ws)).toEqual([]);
    expect(artifactsForWriteTool('file_write', { path: '  ' }, ws)).toEqual([]);
  });
});

describe('宿主钩子 + checkpoint 模型工具全链路（真库 + 真实临时文件）', () => {
  let wsDir: string;
  let currentTask: string | null;

  beforeAll(() => {
    wsDir = mkdtempSync(path.join(tmpdir(), 'lt-cp-'));
  });
  afterAll(() => {
    if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true });
  });
  afterEach(() => {
    setCheckpointHooks(null);
    currentTask = null;
  });

  function arm() {
    const made = makeStore();
    currentTask = 'task-1';
    setCheckpointHooks({ store: made.store, currentTaskId: () => currentTask });
    return made;
  }

  function writeFile(rel: string, content: string): string {
    const abs = path.join(wsDir, rel);
    writeFileSync(abs, content, 'utf8');
    return abs;
  }

  it('篡改 1 工件 → 真实 sha256 探针识别 stale', () => {
    const { store } = arm();
    writeFile('a.txt', 'A');
    writeFile('b.txt', 'B');
    notifyWriteToolSuccess('file_write', { path: 'a.txt' }, wsDir);
    notifyWriteToolSuccess('file_write', { path: 'b.txt' }, wsDir);
    writeFile('b.txt', 'B-tampered');
    const r = reconcileCheckpoint(store.latest('task-1'), probeArtifact);
    expect(r?.redoItems).toEqual([{ path: path.join(wsDir, 'b.txt'), reason: 'changed' }]);
    expect(r?.resumeCursor.done).toBe(1);
  });

  it('双写去重：宿主自动登记后模型 checkpoint 工具报同一工件 → 不重复成行、语义合流', () => {
    const { store } = arm();
    const abs = writeFile('inv1.pdf', 'X');
    notifyWriteToolSuccess('file_write', { path: 'inv1.pdf' }, wsDir);
    const outcome = runCheckpointTool({
      summary: '已录入 1/30 张发票',
      total: 30,
      unit: '张发票',
      artifacts: [abs],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('合流');
    expect(store.list('task-1')).toHaveLength(1);
    const cp = store.latest('task-1');
    expect(cp?.cursor).toEqual({ done: 1, total: 30, unit: '张发票' });
    expect(cp?.summary).toBe('已录入 1/30 张发票');
  });

  it('未显式 done 的模型检查点继承宿主游标基数；无运行任务/无工件时不误写', () => {
    const { store } = arm();
    writeFile('c.txt', 'C');
    notifyWriteToolSuccess('file_write', { path: 'c.txt' }, wsDir);
    expect(runCheckpointTool({ summary: '进度 1' }).ok).toBe(true); // 无工件 → 独立行
    currentTask = null;
    expect(runCheckpointTool({ summary: 'x' }).ok).toBe(false);
    expect(store.list('task-1')).toHaveLength(2);
    expect(store.list('task-1')[0]?.kind).toBe('model');
  });

  it('checkpoint 模型工具经 CustomToolRuntime 注册/执行/跨 reload 保留', async () => {
    const { store } = arm();
    const abs = writeFile('d.txt', 'D');
    const runtime = new CustomToolRuntime(wsDir, async () => ({ ok: true, summary: '' }));
    registerCheckpointTool(runtime, runCheckpointTool);
    expect(runtime.has('checkpoint')).toBe(true);
    expect(runtime.toolSchemas().map((t) => t.name)).toContain('checkpoint');
    runtime.reload([]); // 启动重建不冲掉内置工具
    const res = await runtime.execute('checkpoint', { summary: '已录入 1/1 份', artifacts: [abs] });
    expect(res.ok).toBe(true);
    expect(store.list('task-1')).toHaveLength(1);
    expect(store.latest('task-1')?.kind).toBe('model');
    // 钩子未装配时执行体拒绝而非假成功
    setCheckpointHooks(null);
    const bad = await runtime.execute('checkpoint', { summary: 'x' });
    expect(bad.ok).toBe(false);
  });

  it('宿主检查点异常绝不影响工具主链路（工件路径不可哈希时静默落空串指纹）', () => {
    arm();
    notifyWriteToolSuccess('file_write', { path: '../escape/nope.txt' }, wsDir);
    // 不抛错即通过；指纹空串行对账按需重做处理（上面已测）
    expect(sha256OfFile(path.resolve(wsDir, '../escape/nope.txt'))).toBeNull();
  });
});

describe('attachCheckpointPreviews（listInterrupted 喂料，真库+真文件）', () => {
  it('窗口内有检查点 → 附带预览；无检查点/超窗口 → 保持原样', () => {
    const sync = new DatabaseSync(':memory:');
    const db = toMigrationDb(sync);
    applyLongtaskCheckpointSchema(db);
    const store = createCheckpointStore(db);
    const wsDir = mkdtempSync(path.join(tmpdir(), 'lt-att-'));
    try {
      const abs = path.join(wsDir, 'x.txt');
      writeFileSync(abs, 'V', 'utf8');
      store.append({
        taskId: 'fresh',
        kind: 'host',
        cursor: { done: 1, unit: '工件' },
        artifacts: [{ path: abs, contentHash: sha256OfFile(abs) ?? '', role: 'output' }],
        summary: '工件落盘 x.txt',
      });
      const items: InterruptedCandidate[] = [
        { taskId: 'fresh', createdAt: Date.now() },
        { taskId: 'stale-window', createdAt: Date.now() - RESUME_WINDOW_MS - 60_000 },
        { taskId: 'no-checkpoint', createdAt: Date.now() },
      ];
      attachCheckpointPreviews(db, items);
      expect(items[0]?.checkpoint).toMatchObject({ done: 1, redoCount: 0, unit: '工件' });
      expect(items[1]?.checkpoint).toBeUndefined();
      expect(items[2]?.checkpoint).toBeUndefined();
      // 篡改后重算：重做数进预览
      writeFileSync(abs, 'V2', 'utf8');
      const again: InterruptedCandidate[] = [{ taskId: 'fresh', createdAt: Date.now() }];
      attachCheckpointPreviews(db, again);
      expect(again[0]?.checkpoint?.redoCount).toBe(1);
      expect(again[0]?.checkpoint?.redoItems[0]?.reason).toBe('changed');
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
