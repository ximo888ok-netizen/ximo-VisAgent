/**
 * AuditEventList.tsx — 审计事件流（审计面板右栏）
 *
 * 展示选中任务的所有审计事件（步骤、工具调用、审批等）。
 */
import { useIslandStore } from "../../store/islandStore";
import type { AuditRowPayload } from "@shared/island-contracts";

export function AuditEventList() {
  const events = useIslandStore((s) => s.auditEvents);
  const selectedTaskId = useIslandStore((s) => s.selectedTaskId);
  const auditLoading = useIslandStore((s) => s.auditLoading);

  if (!selectedTaskId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-white/5 grid place-items-center">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 3.5h8.5v9h-8.5z" stroke="rgba(255,255,255,0.2)" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M4.5 6.5h4.5M4.5 8.5h3" stroke="rgba(255,255,255,0.2)" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-[11px] text-white/25">选择左侧任务以查看审计</p>
        </div>
      </div>
    );
  }

  if (auditLoading && events.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="island-skeleton h-8 rounded-lg bg-white/5" style={{ animationDelay: `${i * 100}ms` }} />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[11px] text-white/25">无审计事件</span>
      </div>
    );
  }

  // 按时间顺序（旧到新）展示
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  return (
    <div className="island-panel-scroll h-full">
      <div className="island-timeline px-4 py-3 space-y-1">
        {sorted.map((event, i) => (
          <AuditEventRow key={event.id} event={event} delay={Math.min(i * 25, 200)} />
        ))}
      </div>
    </div>
  );
}

function AuditEventRow({ event, delay }: { event: AuditRowPayload; delay: number }) {
  const kindColor = kindToColor(event.kind);

  return (
    <div className="island-fade-up flex gap-2.5" style={{ animationDelay: `${delay}ms` }}>
      {/* 时间线节点 */}
      <div
        className="island-timeline-dot"
        style={{ background: kindColor }}
      />

      {/* 内容 */}
      <div className="flex-1 pb-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-white/25 font-mono">
            #{event.seq}
          </span>
          <span
            className="text-[10px] font-medium uppercase tracking-wide"
            style={{ color: kindColor }}
          >
            {event.kind}
          </span>
          <span className="text-[9.5px] text-white/20 ml-auto">
            {new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-white/60">
          {event.detail}
        </div>
      </div>
    </div>
  );
}

function kindToColor(kind: string): string {
  switch (kind) {
    case "PLAN": return "#60a5fa";
    case "ACTION": return "#3fe0a0";
    case "OBSERVATION": return "#a78bfa";
    case "APPROVAL": return "#fbbf24";
    case "BLOCKED": return "#f87171";
    case "ERROR": return "#f87171";
    case "COMPLETE": return "#3fe0a0";
    default: return "rgba(255,255,255,0.2)";
  }
}
