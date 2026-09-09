/**
 * CountdownRing.tsx — 环形倒计时（20px SVG，随剩余秒数消耗）
 */
export function CountdownRing({ remain, total }: { remain: number; total: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.max(0, remain / total) : 0;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="align-[-4px]">
      <circle cx="10" cy="10" r={r} stroke="var(--ig-t-faint)" strokeWidth="2" fill="none" />
      <circle
        cx="10"
        cy="10"
        r={r}
        stroke={ratio > 0.3 ? "#fbbf24" : "#f87171"}
        strokeWidth="2"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - ratio)}
        strokeLinecap="round"
        transform="rotate(-90 10 10)"
        style={{ transition: "stroke-dashoffset 1s linear" }}
      />
    </svg>
  );
}
