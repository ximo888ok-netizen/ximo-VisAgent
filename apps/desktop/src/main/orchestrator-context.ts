/**
 * orchestrator-context.ts — 每次任务启动前的注入物装配（从 orchestrator.ts 拆出）
 *
 * 装配的是「喂给模型的历史经验」：岗位角色、活跃 Prompt guidance、工作记忆、
 * 世界模型事实、多轮会话上下文。全部读取失败都只降级不阻断（读不到经验，任务照样要能跑）。
 */
import type { ExperienceStore } from './experience-store';
import type { MemoryStore } from './memory-store';
import type { ConversationStore } from './conversation-store';
import type { EmployeeStore } from './stores/employee-store';
import type { RoleContext } from '@ximo-visagent/agent-core';

/** 世界模型注入条数与置信度下限（过低会把偶发结论当事实喂给模型） */
const ENV_FACT_TOP_K = 15;
const ENV_FACT_MIN_CONFIDENCE = 0.3;

export interface InjectionDeps {
  experience?: ExperienceStore;
  memory?: MemoryStore;
  conversation?: ConversationStore;
  employee?: EmployeeStore;
}

export interface TaskInjections {
  guidance?: string;
  memoryFacts?: string[];
  conversationContext?: { role: 'user' | 'assistant'; content: string }[];
  /** M2: 岗位角色上下文（身份/职责/边界/目标） */
  roleContext?: RoleContext;
}

export function buildTaskInjections(
  deps: Omit<InjectionDeps, 'memoryEnabled'>,
  memoryEnabled: boolean,
): TaskInjections {
  return {
    guidance: readActiveGuidance(deps.experience),
    memoryFacts: buildMemoryFacts(deps, memoryEnabled),
    conversationContext: deps.conversation && deps.conversation.getContext().length > 0
      ? deps.conversation.getContext()
      : undefined,
    roleContext: readRoleContext(deps.employee),
  };
}

/** M2: 从员工域读取活跃岗位，组装为 RoleContext 注入 prompt 固定段 */
function readRoleContext(employee?: EmployeeStore): RoleContext | undefined {
  if (!employee) return undefined;
  try {
    const positions = employee.listPositions();
    const active = positions.find((p) => p.status === 'active');
    if (!active) return undefined;

    let dutyScope: string[] | undefined;
    let dutyBoundary: string[] | undefined;
    let goals: string[] | undefined;

    try { dutyScope = JSON.parse(active.dutyScopeJson) as string[]; } catch { /* 兜底空 */ }
    try { dutyBoundary = JSON.parse(active.dutyBoundaryJson) as string[]; } catch { /* 兜底空 */ }
    try { goals = JSON.parse(active.goalsJson) as string[]; } catch { /* 兜底空 */ }

    return {
      name: active.name,
      roleProfile: active.roleProfile || undefined,
      reportTo: active.reportTo || undefined,
      dutyScope: dutyScope && dutyScope.length > 0 ? dutyScope : undefined,
      dutyBoundary: dutyBoundary && dutyBoundary.length > 0 ? dutyBoundary : undefined,
      goals: goals && goals.length > 0 ? goals : undefined,
    };
  } catch (err) {
    console.error('[employee] 读取活跃岗位失败', err);
    return undefined;
  }
}

/** v3 M16: 当前活跃 Prompt 版本的可演化段（缺省 = 内置默认） */
function readActiveGuidance(experience?: ExperienceStore): string | undefined {
  if (!experience) return undefined;
  try {
    return experience.getActivePromptVersion()?.guidance ?? undefined;
  } catch (err) {
    console.error('[experience] 读取活跃 Prompt 版本失败', err);
    return undefined;
  }
}

/** 工作记忆（用户显式启用的条目）+ 世界模型 top-k + 事实卡 top-5，合并注入 */
function buildMemoryFacts(deps: InjectionDeps, memoryEnabled: boolean): string[] | undefined {
  const memoryFacts = memoryEnabled && deps.memory ? deps.memory.takeEnabled() : undefined;
  const envFacts = readEnvFacts(deps.experience);
  const factCards = readFactCards(deps.employee);
  const merged = [...(memoryFacts ?? []), ...envFacts, ...factCards];
  return merged.length > 0 ? merged : undefined;
}

/**
 * M4: 从员工域读取已确认的事实卡（FTS5 不适用于无 query 场景，这里取 top-k by confidence）
 * 注入格式：[资料] topic (source: sourceRef) — claim
 */
const FACT_CARD_TOP_K = 5;
const FACT_CARD_MIN_CONFIDENCE = 0.5;

function readFactCards(employee?: EmployeeStore): string[] {
  if (!employee) return [];
  try {
    const position = employee.listPositions().find((p) => p.status === 'active');
    if (!position) return [];
    const cards = employee.listFactCards(position.id)
      .filter((c) => c.status === 'active' && c.confirmed && c.confidence >= FACT_CARD_MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, FACT_CARD_TOP_K);
    return cards.map((c) => `[资料] ${c.topic} (source: ${c.sourceRef}) — ${c.claim}`);
  } catch (err) {
    console.error('[employee] 事实卡读取失败', err);
    return [];
  }
}

function readEnvFacts(experience?: ExperienceStore): string[] {
  if (!experience) return [];
  try {
    return experience.listEnvFacts()
      .filter((f) => f.enabled && f.confidence >= ENV_FACT_MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, ENV_FACT_TOP_K)
      .map((f) => `[${f.kind}] ${f.content}`);
  } catch (err) {
    console.error('[experience] 世界模型读取失败', err);
    return [];
  }
}
