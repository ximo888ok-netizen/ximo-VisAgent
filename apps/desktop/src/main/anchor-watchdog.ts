/**
 * anchor-watchdog.ts — 锚定看门狗状态机（A-M3，纯逻辑：不 import electron / koffi）
 *
 * 输入「一次采样」（时刻 + 前台是否属于目标进程族 + 进程族是否存活），输出状态与一个待执行的
 * 副作用信号；宿主（anchor-watchdog-host.ts）只翻译信号，不承载判定。
 *
 * 状态：RUNNING → PAUSED →（回前台）RUNNING；任一态遇目标进程族退出 → STOPPED（任务收口）。
 * 已确认参数（规划 Q8）：
 *   · 离开 N=120s（idleMs 可注入）才暂停——119.9s 不暂停、120.1s 暂停；
 *   · 回前台**自动**续跑（无需人工点击）：回到族内的第一个滴答即产出 RESUME，宿主滴答 1s，
 *     故续跑必落在「回前台 + 1s」≤ resumeWindowMs=5s 上限内（宿主侧再核时延并兜底人工提示）；
 *   · 进程退出 = 任务收口（FINISH）。宽限：从未观测到存活（seenAlive=false）不判退出，
 *     防「应用还没拉起来」被误签。
 *
 * 暂停期间的任务计时冻结：本状态机累计 `pausedMs`（各段 PAUSED 起止之和）。注意
 * agent-core loop.ts 的墙钟在暂停等待中仍在走（loop.ts:145 判「暂停期间超过单任务时间上限」），
 * 真正冻结需 A-M5 BudgetGuard 以 `elapsed = now - startedAt - pausedMs` 计算 —— 见交付汇报待装配清单。
 */

export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_RESUME_WINDOW_MS = 5_000;

export type WatchdogState = 'RUNNING' | 'PAUSED' | 'STOPPED';
/** 宿主待执行的副作用：无 / 暂停任务 / 续跑任务 / 收口任务 */
export type WatchdogSignal = 'NONE' | 'PAUSE' | 'RESUME' | 'FINISH';
export type WatchdogReason = '' | 'away-timeout' | 'app-exited' | 'task-finished';

export interface WatchdogSample {
  /** 采样时刻（毫秒，注入假时钟即成纯单测） */
  now: number;
  /** 前台窗口属于目标进程族（父链 ≤3 与 #32770 豁免的判定见 foreground-proc.ts） */
  foregroundInFamily: boolean;
  /** 目标进程族仍有存活进程 */
  familyAlive: boolean;
}

export interface WatchdogTick {
  state: WatchdogState;
  signal: WatchdogSignal;
  reason: WatchdogReason;
  /** 连续离开时长（ms；PAUSED 期间继续增长，供播报文案与复盘标注） */
  awayMs: number;
  /** 累计暂停时长（ms）—— 任务计时冻结的补偿量 */
  pausedMs: number;
}

export interface AnchorWatchdogOptions {
  /** 离开多久暂停（N），缺省 120s */
  idleMs?: number;
  /** 回前台自动续跑的时延上限（宿主核实用），缺省 5s */
  resumeWindowMs?: number;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
}

export class AnchorWatchdog {
  readonly idleMs: number;
  readonly resumeWindowMs: number;

  private readonly clock: () => number;
  private current: WatchdogState = 'RUNNING';
  private reason: WatchdogReason = '';
  private awaySince: number | null = null;
  private awayMs = 0;
  private pausedSince: number | null = null;
  private pausedTotal = 0;
  private seenAlive = false;

  constructor(opts: AnchorWatchdogOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.resumeWindowMs = opts.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
    this.clock = opts.now ?? Date.now;
  }

  get state(): WatchdogState {
    return this.current;
  }

  /** 累计暂停时长（ms）：A-M5 预算闸 / UI「暂停 x 分钟」的唯一真源 */
  get pausedMs(): number {
    return this.pausedTotal;
  }

  /** 推进一格；now 缺省取注入时钟 */
  tick(sample: Omit<WatchdogSample, 'now'> & { now?: number }): WatchdogTick {
    const now = sample.now ?? this.clock();
    if (this.current === 'STOPPED') return this.snapshot('NONE');

    if (sample.familyAlive) {
      this.seenAlive = true;
    } else if (this.seenAlive) {
      this.closePausedWindow(now);
      this.current = 'STOPPED';
      this.reason = 'app-exited';
      return this.snapshot('FINISH');
    }

    if (this.current === 'RUNNING') {
      if (sample.foregroundInFamily) {
        this.awaySince = null;
        this.awayMs = 0;
        return this.snapshot('NONE');
      }
      this.awaySince ??= now;
      this.awayMs = now - this.awaySince;
      if (this.awayMs < this.idleMs) return this.snapshot('NONE');
      this.current = 'PAUSED';
      this.reason = 'away-timeout';
      this.pausedSince = now;
      return this.snapshot('PAUSE');
    }

    // PAUSED：回到族内即自动续跑（不回族内则保持暂停，离开时长继续累计）
    if (!sample.foregroundInFamily) {
      if (this.awaySince !== null) this.awayMs = now - this.awaySince;
      return this.snapshot('NONE');
    }
    this.closePausedWindow(now);
    this.current = 'RUNNING';
    this.reason = '';
    this.awaySince = null;
    this.awayMs = 0;
    return this.snapshot('RESUME');
  }

  /** 外部收口（任务终态 / 急停）：幂等，不再产出信号 */
  stop(): WatchdogTick {
    if (this.current === 'STOPPED') return this.snapshot('NONE');
    this.closePausedWindow(this.clock());
    this.current = 'STOPPED';
    this.reason = 'task-finished';
    return this.snapshot('NONE');
  }

  private closePausedWindow(now: number): void {
    if (this.pausedSince === null) return;
    this.pausedTotal += now - this.pausedSince;
    this.pausedSince = null;
  }

  private snapshot(signal: WatchdogSignal): WatchdogTick {
    return {
      state: this.current,
      signal,
      reason: this.reason,
      awayMs: this.awayMs,
      pausedMs: this.pausedTotal,
    };
  }
}
