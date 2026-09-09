/**
 * useSopRecommendation.ts — 输入防抖：相似 SOP 模板推荐（600ms，仅空闲态）
 */
import { useEffect } from "react";
import { useIslandStore } from "../../../store/islandStore";

export function useSopRecommendation(goal: string): void {
  const taskRunning = useIslandStore((s) => s.taskRunning);
  const recommendation = useIslandStore((s) => s.recommendation);
  const fetchRecommendation = useIslandStore((s) => s.fetchRecommendation);
  const setRecommendation = useIslandStore((s) => s.setRecommendation);

  useEffect(() => {
    if (taskRunning || goal.trim().length < 4) {
      if (recommendation) setRecommendation(null, "");
      return;
    }
    const timer = setTimeout(() => void fetchRecommendation(goal), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, taskRunning]);
}
