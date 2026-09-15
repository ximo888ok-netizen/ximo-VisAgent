/**
 * longtask-metrics.ts — FR-012 度量聚合查询（B-M3 面板四数卡，仓储层）
 *
 * SQL 以 FR012_METRIC_SQL（./metrics-sql.ts，orchestrator-audit 埋点口径原样迁出）
 * 为正源（import 不手抄）；本文件只做「执行 + 整形」，比率不在 SQL 层算成
 * 字符串（前端只拿分子分母）。走 MigrationDb 窄接口（checkpoint-store 同法），
 * vitest node:sqlite 适配直测，不绑 better-sqlite3 类型。
 *
 * 口径注释（卡片文案与这里一一对应）：
 * - 锚定任务数：anchor_attached 去重 taskId（全时累计，无时间窗）。
 * - 暂停率：发生过 anchor_pause 的任务数 / 锚定任务数（一个任务多次暂停只算一次；
 *   pauseCount = anchor_pause 事件总数，供悬停明细）。pauseCount 复用 FR012 SQL；
 *   pausedTasks 是同埋点上的 B-M3 扩展查询（不新增事件类型）。
 * - preauth 放行率：approval_decided 行中 decidedBy='preauth' 数 / 决策总数。
 * - gate 分布：task_gate_report 按 detail.gate 分组计数（null = 缺字段的历史行）。
 * 分母为 0 时不落 NaN——返回分子/分母原值，由前端渲染「—」。
 */
import type { MigrationDb } from '../db-migrations';
import { FR012_METRIC_SQL } from './metrics-sql';
import type { LongTaskMetrics } from '../../shared/schemas/longtask';

/** SUM 在空集上返回 NULL，聚合列一律按可空读 */
interface AnchoredRow { anchored_tasks: number | null }
interface PauseRow { pauses: number | null }
interface PausedTasksRow { paused_tasks: number | null }
interface PreauthRow { preauth: number | null; total_approvals: number | null; preauth_rate: number | null }
interface GateRow { gate: string | null; n: number | null }

const PAUSED_TASKS_SQL =
  "SELECT COUNT(DISTINCT taskId) AS paused_tasks FROM audit WHERE kind = 'anchor_pause'";

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function computeLongTaskMetrics(db: MigrationDb): LongTaskMetrics {
  const anchored = db.prepare(FR012_METRIC_SQL.anchoredTasks).get() as AnchoredRow | undefined;
  const pauses = db.prepare(FR012_METRIC_SQL.pauseCount).get() as PauseRow | undefined;
  const paused = db.prepare(PAUSED_TASKS_SQL).get() as PausedTasksRow | undefined;
  const preauth = db.prepare(FR012_METRIC_SQL.preauthRate).get() as PreauthRow | undefined;
  const gates = db.prepare(FR012_METRIC_SQL.gateDist).all() as GateRow[];
  return {
    anchoredTasks: num(anchored?.anchored_tasks),
    pausedTasks: num(paused?.paused_tasks),
    pauseCount: num(pauses?.pauses),
    preauthCount: num(preauth?.preauth),
    approvalTotal: num(preauth?.total_approvals),
    gates: gates
      .map((g) => ({ gate: g.gate, count: num(g.n) }))
      .sort((a, b) => b.count - a.count),
  };
}
