/**
 * orchestrator-experience.ts — 任务终态的经验层挂钩（从 orchestrator.ts 拆出）
 *
 * 顺序即数据流：会话记录 → 工作记忆提炼 → 世界模型同步。
 * 每一步都不许打断主链路，但失败必须可见 —— 静默 catch 曾让字段错配存活很久。
 */
import type { AgentRunResult } from '@ximo-visagent/agent-core';
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { ZODB } from './audit-store';
import type { MemoryStore } from './memory-store';
import type { ExperienceStore } from './experience-store';
import type { RecoveryMiner } from './experience/recovery-miner';
import { distillAndSaveSop } from './sop-distiller';
import { publishStep } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';

/** 终态挂钩需要的任务上下文与依赖 */
export interface ExperienceHooks {
  taskId: string;
  goal: string;
  sopId?: string;
  audit: ZODB;
  memory?: MemoryStore;
  experience?: ExperienceStore;
  /** 条目6 写入侧：任务终态（失败 / 超步数 / 被中止）补一次失败归因提炼 */
  recoveryMiner?: RecoveryMiner | null;
  recordConversation?: (goal: string, answer: string) => void;
  text: ILLMClient;
  memoryEnabled: boolean;
}

/** 会话记录 + 记忆 + 世界模型（均异步，不阻塞终态） */
export function finalizeTaskExperience(t: ExperienceHooks, result: AgentRunResult): void {
  t.recordConversation?.(t.goal, result.finalAnswer);

  // 失败归因 → 恢复规则草稿（同步写库、只登记提案，不改变模型行为）
  t.recoveryMiner?.finish(result);

  // SOP 蒸馏：成功任务自动提取可复用骨架（异步，不阻塞主流程）
  if (result.status === 'COMPLETED' && t.audit) {
    void distillAndSaveSop(t.text, t.audit, t.taskId, t.goal, result.stepsDetail)
      .then((sopId) => {
        if (sopId) publishStep(createStepEvent('thinking', `已从本次任务蒸馏 SOP 骨架（候选）`));
      })
      .catch((err: Error) => console.error('[experience] SOP 蒸馏失败', err));
  }

  // skill_runs 记账（C：把恒 0 的空表变真实使用统计）——凡用过 SOP 的任务都落一条 run（outcome=终态）。
  // 只记真实发生的 active run；shadow A/B 对照需另跑对照组，不在此伪造。
  if (t.sopId && t.experience) {
    try {
      t.experience.insertSkillRun({
        id: crypto.randomUUID(),
        sopId: t.sopId,
        taskId: t.taskId,
        mode: 'active',
        adopted: true,
        outcome: result.status,
        stepsUsed: result.steps,
        tokens: result.totalTokens,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error('[experience] skill_run 记账失败', err);
    }
  }

  if (result.status === 'COMPLETED' && t.memoryEnabled && t.memory) {
    void t.memory
      .extractFromTask(t.text, t.taskId, t.goal, result.finalAnswer, result.stepsDetail)
      .then((added) => {
        if (added > 0) publishStep(createStepEvent('thinking', `已提炼 ${added} 条工作记忆`));
      })
      .catch((err: Error) => console.error('[experience] 工作记忆提炼失败', err));
  }

  syncWorldModel(t, result);
}

/** 把 MemoryStore 新产生的事实同步进世界模型 env_facts */
function syncWorldModel(t: ExperienceHooks, result: AgentRunResult): void {
  if (result.status !== 'COMPLETED' || !t.experience || !t.memory) return;
  void Promise.resolve().then(() => {
    try {
      for (const mem of t.memory!.list().slice(0, 10)) {
        if (!mem.enabled) continue;
        if (t.experience!.findSimilarFact(mem.content)) continue;
        t.experience!.insertEnvFact({
          kind: mem.kind === 'preference' ? 'preference' : 'fact',
          content: mem.content,
          confidence: 0.6,
          timesObserved: 1,
          sourceTaskId: mem.sourceTaskId,
          lastVerifiedAt: null,
          enabled: true,
        });
      }
    } catch (err) {
      console.error('[experience] 世界模型同步失败', err);
    }
  });
}
