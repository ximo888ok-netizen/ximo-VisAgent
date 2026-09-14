// orchestrator-autoresume.ts — 条目3.B：应用重启后自动恢复最近的未完成任务
//
// ⚠ 诚实说明（防止误以为是"断点续传"）：
// 恢复语义 = 以新 taskId 重跑，注入"已完成步骤骨架 + 教训摘要"（resumeInterrupted 已实现），
// 并依赖模型看到的第一帧实时截图自行核对现场。不是从第 N 步精确续跑，也不回滚已产生的副作用。
import type { Orchestrator } from './orchestrator';
import type { ZODB } from './audit-store';

/** 24 小时内的未完成任务才恢复（更早的视为垃圾）；A-M4 断点对账沿用同一窗口（规划 §3.6） */
export const RESUME_WINDOW_MS = 24 * 60 * 60_000;
const INTERRUPTED_STATUSES = ['RUNNING', 'PAUSED', 'WAITING_APPROVAL', 'QUEUED'];

export interface AutoResumeDeps {
  audit: ZODB;
  orchestrator: Orchestrator;
  /** 是否启用（AgentConfig.autoResumeInterrupted，默认 true） */
  enabled: boolean;
}

/**
 * 扫描审计库中 24 小时内中断/排队的任务，自动恢复最近的一个。
 * 只恢复 1 个：编排器并发恒为 1，自动挑最近的最稳（其余仍可人工在历史面板续跑）。
 * 恢复结果与错误都走返回值，由调用方（bootstrap）决定如何记录/通知——本函数不做 IO 之外的副作用。
 */
export function autoResumeInterrupted(deps: AutoResumeDeps): { resumed: string | null; goal: string | null; error?: string } {
  if (!deps.enabled) return { resumed: null, goal: null };
  try {
    const now = Date.now();
    const candidates = deps.audit
      .listTasks(100)
      .filter((t) => INTERRUPTED_STATUSES.includes(t.status) && now - t.createdAt <= RESUME_WINDOW_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = candidates[0];
    if (!latest) return { resumed: null, goal: null };
    void deps.orchestrator.resumeInterrupted(latest.taskId);
    return { resumed: latest.taskId, goal: latest.goal };
  } catch (err) {
    return { resumed: null, goal: null, error: (err as Error).message };
  }
}
