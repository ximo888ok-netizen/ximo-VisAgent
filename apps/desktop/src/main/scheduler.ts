// 定时任务调度器：5 字段 cron + JSON 持久化 + 到点触发回调
// B 期载荷扩展（规划 §2.4）：targetApp/grantId/longTask 档位/cursor 引用随触发链携带；
// 调度语义（B-M2）：skipped-busy（上轮未终态即跳过记账）、错过合并（离线期间多个
// 错过的触发点合并为一次补跑，mergedInto 供 UI 展示「昨日 09:00 错过，已并入今日」）。
import fs from 'node:fs';
import path from 'node:path';
import type { LongTaskOptions, TargetApp } from '../shared/schemas/longtask';

/** 上轮最新检查点的引用（增量游标锚，checkpointRef.taskId+seq 指向 task_checkpoints 行） */
export interface JobCheckpointRef {
  taskId: string;
  seq: number;
}

export type JobRunStatus = 'done' | 'running' | 'skipped-busy' | 'failed' | 'paused-out-of-scope';

/** 错过合并记录：fromAt 起共 count 个错过的触发点并入 intoAt 这一轮补跑 */
export interface JobMergedInto {
  count: number;
  fromAt: number;
  intoAt: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  sopId: string | null;
  goal: string;
  cron: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  // ---- B 期字段（全部可空：旧 job 无感，零回归红线） ----
  /** 触发时随 startTask 下传的锚位（规划 §2.4） */
  targetApp?: TargetApp;
  /** 指向 preauth_grants（job 级作用域包，job_id 绑定） */
  grantId?: string;
  /** 长任务预算档位（缺省走 launch 锚定档） */
  longTask?: LongTaskOptions;
  /** 「转为长期任务」来源任务（审计回链，UI 展示用） */
  sourceTaskId?: string;
  /** 增量游标：上轮成功终态后由 longtask-increment 写回（失败轮不推进） */
  checkpointRef?: JobCheckpointRef;
  /** 本轮任务 id（skipped-busy 判定与收敛回写的锚） */
  lastTaskId?: string;
  lastRunStatus?: JobRunStatus;
  /** 错过合并记账（仅补跑轮写入；按时触发为 undefined） */
  mergedInto?: JobMergedInto;
}

export interface JobRunResult {
  /** 任务是否成功受理 */
  ok: boolean;
  error?: string;
  /**
   * started = 已受理进执行链（job 置 running，终态由 longtask-increment 收敛写回）；
   * skipped-busy = 上轮还没跑完，本轮跳过；缺省 = 旧的即时完成语义（done）。
   */
  status?: 'started' | 'skipped-busy' | 'done';
}

export interface SchedulerCallbacks {
  /** 到点执行：返回任务是否成功受理 + B 期轮次语义 */
  runJob(job: ScheduledJob): Promise<JobRunResult>;
}

const CHECK_INTERVAL_MS = 30_000;
const MAX_SCAN_MINUTES = 60 * 24 * 366; // 向前扫描上限：一年
/** 错过槽位扫描上限（病久 cron 防打满；超出只按此数记账，触发语义不变：仍补跑 1 次） */
const MAX_MISSED_SLOTS = 9999;

/** 极简 cron 字段解析：支持 * 、数字、逗号列表、连字符区间、/步长 */
function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const body = stepMatch ? (stepMatch[1] ?? part) : part;
    let lo = min;
    let hi = max;
    if (body === '*') {
      // 全区间
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(body);
      hi = stepMatch ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? [...out] : null;
}

export function parseCron(cron: string): { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number> } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0] ?? '', 0, 59);
  const hours = parseField(parts[1] ?? '', 0, 23);
  const days = parseField(parts[2] ?? '', 1, 31);
  const months = parseField(parts[3] ?? '', 1, 12);
  let weekdays = parseField(parts[4] ?? '', 0, 6);
  if (minutes === null || hours === null || days === null || months === null || weekdays === null) return null;
  // cron 约定：7 也表示周日
  if (parts[4]?.includes('7')) weekdays = [...new Set([...weekdays, 0])];
  return {
    minutes: new Set(minutes),
    hours: new Set(hours),
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays),
  };
}

function matches(parsed: NonNullable<ReturnType<typeof parseCron>>, d: Date): boolean {
  return (
    parsed.minutes.has(d.getMinutes()) &&
    parsed.hours.has(d.getHours()) &&
    parsed.months.has(d.getMonth() + 1) &&
    parsed.weekdays.has(d.getDay()) &&
    parsed.days.has(d.getDate())
  );
}

