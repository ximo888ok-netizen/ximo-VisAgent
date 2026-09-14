/**
 * orchestrator-autoresume.test.ts — 条目3.B 重启自动恢复
 *
 * A. autoResumeInterrupted 纯逻辑：24h 窗口筛选 / 中断态集合 / 只重跑最近 1 个 /
 *    开关与异常路径。
 * B. bootstrap 启动序列：e2e / selftest 下强制不恢复（避免污染基准），正常启动才扫描。
 *    bootstrap 的 Electron/窗口/托盘等重依赖全部替身化，只观察恢复闸门的调用行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoResumeInterrupted } from '../orchestrator-autoresume';
import type { Orchestrator } from '../orchestrator';
import type { ZODB } from '../audit-store';
import type { TaskRow } from '../audit-db/rows';

const HOUR = 60 * 60_000;

function mkTask(id: string, status: string, ageMs: number): TaskRow {
  return {
    taskId: id, goal: `目标-${id}`, status, createdAt: Date.now() - ageMs,
    finishedAt: null, summary: '', steps: null, tokens: null, failureKind: null,
  };
}

function makeDeps(tasks: TaskRow[], enabled = true) {
  const audit = { listTasks: vi.fn(() => tasks) } as unknown as ZODB;
  const orchestrator = { resumeInterrupted: vi.fn(async (id: string) => ({ taskId: id, goal: '', queued: false, queuedIndex: 0 })) } as unknown as Orchestrator;
  return { audit, orchestrator, enabled };
}

describe('autoResumeInterrupted（重启后恢复最近的未完成任务）', () => {
  it('24h 窗口外 / 终态任务不恢复；窗口内中断态才进候选', async () => {
    const deps = makeDeps([
      mkTask('t-old', 'RUNNING', 25 * HOUR),          // 超窗（视为垃圾）
      mkTask('t-done', 'COMPLETED', 1 * HOUR),        // 终态
      mkTask('t-fail', 'FAILED', 2 * HOUR),          // 终态
      mkTask('t-cancel', 'CANCELLED', 3 * HOUR),     // 终态
      mkTask('t-fresh', 'RUNNING', 23 * HOUR),       // 窗口内 ✓
    ]);
    const r = autoResumeInterrupted(deps);
    expect(deps.audit.listTasks).toHaveBeenCalledWith(100);
    expect(r.resumed).toBe('t-fresh');
    expect(r.goal).toBe('目标-t-fresh');
    expect(deps.orchestrator.resumeInterrupted).toHaveBeenCalledWith('t-fresh');
  });

  it('四种中断态（RUNNING/PAUSED/WAITING_APPROVAL/QUEUED）都在恢复集合内', async () => {
    for (const status of ['RUNNING', 'PAUSED', 'WAITING_APPROVAL', 'QUEUED']) {
      const deps = makeDeps([mkTask(`t-${status}`, status, 1 * HOUR)]);
      expect(autoResumeInterrupted(deps).resumed).toBe(`t-${status}`);
    }
  });

  it('多个候选只重跑最近 1 个（并发恒为 1，其余留给人工续跑）', async () => {
    const deps = makeDeps([
      mkTask('t-mid', 'RUNNING', 5 * HOUR),
      mkTask('t-newest', 'PAUSED', 10 * 60_000),
      mkTask('t-oldest', 'QUEUED', 20 * HOUR),
    ]);
    const r = autoResumeInterrupted(deps);
    expect(r.resumed).toBe('t-newest');
    expect(deps.orchestrator.resumeInterrupted).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.resumeInterrupted).toHaveBeenCalledWith('t-newest');
  });

  it('无候选 → 不调恢复、不带错误', () => {
    const deps = makeDeps([mkTask('t-x', 'COMPLETED', 1 * HOUR)]);
    const r = autoResumeInterrupted(deps);
    expect(r).toEqual({ resumed: null, goal: null });
    expect(deps.orchestrator.resumeInterrupted).not.toHaveBeenCalled();
  });

  it('enabled=false（配置关闭）→ 连审计库都不扫', () => {
    const deps = makeDeps([mkTask('t-any', 'RUNNING', 1 * HOUR)], false);
    expect(autoResumeInterrupted(deps)).toEqual({ resumed: null, goal: null });
    expect(deps.audit.listTasks).not.toHaveBeenCalled();
    expect(deps.orchestrator.resumeInterrupted).not.toHaveBeenCalled();
  });

  it('扫描异常 → 吞错误返回 error 字段（启动序列不被坏库卡死）', () => {
    const audit = { listTasks: vi.fn(() => { throw new Error('db 损坏'); }) } as unknown as ZODB;
    const orchestrator = { resumeInterrupted: vi.fn() } as unknown as Orchestrator;
    const r = autoResumeInterrupted({ audit, orchestrator, enabled: true });
    expect(r.resumed).toBeNull();
    expect(r.error).toContain('db 损坏');
    expect(orchestrator.resumeInterrupted).not.toHaveBeenCalled();
  });
});

// ---------- B. bootstrap 启动序列的恢复闸门（e2e/selftest 强制不恢复） ----------

const bootMocks = vi.hoisted(() => ({
  scheduleE2ERun: vi.fn(),
  listTasks: vi.fn(() => [] as unknown[]),
  resumeInterrupted: vi.fn(async (id: string) => ({ taskId: id, goal: '', queued: false, queuedIndex: 0 })),
  resumeRunningMissions: vi.fn(),
}));

vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => ({ bounds: { width: 1920 } }) },
}));
vi.mock('../windows/splash', () => ({ showSplash: vi.fn(), updateSplashStage: vi.fn() }));
vi.mock('../windows/island-loader', () => ({ loadIslandWindow: vi.fn() }));
vi.mock('../windows/island', () => ({
  getIslandWindow: vi.fn(() => null),
  isForegroundFullscreen: vi.fn(() => false),
  publishStep: vi.fn(),
}));
vi.mock('../windows/aura', () => ({ initAura: vi.fn() }));
vi.mock('../aura-state', () => ({
  auraSetIntensity: vi.fn(),
  auraIslandGeometry: vi.fn(),
  auraSetFullscreenProbe: vi.fn(),
  auraSetApprovalMode: vi.fn(),
}));
vi.mock('../tray', () => ({ createTray: vi.fn() }));
vi.mock('../hotkeys', () => ({ registerHotkeys: vi.fn() }));
vi.mock('../ipc/aura-handlers', () => ({ registerAuraHandlers: vi.fn() }));
vi.mock('../ipc-registry', () => ({ registerIsland: vi.fn() }));
vi.mock('../custom-tools', () => ({ loadApprovedTools: vi.fn(() => ({ loaded: [], failed: [] })) }));
vi.mock('../diagnostics', () => ({ scheduleStartupDiagnostics: vi.fn() }));
vi.mock('../e2e-runner', () => ({ scheduleE2ERun: bootMocks.scheduleE2ERun }));
vi.mock('../ipc/wechat-handlers', () => ({ registerWeChatHandlers: vi.fn() }));
vi.mock('../orchestrator-notify', () => ({ setWeChatNotifier: vi.fn() }));

import { bootstrap, type BootstrapDeps } from '../bootstrap';

async function runBootstrap(flags: { isE2E?: boolean; isSelfTest?: boolean }) {
  const deps = {
    orchestrator: {
      customTools: {},
      resumeInterrupted: bootMocks.resumeInterrupted,
      findPendingApprovals: () => [],
      approve: vi.fn(),
      reject: vi.fn(),
      startTask: vi.fn(),
    },
    auditDb: { listTasks: bootMocks.listTasks },
    experienceStore: { listCustomTools: () => [] },
    configStore: { get: () => ({ auraIntensity: 'full', approvalMode: 'auto', schedulerEnabled: false, agent: { autoResumeInterrupted: true } }) },
    memoryStore: {},
    conversationStore: {},
    scheduler: { start: vi.fn() },
    employeeStore: {},
    missionRepo: {},
    missionRunRepo: {},
    missionRunner: { resumeRunningMissions: bootMocks.resumeRunningMissions },
    wechatBot: { on: vi.fn(), start: vi.fn(), isCommand: () => false, extractCommand: () => '', getContextToken: () => null, sendText: vi.fn() },
    wechatCfg: { enabled: false },
    uiaClient: { start: async () => undefined, stop: () => undefined },
    isE2E: flags.isE2E ?? false,
    isSelfTest: flags.isSelfTest ?? false,
  };
  await bootstrap(deps as unknown as BootstrapDeps);
}

describe('bootstrap 恢复闸门（条目3.B：e2e/selftest 强制不恢复）', () => {
  beforeEach(() => {
    bootMocks.listTasks.mockReset();
    bootMocks.listTasks.mockReturnValue([mkTask('t-run', 'RUNNING', 1 * HOUR)]);
    bootMocks.resumeInterrupted.mockClear();
    bootMocks.resumeRunningMissions.mockClear();
    bootMocks.scheduleE2ERun.mockClear();
    // 屏蔽启动序列里的 1.5s 心跳定时器，避免测试挂起（各用例结束后 unstub 还原）
    vi.stubGlobal('setInterval', () => 0);
  });

  it('正常启动：扫描审计库并恢复最近未完成任务（含 Mission 断点重建）', async () => {
    await runBootstrap({});
    expect(bootMocks.resumeInterrupted).toHaveBeenCalledWith('t-run');
    expect(bootMocks.resumeRunningMissions).toHaveBeenCalledTimes(1);
    expect(bootMocks.scheduleE2ERun).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('e2e 模式：不扫描审计库、不恢复任务、不重建 Mission（避免污染基准），改跑 E2E', async () => {
    await runBootstrap({ isE2E: true });
    expect(bootMocks.listTasks).not.toHaveBeenCalled();
    expect(bootMocks.resumeInterrupted).not.toHaveBeenCalled();
    expect(bootMocks.resumeRunningMissions).not.toHaveBeenCalled();
    expect(bootMocks.scheduleE2ERun).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('selftest 模式：同样强制不恢复', async () => {
    await runBootstrap({ isSelfTest: true });
    expect(bootMocks.listTasks).not.toHaveBeenCalled();
    expect(bootMocks.resumeInterrupted).not.toHaveBeenCalled();
    expect(bootMocks.resumeRunningMissions).not.toHaveBeenCalled();
    expect(bootMocks.scheduleE2ERun).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
