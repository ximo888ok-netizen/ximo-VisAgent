/**
 * ErrorCard.tsx — 错误卡（超长文本折叠，点击展开）
 */
import { useState } from "react";

export function ErrorCard({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="mt-2 rounded-lg ig-alert ig-tone-danger px-3 py-2 text-[13px] island-fade-up"
      data-interactive
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={expanded ? undefined : { maxHeight: 36, overflow: "hidden" }}>{error}</div>
      {error.length > 60 && (
        <div className="mt-1 text-[11px] ig-fg-danger">{expanded ? "▲ 收起" : "▼ 展开全文"}</div>
      )}
    </div>
  );
}
