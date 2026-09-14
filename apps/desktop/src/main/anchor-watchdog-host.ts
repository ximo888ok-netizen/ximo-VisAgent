/**
 * anchor-watchdog-host.ts — 看门狗装配层（A-M3）
 *
 * 把 anchor-watchdog 的纯逻辑信号接到真实世界：
 *   · 1s 滴答采样（foreground-proc 的 koffi 探针）→ 无 electron 依赖的判定都在状态机里；
 *   · PAUSE / RESUME → 复用 orchestrator 既有 pause/resume 通道（AgentLoop.pause/resume），
 *     **不新增任务状态、不新增 IPC 通道**：播报走 island 既有状态推送
 *     （publishStep + createStepEvent，与 island-bridge 同一通道）；系统通知兜底岛不可见场景；
 *   · FINISH（目标进程族退出）→ 已确认参数「进程退出 = 任务收口」：loop.cancel() 交回
 *     orchestrator-launch 的终态收敛路径落库/通知，本层不自造终态；
 *   · 任务终态（loops 表里没了这个 taskId）→ 自动停表，宿主另可显式 stop()。
 *
 * 误停三防（规划 §6 风险行）：探针异常按「样本不可用」跳过本轮（绝不当成已离开）；
 * 从未见过目标进程存活时不判退出；RESUME 后核实 loop 真已续跑，超过 5s 仍未续跑则
 * 播报「请点继续」而不是静默卡住。
 *
 * 仅当任务带 targetApp 时装配（无锚任务返回 null，链路逐字节与现状一致 = 零回归红线）。
 */
import { Notification } from 'electron';
import { publishStep } from './windows/island';
import { createStepEvent, type AgentStatus } from '../shared/island-contracts';
import {
  AnchorWatchdog,
  type WatchdogSample,
  type WatchdogSignal,
  type WatchdogState,
  type WatchdogTick,
} from './anchor-watchdog';
import {
  createForegroundProbe,
  familyBasenamesOf,
  type ForegroundProbe,
  type ForegroundSample,
} from './foreground-proc';

/** 本层需要的 AgentLoop 能力子集（结构化接收，不 import agent-core） */
export interface WatchdogLoopControl {
  pause(): void;
  resume(): void;
  cancel(): void;
  readonly isPaused: boolean;
}

/** LaunchHost 的最小切片：只需 loops 表 */
export interface WatchdogLaunchControl {
  loops: Map<string, { loop: WatchdogLoopControl; goal: string }>;
}

/** QueuedTask 的锚位切片（A-M2 落字段前后都可用：字段缺省即不装配） */
export interface AnchorTaskLike {
  taskId: string;
  targetApp?: { name?: string; exePath?: string; procFamily?: string[] };
  longTask?: { watchdogIdleMs?: number };
}

export interface AnchorWatchdogDeps {
  /** 前台探针（缺省 koffi 实现；单测注入替身） */
  probeFactory?: (family: string[]) => ForegroundProbe;
  now?: () => number;
  /** 滴答周期，缺省 1s（Q8 量级的离开判定不需要更快） */
  tickMs?: number;
  /** 定时器装配（缺省 setInterval + unref；单测注入空转手动驱动） */
  startTimer?: (fn: () => void, ms: number) => () => void;
  /** 岛状态推送（缺省 publishStep，复用既有通道） */
  broadcast?: (status: AgentStatus, text: string) => void;
  /** 系统通知（缺省 electron Notification） */
  notify?: (title: string, body: string) => void;
}

export interface AnchorWatchdogHandle {
  /** 停表 + 收口状态机（幂等） */
  stop(): void;
  state(): WatchdogState;
  /** 累计暂停时长（ms）：LongTaskRunner / 预算闸冻结计时用 */
  pausedMs(): number;
  /** 驱动一格（缺省自采样；显式给 sample 供 selftest / 单测直驱） */
  tickOnce(sample?: ForegroundSample): WatchdogTick | null;
}

const DEFAULT_TICK_MS = 1_000;

/** 已装配的看门狗（taskId → handle）：供 §3.5 LongTaskRunner 聚合状态，stop 时自清 */
const active = new Map<string, AnchorWatchdogHandle>();

/** 取某任务已装配的看门狗句柄（未锚定 / 已终态返回 null） */
export function getAnchorWatchdog(taskId: string): AnchorWatchdogHandle | null {
  return active.get(taskId) ?? null;
}

function defaultStartTimer(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

function defaultBroadcast(status: AgentStatus, text: string): void {
  try {
    publishStep(createStepEvent(status, text));
  } catch (err) {
    console.warn('[anchor-watchdog] 岛状态推送失败:', err instanceof Error ? err.message : err);
  }
}

function defaultNotify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch {
    /* 通知失败不影响任务 */
  }
}

