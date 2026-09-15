/**
 * MetricsCards.tsx — FR-012 度量四数卡（B-M3 面板顶部）
 *
 * 数字与口径（SQL 见 main/audit-db/longtask-metrics.ts 注释，全时累计）：
 *   锚定任务数 / 暂停率（发生过暂停的任务占比）/ preauth 放行率 / gate 分布。
 * 比率只认「分子/分母」原值，分母为 0 显示「—」（空库不是 0%，是没样本）。
 */
import { useIslandStore } from "../../../store/islandStore";
import { GATE_LABELS } from "../../common/labels";

function StatCard({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div
      className="min-w-0 rounded-xl border ig-bg-panel ig-border-line px-2.5 py-1.5"
      data-interactive
      title={title}
    >
      <div className="truncate text-[11px] t-faint">{label}</div>
      <div className="mt-0.5 truncate t-num text-[15px] font-semibold t-strong">
        {value}
        {sub && <span className="ml-1 text-[11px] font-normal t-faint">{sub}</span>}
      </div>
    </div>
  );
}

function rate(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

export function MetricsCards() {
  const metrics = useIslandStore((s) => s.metrics);
  const metricsError = useIslandStore((s) => s.metricsError);

  if (metricsError) {
    return (
      <div className="ig-alert ig-tone-danger rounded-xl px-2.5 py-1.5 text-[11px]">
        度量读取失败：{metricsError}
      </div>
    );
  }
  if (!metrics) {
    return (
      <div className="grid grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="island-skeleton h-11 rounded-xl ig-bg-panel" />
        ))}
      </div>
    );
  }

  const topGate = metrics.gates[0];
  const gateText = topGate
    ? `${topGate.gate ? GATE_LABELS[topGate.gate] ?? topGate.gate : "未标注"} ×${topGate.count}`
    : "—";
  const pauseValue = rate(metrics.pausedTasks, metrics.anchoredTasks);
  const preauthValue = rate(metrics.preauthCount, metrics.approvalTotal);

  return (
    <div className="grid grid-cols-4 gap-2">
      <StatCard
        label="锚定任务数"
        value={String(metrics.anchoredTasks)}
        title="anchor_attached 去重任务数（全时累计）"
      />
      <StatCard
        label="暂停率"
        value={pauseValue}
        sub={metrics.pauseCount > 0 ? `${metrics.pauseCount} 次` : undefined}
        title={`发生过看门狗暂停的任务 ${metrics.pausedTasks} / 锚定任务 ${metrics.anchoredTasks}（事件总数 ${metrics.pauseCount}）`}
      />
      <StatCard
        label="preauth 放行率"
        value={preauthValue}
        title={`预授权放行 ${metrics.preauthCount} / 审批决策 ${metrics.approvalTotal}`}
      />
      <StatCard
        label="gate 分布 · 最多"
        value={String(metrics.gates.length)}
        sub={gateText}
        title={metrics.gates.map((g) => `${g.gate ? GATE_LABELS[g.gate] ?? g.gate : "未标注"}：${g.count}`).join(" · ") || "尚无收口报告"}
      />
    </div>
  );
}
