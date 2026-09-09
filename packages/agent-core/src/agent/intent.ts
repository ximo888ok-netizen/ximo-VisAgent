// 意图识别：判断用户消息是「纯对话」还是「需要操作电脑的任务」
// 纯对话直接回答（不截图、不感知 UIA、不调工具），操作任务才进入 ReAct 循环
import type { ChatMessage, ILLMClient } from '@ximo-visagent/llm-providers';
import { chatWithRetry } from './loop-llm';
import type { AgentEvent } from './types';

export type AgentIntent = 'CHAT' | 'TASK';

export interface IntentResult {
  intent: AgentIntent;
  /** CHAT 时模型直接给出的完整回答 */
  answer?: string;
}

const INTENT_PROMPT = `你是意图分类器。判断用户消息是需要操作这台电脑才能完成，还是纯对话即可回答。
- TASK（需要操作电脑）：打开/关闭应用、界面点击/输入、读写文件、Excel/浏览器操作、查看屏幕当前内容等。
- CHAT（无需操作电脑）：问候寒暄、询问你的身份/能力、通用知识问答、计算、翻译、写作、闲聊、建议咨询等。
无法确定时返回 TASK（宁可多问一步也不能漏操作）。
只输出 JSON，不要其他文字。格式：
- 操作类: {"intent":"TASK"}
- 对话类: {"intent":"CHAT","answer":"直接给用户的完整回答"}`;

export function buildIntentMessages(goal: string): ChatMessage[] {
  return [
    { role: 'system', content: INTENT_PROMPT },
    { role: 'user', content: goal },
  ];
}

/** 容错解析：非 JSON / 字段缺失一律回退 TASK（保持旧行为，安全方向） */
export function parseIntent(content: string | null): IntentResult {
  const text = content?.trim() ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { intent?: unknown; answer?: unknown };
      if (obj.intent === 'CHAT') {
        const answer = typeof obj.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : undefined;
        return { intent: 'CHAT', answer };
      }
      if (obj.intent === 'TASK') return { intent: 'TASK' };
    } catch { /* 非 JSON，回退 TASK */ }
  }
  return { intent: 'TASK' };
}

/** 意图识别整段（自 loop.ts 拆出）：判 CHAT 时补齐回答。返回 { answer, tokens }；TASK/识别失败返回 null */
export async function resolveChatIntent(
  textLLM: ILLMClient,
  goal: string,
  llmMaxRetries: number,
  emit: (e: AgentEvent) => void,
): Promise<{ answer: string; tokens: number } | null> {
  const ires = await chatWithRetry(textLLM, buildIntentMessages(goal), [], llmMaxRetries, emit);
  if (!ires) return null;
  const tokens = ires.usage.totalTokens;
  emit({ type: 'llm_usage', promptTokens: ires.usage.promptTokens, completionTokens: ires.usage.completionTokens });
  const { intent, answer } = parseIntent(ires.content);
  if (intent !== 'CHAT') return null;
  if (answer) return { answer, tokens };
  // 模型只回了意图没带回答：补一次直答调用
  const ares = await chatWithRetry(textLLM, [{ role: 'user', content: goal }], [], llmMaxRetries, emit);
  if (!ares) return null;
  emit({ type: 'llm_usage', promptTokens: ares.usage.promptTokens, completionTokens: ares.usage.completionTokens });
  const chatAnswer = ares.content?.trim();
  return chatAnswer ? { answer: chatAnswer, tokens: tokens + ares.usage.totalTokens } : null;
}
