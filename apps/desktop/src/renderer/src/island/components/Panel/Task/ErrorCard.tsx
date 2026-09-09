/**
 * ErrorCard.tsx — 错误卡（超长文本折叠，点击展开）
 */
import { useState } from "react";

export function ErrorCard({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300 island-fade-up"
      data-interactive
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={expanded ? undefined : { maxHeight: 36, overflow: "hidden" }}>{error}</div>
      {error.length > 60 && (
        <div className="mt-1 text-[9.5px] text-red-300/50">{expanded ? "▲ 收起" : "▼ 展开全文"}</div>
      )}
    </div>
  );
}
