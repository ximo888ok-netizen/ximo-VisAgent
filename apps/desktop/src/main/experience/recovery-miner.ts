/**
 * recovery-miner.ts — 把失败轨迹接进规则库的观测端（提炼时机与节流）
 *
 * 两个提炼时机（同一套纯函数，两种喂法）：
 * 1. 任务内重复失败点：循环每步都过这里。当「同一工具 + 同一参数形态」已经连败
 *    ≥REPEAT_THRESHOLD 次、紧接着出现一个换了工具的成功动作（= 证据里真实有效的对策），
 *    立刻产候选规则。停滞拦截与熔断拒绝在执行侧就是 ok=false 的一步，天然被同一条路径抓到。
 * 2. 任务终态：失败 / 超步数 / 被人工中止（以及崩溃收敛出的 FAILED）时，对整条轨迹再跑一次，
 *    补上「终态才看得出全貌」的簇（例如最后一步仍卡在同一个无效动作上）。
 *
 * 节流与纪律：
 * - 一个任务内同一特征只产一次（否则长尾成功会把 timesObserved 刷成假证据）；
 * - 只看滚动窗口（活体）/ 全轨迹（终态），成本 O(窗口)；
 * - 提炼本身不改任何行为：产出的都是 enabled=0 草稿 + 宪法门提案（见 recovery-rules.ts）。
 */
import type { AgentEvent, AgentRunResult } from '@ximo-visagent/agent-core';
import { mineCandidates, toTraceStep, type RuleCandidate, type TraceStep } from './recovery-signature';
import { proposeRecoveryRule, recordRecoveryHit, settleAdoptionResult, type RecoveryGovernanceDeps } from './recovery-rules';
import type { RecoveryRuleRow } from '../stores/experience-types';

/** 活体提炼只看最近这么多步（长任务里不必为每次成功重扫 600 步） */
const LIVE_WINDOW = 40;

export type RecoveryMinerDeps = RecoveryGovernanceDeps;

export interface RecoveryMiner {
  /** 订阅 AgentLoop 事件流：记参数形态、累计失败簇、见到对策即提炼 */
  observeEvent(ev: AgentEvent): void;
  /** matcher 侧取失败步的参数形态（argPattern 的比对材料） */
  argsAt(stepIndex: number): Record<string, unknown> | undefined;
  /** matcher 命中记账（进现有审计通道） */
  onHit(rule: RecoveryRuleRow, reason: string): void;
  /** 采纳结果结算：成/败计数 + 审计留痕 + 连败降权 */
  onResult(ruleId: string, success: boolean): void;
  /** 终态补提炼（失败 / 超步数 / 被中止） */
  finish(result: AgentRunResult): void;
}

function isTerminalFailure(result: AgentRunResult): boolean {
  return result.status !== 'COMPLETED';
}

export function createRecoveryMiner(deps: RecoveryMinerDeps): RecoveryMiner {
  const argsByStep = new Map<number, Record<string, unknown>>();
  const recent: TraceStep[] = [];
  /** 本任务已产过的特征：同特征不重复提案（重复证据合并交给存储层） */
  const mined = new Set<string>();

  function propose(candidates: RuleCandidate[]): void {
    for (const c of candidates) {
      if (mined.has(c.signature)) continue;
      mined.add(c.signature);
      try {
        proposeRecoveryRule(deps, c);
      } catch (err) {
        console.error('[recovery-miner] 规则提案失败', err instanceof Error ? err.message : err);
      }
    }
  }

  return {
    observeEvent(ev: AgentEvent): void {
      if (ev.type !== 'step' || !ev.step.actionName) return;
      const trace = toTraceStep(ev.step);
      if (ev.step.args) argsByStep.set(ev.step.index, ev.step.args);
      recent.push(trace);
      if (recent.length > LIVE_WINDOW) recent.shift();
      // 只在「新的成功动作」上提炼：此刻才看得见「换路成功」这条对策
      if (trace.ok) propose(mineCandidates(recent));
    },

    argsAt(stepIndex: number): Record<string, unknown> | undefined {
      return argsByStep.get(stepIndex);
    },

    onHit(rule: RecoveryRuleRow, reason: string): void {
      try {
        recordRecoveryHit(deps, rule, reason);
      } catch (err) {
        console.error('[recovery-miner] 命中记账失败', err instanceof Error ? err.message : err);
      }
    },

    onResult(ruleId: string, success: boolean): void {
      try {
        settleAdoptionResult(deps, ruleId, success);
      } catch (err) {
        console.error('[recovery-miner] 采纳结算失败', err instanceof Error ? err.message : err);
      }
    },

    finish(result: AgentRunResult): void {
      // 熔断/止损这类「一步都没成功过」的病理只能从完整轨迹里看出来；
      // 成功任务不补提炼（活体路径已在对策出现时记过账）
      if (!isTerminalFailure(result)) return;
      try {
        propose(mineCandidates(result.stepsDetail.map(toTraceStep)));
      } catch (err) {
        console.error('[recovery-miner] 终态提炼失败', err instanceof Error ? err.message : err);
      }
    },
  };
}
