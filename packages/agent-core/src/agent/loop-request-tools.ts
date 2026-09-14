// request_tools 元加载（自 loop.ts 迁出，语义零改动）：
// 加载工具集后同迭代内立即重问真实动作（元动作不烧步数、复用本轮感知帧）。
// 最多 2 轮；重问失败即停，由调用方走老路径（下一迭代重新发起）。
import type { ChatMessage, ToolDef } from '@ximo-visagent/llm-providers';
import type { ToolSchema } from '@ximo-visagent/shared-types';
import type { AgentEvent, StepDetail } from './types';
import type { StepRecord } from './memory';
import { applyRequestTools, buildToolDefs, parseModelOutput, type ParsedOutput } from './loop-helpers';

/** 重问用量的最小契约（避免反向依赖 loop-llm 的返回类型） */
export interface RoundUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RequestToolsRoundDeps {
  catalog: ToolSchema[];
  active: Set<string>;
  extraTools?: ToolSchema[];
  /** 同迭代重问一次（复用本轮感知帧 parts） */
  reask: (tools: ToolDef[]) => Promise<{ content: string | null; toolCalls: { name: string; args: string }[]; usage?: RoundUsage } | null>;
  /** 重问产生的用量上抛（loop 累计 token 并发用量事件） */
  onUsage?: (usage: RoundUsage) => void;
}

/** 落账上下文：元加载这一轮的记录/步骤/消息归属（由 loop 提供） */
export interface RequestToolsRoundContext {
  index: number;
  stepStart: number;
  memory: { addStep(record: StepRecord): void };
  stepsDetail: StepDetail[];
  messages: ChatMessage[];
  emit: (event: AgentEvent) => void;
}

/**
 * 处理 request_tools 元加载这一轮并落账，返回本迭代最终应执行的解析结果。
 * 步骤记 level:0（元动作不触宿主），与迁移前逐字段一致。
 */
export async function runRequestToolsRound(
  parsedOutput: ParsedOutput,
  deps: RequestToolsRoundDeps,
  ctx: RequestToolsRoundContext,
): Promise<ParsedOutput> {
  let parsed = parsedOutput;
  for (let metaRound = 0; metaRound < 2 && parsed.actions[0]?.name === 'request_tools'; metaRound++) {
    const args = parsed.actions[0].args;
    const rt = applyRequestTools(args, deps.catalog, deps.active);
    const resultSummary = rt.invalidHint ? `${rt.summary}；${rt.invalidHint}` : rt.summary;
    ctx.memory.addStep({ thought: parsed.thought, actionName: 'request_tools', actionArgs: args, resultSummary });
    if (rt.invalidHint) ctx.memory.addStep({ thought: rt.invalidHint, actionName: null, actionArgs: null, resultSummary: '换正确工具名重试' });
    const step: StepDetail = { index: ctx.index, thought: parsed.thought, actionName: 'request_tools', args, level: 0, ok: rt.ok, resultSummary, durationMs: Date.now() - ctx.stepStart };
    ctx.stepsDetail.push(step);
    ctx.emit({ type: 'step', step });
    // 同迭代重问：注入加载结果，要求直接输出动作
    ctx.messages.push({ role: 'system', content: `${resultSummary}。请基于当前截图直接输出你本来要执行的动作，不要再次调用 request_tools。` });
    const res2 = await deps.reask(buildToolDefs(deps.active, deps.extraTools));
    if (!res2) break; // 重问失败走老路径：下迭代重新发起
    if (res2.usage) deps.onUsage?.(res2.usage);
    parsed = parseModelOutput(res2.content, res2.toolCalls);
  }
  return parsed;
}
