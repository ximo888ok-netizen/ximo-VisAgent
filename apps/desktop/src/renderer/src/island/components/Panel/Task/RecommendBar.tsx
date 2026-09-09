/**
 * RecommendBar.tsx — 相似模板推荐条（输入 ≥4 字符防抖匹配）
 */
import { useIslandStore } from "../../../store/islandStore";

export function RecommendBar() {
  const recommendation = useIslandStore((s) => s.recommendation);
  const setRecommendation = useIslandStore((s) => s.setRecommendation);
  const pushView = useIslandStore((s) => s.pushView);

  if (!recommendation) return null;

  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-blue-500/25 bg-blue-500/[0.06] px-3 py-2 island-fade-up">
      <span className="min-w-0 flex-1 truncate text-[11px] text-blue-200/90">
        检测到相似模板「{recommendation.name}」，直接复用？
      </span>
      <button
        className="island-btn island-btn--primary shrink-0 px-2.5 text-[10.5px]"
        onClick={() => pushView({ kind: "sopRun", sopId: recommendation.sopId })}
        data-interactive
      >
        使用
      </button>
      <button className="island-btn island-btn--ghost shrink-0 px-2.5 text-[10.5px]" onClick={() => setRecommendation(null, "")} data-interactive>
        忽略
      </button>
    </div>
  );
}
