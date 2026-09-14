/**
 * CountdownRing.tsx — 环形倒计时（20px SVG，随剩余秒数消耗）
 *
 * 绘制规范与其他图标一致：20 网格 / 显示 20 / 描边统一 1.5。
 * r=7.75 是为了让描边外沿落在 8.5，与其他图标一样留出安全边距——
 * 改造前 r=8 + 描边 2，外沿正好顶到 20 网格的边界，视觉上"贴边发闷"。
 */
export function CountdownRing({ remain, total }: { remain: number; total: number }) {
  const r = 7.75;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.max(0, remain / total) : 0;
  const sw = 1.5;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="align-[-4px]">
      <circle cx="10" cy="10" r={r} stroke="var(--ig-t-faint)" strokeWidth={sw} fill="none" />
      <circle
        cx="10"
        cy="10"
        r={r}
        stroke={ratio > 0.3 ? "var(--c-waiting)" : "var(--c-error)"}
        strokeWidth={sw}
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
