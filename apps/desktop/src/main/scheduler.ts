// 定时任务调度器：5 字段 cron + JSON 持久化 + 到点触发回调
import fs from 'node:fs';
import path from 'node:path';

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
}

export interface SchedulerCallbacks {
  /** 到点执行：返回任务是否成功受理 */
  runJob(job: ScheduledJob): Promise<{ ok: boolean; error?: string }>;
}

const CHECK_INTERVAL_MS = 30_000;
const MAX_SCAN_MINUTES = 60 * 24 * 366; // 向前扫描上限：一年

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
      job.nextRunAt = job.enabled ? nextRunAt(job.cron) : null;
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

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const job of this.jobs) {
        if (!job.enabled) continue;
        const due = job.nextRunAt ?? nextRunAt(job.cron);
        if (due !== null && due <= now) {
          try {
            const res = await this.callbacks.runJob(job);
            job.lastStatus = res.ok ? '成功' : `失败: ${res.error ?? '未知'}`;
          } catch (err) {
            job.lastStatus = `失败: ${err instanceof Error ? err.message : '未知'}`;
          }
          job.lastRunAt = Date.now();
          job.nextRunAt = nextRunAt(job.cron);
          this.save();
        }
      }
    } finally {
      this.running = false;
    }
  }

  list(): ScheduledJob[] {
    return [...this.jobs].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  }

  create(req: { name: string; sopId?: string; goal?: string; cron: string }): ScheduledJob {
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
