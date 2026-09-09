/**
 * StatCard.tsx — 审计面板顶部单个统计指标
 */
export function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg ig-bg-panel px-2.5 py-1.5" data-interactive>
      <div className="text-[9.5px] t-faint">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums" style={{ color: accent ?? "var(--ig-t-strong)" }}>
        {value}
      </div>
    </div>
  );
}
