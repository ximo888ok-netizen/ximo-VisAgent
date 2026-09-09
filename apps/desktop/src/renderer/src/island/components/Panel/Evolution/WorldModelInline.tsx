/**
 * WorldModelInline.tsx — 演化面板「世界模型」页的事实速览
 *
 * 刻意比设置页的 WorldModelPanel 精简：只读、无搜索与录入表单，
 * 演化页看的是「Agent 目前知道哪些环境事实」，管理入口在设置页。
 */
import type { EnvFactRowPayload } from "@shared/island-contracts";

export function WorldModelInline({ envFacts }: { envFacts: EnvFactRowPayload[] }) {
  return (
    <div className="space-y-1.5">
      <span className="text-[11px] t-strong font-medium">世界模型事实</span>
      {envFacts.length === 0 && (
        <div className="flex h-16 items-center justify-center text-[11px] t-faint">
          暂无事实 · 任务完成后自动提炼
        </div>
      )}
      {envFacts.slice(0, 30).map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded-lg ig-bg-panel px-2.5 py-2">
          <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-300">{f.kind}</span>
          <span className="text-[11px] t-body flex-1 truncate">{f.content}</span>
          <span className="text-[9px] t-faint tabular-nums">{Math.round(f.confidence * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
