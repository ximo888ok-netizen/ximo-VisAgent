/**
 * lib.ts — B-M3 长期任务面板纯逻辑（可单测，不碰 React/electron）
 *
 * 口径与后端对齐：
 * - humanizeCron：5 字段 cron → 人话（覆盖 presets/工作日/周几/整点/每小时/每月/分步长，
 *   复杂表达式回退原串，绝不臆造语义）。
 * - runBadge：lastRunStatus → 徽标（含 paused-out-of-scope「等待批复」标注）。
 * - missedLabel：mergedInto → 「昨日 09:00 错过，已并入今日补跑」（相对日 + HH:mm）。
 * - cursorText：检查点游标 → 「已处理 1400/2000 行」。
 * - roundGate/roundDurationMs：抽屉单轮收口闸 + 耗时（读自审计事件，缺字段返回 null 不猜）。
 */
import type {
  AuditRowPayload,
  JobMergedIntoPayload,
  JobRunStatusPayload,
  LongTaskCheckpointSummary,
} from "@shared/island-contracts";

/** 徽标语义色（对应 ig-tone-* 类名后缀） */
export type BadgeTone = "success" | "danger" | "warning" | "info" | "muted";

export interface RunBadge {
  label: string;
  tone: BadgeTone;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

/** 单字段是否为纯数字 */
function isNum(s: string): boolean {
  return /^\d+$/.test(s);
}

/** 解析「分 时」两字段为 HH:mm；非单值返回 null */
function timeOf(min: string, hour: string): string | null {
  if (isNum(hour) && isNum(min)) return `${pad(hour)}:${pad(min)}`;
  return null;
}

/** 星期字段 → 「每天/工作日/每X/每X、Y」描述；无法识别返回 null */
function dayDesc(dom: string, dow: string): string | null {
  if (dom === "*" && dow === "*") return "每天";
  if (dom === "*" && dow === "1-5") return "工作日";
  if (dom === "*" && dow === "1-7") return "每天";
  if (dom === "*" && /^\d$/.test(dow)) return `每${WEEKDAY[Number(dow) % 7] ?? "?"}`;
  if (dom === "*" && /^[0-7](,[0-7])+$/.test(dow)) {
    const names = dow.split(",").map((d) => WEEKDAY[Number(d) % 7] ?? "?");
    return `每${names.join("、")}`;
  }
  if (isNum(dom) && dow === "*") return `每月${Number(dom)}日`;
  return null;
}

/**
 * 5 字段 cron → 人话。识别不了（区间混合/月份限定/多值时）回退「按 Cron：原串」。
 */
export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `按 Cron：${cron}`;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (month !== "*") return `按 Cron：${cron}`;
  // 每分钟 / 每 N 分钟
  if (hour === "*" && (min === "*" || /^\*\/\d+$/.test(min))) {
    if (min === "*") return "每分钟";
    return `每${Number(min.slice(2))}分钟`;
  }
  // 每小时整点 / 每小时第 M 分
  if (hour === "*" && isNum(min)) {
    return Number(min) === 0 ? "每小时整点" : `每小时第${pad(min)}分`;
  }
  const t = timeOf(min, hour);
  const d = dayDesc(dom, dow);
  if (t && d) return `${d} ${t}`;
  return `按 Cron：${cron}`;
}

/** lastRunStatus → 状态徽标（paused-out-of-scope = 「等待批复」，FR-011 标注之一） */
export function runBadge(status: JobRunStatusPayload | null | undefined, enabled: boolean): RunBadge {
  if (status === "paused-out-of-scope") return { label: "暂停（超范围）· 等待批复", tone: "warning" };
  if (status === "running") return { label: "运行中", tone: "info" };
  if (status === "skipped-busy") return { label: "跳过：上轮仍在运行", tone: "muted" };
  if (status === "done") return { label: "上次成功", tone: "success" };
  if (status === "failed") return { label: "上次失败", tone: "danger" };
  return { label: enabled ? "从未运行" : "已停用", tone: "muted" };
}

function relDay(ts: number, now: number): string {
  const a = new Date(ts);
  const b = new Date(now);
  const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const diff = Math.round((dayB - dayA) / 86_400_000);
  if (diff === 0) return "今日";
  if (diff === 1) return "昨日";
  if (diff === 2) return "前日";
  if (diff === -1) return "明日";
  if (diff === -2) return "明後日";
  return `${pad(a.getMonth() + 1)}-${pad(a.getDate())}`;
}

function hm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 错过合并标注（FR-011 标注之二）：「昨日 09:00 错过，已并入今日补跑」；非补跑轮返回 null */
export function missedLabel(merged: JobMergedIntoPayload | undefined, now: number): string | null {
  if (!merged) return null;
  const extra = merged.count > 1 ? `（合并 ${merged.count} 个错过槽位）` : "";
  return `${relDay(merged.fromAt, now)} ${hm(merged.fromAt)} 错过${extra}，已并入${relDay(merged.intoAt, now)}补跑`;
}

/** 断点摘要（读自 checkpoints cursor）：「已处理 1400/2000 行」/「已处理 1400 项」 */
export function cursorText(cp: LongTaskCheckpointSummary | null | undefined): string | null {
  if (!cp) return null;
  const total = cp.total ? `/${cp.total}` : "";
  return `已处理 ${cp.done}${total} ${cp.unit}`;
}

/** 迷你时间条填充百分比（纯展示；无 total 时 done>0 记满，否则 0） */
export function progressPct(cp: LongTaskCheckpointSummary | null | undefined): number {
  if (!cp) return 0;
  if (cp.total && cp.total > 0) return Math.min(100, Math.round((cp.done / cp.total) * 100));
  return cp.done > 0 ? 100 : 0;
}

/** 触发闸人话（审计 task_gate_report.detail.gate；缺字段/缺行返回 null，不猜） */
export function roundGate(rows: AuditRowPayload[]): string | null {
  const reports = rows.filter((r) => r.kind === "task_gate_report");
  if (reports.length === 0) return null;
  const latest = reports.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  try {
    const parsed = JSON.parse(latest.detail) as { gate?: unknown };
    return typeof parsed.gate === "string" ? parsed.gate : null;
  } catch {
    return null;
  }
}

/** 单轮耗时（首末审计事件时间差；不足两条返回 null，不臆造） */
export function roundDurationMs(rows: AuditRowPayload[]): number | null {
  if (rows.length < 2) return null;
  const first = Math.min(...rows.map((r) => r.timestamp));
  const last = Math.max(...rows.map((r) => r.timestamp));
  return last - first;
}

/** 时长人话（秒级）：1h05m / 12m / 45s */
export function durationText(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

/** 下次触发人话（相对日 + HH:mm；已停用/无排期返回「—」） */
export function nextRunText(ts: number | null, now: number): string {
  if (ts === null) return "—";
  return `${relDay(ts, now)} ${hm(ts)}`;
}

/** 统一时间戳人话（供详情抽屉轮次时间列） */
export function atText(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