function secondsOf(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

/**
 * 为带锚任务装配看门狗。返回 null = 无 targetApp / 进程族推不出 / 已有同任务装配，
 * 调用方（orchestrator-launch）直接忽略即可，不影响任务本身。
 */
export function attachAnchorWatchdog(
  control: WatchdogLaunchControl,
  task: AnchorTaskLike,
  deps: AnchorWatchdogDeps = {},
): AnchorWatchdogHandle | null {
  const target = task.targetApp;
  if (!target) return null;
  const existing = active.get(task.taskId);
  if (existing) return existing;
  const now = deps.now ?? Date.now;
  const broadcast = deps.broadcast ?? defaultBroadcast;
  const notify = deps.notify ?? defaultNotify;
  const family = familyBasenamesOf(target);
  if (family.length === 0) {
    broadcast('thinking', `未识别到「${target.name ?? '目标应用'}」的进程名，看门狗未启动`);
    return null;
  }
  const watchdog = new AnchorWatchdog({ idleMs: task.longTask?.watchdogIdleMs, now });
  const probe = (deps.probeFactory ?? createForegroundProbe)(family);
  const label = target.name ?? family[0] ?? '目标应用';

  let stopped = false;
  let stopTimer: () => void = () => undefined;
  /** 本段暂停起点（播报用）；null = 未在暂停中 */
  let pausedAt: number | null = null;
  /** RESUME 已发出但 loop 仍未续跑（起点时刻），null = 无待恢复 */
  let pendingResumeSince: number | null = null;
  let resumeNudged = false;

  function loopOf(): WatchdogLoopControl | null {
    return control.loops.get(task.taskId)?.loop ?? null;
  }

  function apply(signal: WatchdogSignal, tick: WatchdogTick): void {
    const loop = loopOf();
    if (signal === 'PAUSE') {
      loop?.pause();
      pausedAt = now();
      const text = `看门狗暂停：已离开「${label}」${secondsOf(tick.awayMs)}s，回到该应用会自动续跑`;
      broadcast('paused', text);
      notify('长任务已暂停', text);
      return;
    }
    if (signal === 'RESUME') {
      loop?.resume();
      pendingResumeSince = now();
      resumeNudged = false;
      const segmentMs = pausedAt === null ? tick.pausedMs : now() - pausedAt;
      pausedAt = null;
      broadcast('thinking', `已回到「${label}」，自动续跑（暂停 ${secondsOf(segmentMs)}s，该段不计入执行时长）`);
      return;
    }
    if (signal === 'FINISH') {
      // 进程退出 = 收口：取消交回 launch 的终态路径（落库 + 岛/系统通知），断点由其既有纪律保留
      loop?.cancel();
      broadcast('stopped', `目标应用「${label}」已退出，任务收口（进度与断点保留）`);
      notify('长任务已收口', `目标应用「${label}」已退出，任务停止并保留断点`);
      stop();
    }
  }

  function verifyPendingResume(): void {
    if (pendingResumeSince === null) return;
    const loop = loopOf();
    if (!loop || !loop.isPaused) {
      pendingResumeSince = null;
      return;
    }
    if (now() - pendingResumeSince <= watchdog.resumeWindowMs || resumeNudged) return;
    resumeNudged = true;
    broadcast('paused', `已回到「${label}」但未能自动续跑（超过 ${secondsOf(watchdog.resumeWindowMs)}s），请点「继续」`);
  }

  function tickOnce(sample?: ForegroundSample): WatchdogTick | null {
    if (stopped) return null;
    if (!control.loops.has(task.taskId)) {
      stop();
      return null;
    }
    let observed: ForegroundSample;
    try {
      observed = sample ?? probe.sample();
    } catch (err) {
      // 采样不可用 ≠ 已离开：跳过本轮，绝不据此暂停（误停防线）
      console.warn('[anchor-watchdog] 前台采样失败，本轮跳过:', err instanceof Error ? err.message : err);
      return null;
    }
    const input: WatchdogSample = {
      now: now(),
      foregroundInFamily: observed.foregroundInFamily,
      familyAlive: observed.familyAlive,
    };
    const tick = watchdog.tick(input);
    apply(tick.signal, tick);
    verifyPendingResume();
    return tick;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stopTimer();
    watchdog.stop();
    active.delete(task.taskId);
  }

  const handle: AnchorWatchdogHandle = {
    stop,
    state: () => watchdog.state,
    pausedMs: () => watchdog.pausedMs,
    tickOnce,
  };
  active.set(task.taskId, handle);
  stopTimer = (deps.startTimer ?? defaultStartTimer)(() => { tickOnce(); }, deps.tickMs ?? DEFAULT_TICK_MS);
  return handle;
}
