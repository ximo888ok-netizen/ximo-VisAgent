// A-M5 预算闸（FR-006b，Q4 定论「任务级参数化」）：时长/步数/token 三合一判定。
// 纯逻辑状态机（镜像 loop-efficiency.ts 风格），不做 IO、不 import 宿主文件：
//   · 时钟经 clock 注入（单测假时钟；缺省 Date.now）；
//   · 暂停时间冻结经 pauseProvider 注入（desktop 侧传看门狗句柄的 pausedMs()）——
//     elapsed = now - startedAt - pausedMs()，锚定任务被看门狗暂停的时段不烧预算。
// 30min 硬顶仅在本 guard 未注入时由 loop 缺省保留；注入即由档位参数解除上限。
export type BudgetGate = 'budget-steps' | 'budget-duration' | 'budget-tokens';

export interface BudgetStop {
  gate: BudgetGate;
  /** 终态文案（loop 直接落进 finalAnswer，保持与迁移前逐字一致） */
  detail: string;
}

export interface BudgetGuardOptions {
  maxSteps: number;
  maxDurationMs: number;
  /** token 预算：缺省 = 不设上限（现状语义） */
  maxTokens?: number;
  /** 可 mock 时钟，缺省 Date.now */
  clock?: () => number;
  /** 累计暂停毫秒（看门狗 pausedMs 句柄），缺省 0 = 无冻结 */
  pauseProvider?: () => number;
  /** 预算起点，缺省 = 构造时刻（与 loop 的 startedAt 同数量级） */
  startedAt?: number;
}

export class BudgetGuard {
  private readonly clock: () => number;
  private readonly pauseProvider: () => number;
  private readonly startedAt: number;

  constructor(private opts: BudgetGuardOptions) {
    this.clock = opts.clock ?? Date.now;
    this.pauseProvider = opts.pauseProvider ?? (() => 0);
    this.startedAt = opts.startedAt ?? this.clock();
  }

  /** 扣除暂停段后的有效执行时长（ms，钳非负） */
  elapsedMs(now: number = this.clock()): number {
    return Math.max(0, now - this.startedAt - this.pauseProvider());
  }

  /** 每步进入时判定：步数 → 时长 → token，先到先触发；null = 预算仍有余量 */
  check(step: number, now: number, totalTokens: number): BudgetStop | null {
    const { maxSteps, maxDurationMs, maxTokens } = this.opts;
    if (step >= maxSteps) {
      return { gate: 'budget-steps', detail: `任务失败：达到最大步数上限（${maxSteps} 步）` };
    }
    if (this.elapsedMs(now) > maxDurationMs) {
      return { gate: 'budget-duration', detail: '任务失败：超过单任务时间上限' };
    }
    if (maxTokens !== undefined && totalTokens >= maxTokens) {
      return { gate: 'budget-tokens', detail: `任务失败：超过 token 预算上限（${maxTokens}）` };
    }
    return null;
  }
}