/** 计算下次触发时间（从 from 起每分钟扫描） */
export function nextRunAt(cron: string, from = new Date()): number | null {
  const parsed = parseCron(cron);
  if (!parsed) return null;
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (matches(parsed, t)) return t.getTime();
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/**
 * 错过槽位统计：从 dueAt（含）到 now（含）之间共有几个 cron 触发点。
 * count > 1 即存在错过——按用户确认参数（Q8）合并为最近 1 次补跑，
 * 其余 count-1 个槽位记入 mergedInto 供 UI 展示，不逐槽堆积。
 */
function countDueSlots(cron: string, dueAt: number, now: number): { count: number; fromAt: number; intoAt: number } {
  let count = 1;
  let last = dueAt;
  for (let guard = 0; guard < MAX_MISSED_SLOTS; guard++) {
    const next = nextRunAt(cron, new Date(last));
    if (next === null || next > now) break;
    count++;
    last = next;
  }
  return { count, fromAt: dueAt, intoAt: last };
}

/** B 期可合并的 job 字段补丁（undefined 值不写；mergedInto 显式 null 清除） */
export type JobPatch = Partial<Omit<ScheduledJob, 'id' | 'createdAt'>>;

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private running = false;

  constructor(file: string, private callbacks: SchedulerCallbacks) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ScheduledJob[];
        if (Array.isArray(raw)) this.jobs = raw.filter((j) => j && typeof j.cron === 'string');
      }
    } catch { /* 损坏则从空开始 */ }
    this.refreshNextRuns();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch (err) {
      console.error('[scheduler] save failed', err);
    }
  }

  private refreshNextRuns(): void {
    for (const job of this.jobs) {
      if (!job.enabled) {
        job.nextRunAt = null;
        continue;
      }
      // 错过合并前提（B-M2）：停机期间留下的过期 nextRunAt 原样保留，交给 tick
      // 合并补跑 1 次；只有缺失/非数值的坏值才按 cron 重算。
      if (typeof job.nextRunAt === 'number' && Number.isFinite(job.nextRunAt)) continue;
      job.nextRunAt = nextRunAt(job.cron);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 一次调度扫描（公开供调度语义回归用例确定性驱动；内部仍带 running 防重入） */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const job of this.jobs) {
        if (!job.enabled) continue;
        const due = job.nextRunAt ?? nextRunAt(job.cron);
        if (due !== null && due <= now) {
          const slots = countDueSlots(job.cron, due, now);
          let res: JobRunResult;
          try {
            res = await this.callbacks.runJob(job);
          } catch (err) {
            res = { ok: false, error: err instanceof Error ? err.message : '未知' };
          }
          this.recordRun(job, res, slots, now);
          this.save();
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 触发记账：skipped-busy 只记不跑；started 进 running 等收敛；错过合并仅对真正起跑的轮次记账 */
  private recordRun(job: ScheduledJob, res: JobRunResult, slots: { count: number; fromAt: number; intoAt: number }, now: number): void {
    job.lastRunAt = now;
    job.nextRunAt = nextRunAt(job.cron);
    if (!res.ok) {
      job.lastRunStatus = 'failed';
      job.lastStatus = `失败: ${res.error ?? '未知'}`;
      return;
    }
    if (res.status === 'skipped-busy') {
      job.lastRunStatus = 'skipped-busy';
      job.lastStatus = '跳过：上轮任务仍在运行';
      return;
    }
    if (res.status === 'started') {
      job.lastRunStatus = 'running';
      job.lastStatus = '运行中';
    } else {
      job.lastRunStatus = 'done';
      job.lastStatus = '成功';
    }
    if (slots.count > 1) {
      job.mergedInto = { count: slots.count - 1, fromAt: slots.fromAt, intoAt: slots.intoAt };
    } else {
      delete job.mergedInto;
    }
  }

  list(): ScheduledJob[] {
    return [...this.jobs].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  }

  get(id: string): ScheduledJob | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  /** 外部服务（longtask-increment 收敛）写回 job 字段；合并语义，undefined 不动 */
  patch(id: string, changes: JobPatch): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      Object.assign(job, { [key]: value });
    }
    this.save();
    return true;
  }

  create(req: {
    name: string; sopId?: string; goal?: string; cron: string;
    targetApp?: TargetApp; grantId?: string; longTask?: LongTaskOptions; sourceTaskId?: string;
  }): ScheduledJob {
    if (!parseCron(req.cron)) throw new Error(`无效的 cron 表达式: "${req.cron}"（格式: 分 时 日 月 周，如 "0 17 * * 1-5"）`);
    if (!req.sopId && !req.goal?.trim()) throw new Error('必须关联 SOP 模板或填写任务目标');
    const job: ScheduledJob = {
      id: crypto.randomUUID(),
      name: req.name,
      sopId: req.sopId ?? null,
      goal: req.goal?.trim() ?? '',
      cron: req.cron.trim(),
      enabled: true,
      lastRunAt: null,
      nextRunAt: nextRunAt(req.cron),
      lastStatus: null,
      createdAt: Date.now(),
      ...(req.targetApp ? { targetApp: req.targetApp } : {}),
      ...(req.grantId ? { grantId: req.grantId } : {}),
      ...(req.longTask ? { longTask: req.longTask } : {}),
      ...(req.sourceTaskId ? { sourceTaskId: req.sourceTaskId } : {}),
    };
    this.jobs.push(job);
    this.save();
    return job;
  }

  toggle(id: string, enabled: boolean): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    job.enabled = enabled;
    job.nextRunAt = enabled ? nextRunAt(job.cron) : null;
    this.save();
    return true;
  }

  delete(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === before) return false;
    this.save();
    return true;
  }
}
