/**
 * SopCard.tsx — 单个 SOP 模板卡（名称/描述/步数/运行次数 + 运行·导出·删除）
 */
import type { SopRowPayload } from "@shared/island-contracts";

export function SopCard({ sop, confirming, onRun, onDelete, onExport }: { sop: SopRowPayload; confirming: boolean; onRun: () => void; onDelete: () => void; onExport: () => void }) {
  const steps = (() => {
    try {
      const arr = JSON.parse(sop.stepsJson) as unknown[];
      return arr.length;
    } catch {
      return 0;
    }
  })();

  return (
    <div data-interactive className="group flex flex-col rounded-xl ig-bg-panel px-3 py-2.5 transition hover:ig-bg-panel-hover">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium t-strong" title={sop.name}>{sop.name}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className="rounded-md px-1.5 py-0.5 text-[10px] t-faint opacity-0 transition group-hover:opacity-100 hover:t-body"
            onClick={onExport}
            title="导出模板（剪贴板/文件）"
          >
            ⤓
          </button>
          <button
            className={`rounded-md px-1.5 py-0.5 text-[10px] transition ${
              confirming
                ? "bg-red-500/20 text-red-300 opacity-100"
                : "t-faint opacity-0 group-hover:opacity-100 hover:text-red-300"
            }`}
            onClick={onDelete}
            title={confirming ? "再次点击确认删除" : "删除模板"}
          >
            {confirming ? "确认删除?" : "✕"}
          </button>
        </div>
      </div>
      <div className="mt-0.5 line-clamp-2 text-[10px] t-muted" title={sop.description || sop.goalTemplate}>
        {sop.description || sop.goalTemplate}
      </div>
      <div className="mt-auto flex items-center justify-between pt-2">
        <span className="text-[9.5px] t-faint">
          {steps} 步 · 运行 {sop.runCount} 次
          {sop.lastRunAt && ` · 近次 ${new Date(sop.lastRunAt).toLocaleDateString("zh-CN")}`}
        </span>
        <button
          className="island-btn island-btn--primary h-6 px-2.5 text-[10px]"
          onClick={onRun}
        >
          运行
        </button>
      </div>
    </div>
  );
}
