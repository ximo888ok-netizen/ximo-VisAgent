// OpenAI 兼容协议客户端（DeepSeek / Qwen / GLM / 任意兼容端点）
import type { LLMConfig, ThinkingHint, ThinkingMode } from '@ximo-visagent/shared-types';
import { LLMError, type ChatMessage, type ChatOptions, type ChatResult, type ILLMClient, type ToolDef } from './types';

const OPENAI_CHAT_ENDPOINT = '/chat/completions';

export class OpenAIClient implements ILLMClient {
  readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = { ...config };
    // M15 修复：baseUrl 以 /chat/completions/ 尾斜杠结尾时也能正确匹配
    let url: URL;
    try {
      url = new URL(this.config.baseUrl);
    } catch {
      throw new LLMError(`无效的 Base URL: "${this.config.baseUrl}"，请在设置中检查模型配置`);
    }
    if (!url.pathname.replace(/\/+$/, '').endsWith(OPENAI_CHAT_ENDPOINT)) {
      this.config.baseUrl = this.config.baseUrl.replace(/\/+$/, '') + OPENAI_CHAT_ENDPOINT;
    }
  }

  async chat(messages: ChatMessage[], tools?: ToolDef[], options?: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: 0, // GUI 直操要确定性，不要发散
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;
    // 思考四档（qwen/glm 生效；kimi 无开关字段；deepseek 走自己的 thinkingEffort）
    const provider = this.config.provider;
    // Qwen 视觉高分辨率：默认 false 会将截图缩到 ~2621440 像素（≈1620×1620），
    // 小字和小按钮会糊掉导致坐标飘移。开启后使用固定分辨率策略（16384 Token 上限，
    // 像素上限 16777216），不降采样，保留截图细节。OpenAI 兼容模式下可作顶层参数传递。
    if (provider === 'qwen') body.vl_high_resolution_images = true;
    if (provider === 'qwen' || provider === 'glm') {
      const deep = decideThinking(messages, this.config.thinkingMode ?? 'daily', options?.thinkingHint);
      if (provider === 'qwen') body.enable_thinking = deep;
      else body.thinking = { type: deep ? 'enabled' : 'disabled' };
    } else if (provider === 'deepseek' && this.config.thinkingEffort) {
      // DeepSeek 思考模式（OpenAI 格式）：'off' → thinking disabled；其余 → enabled + reasoning_effort
      if (this.config.thinkingEffort === 'off') {
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = this.config.thinkingEffort;
      }
    }

    let res: Response;
    try {
      res = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new LLMError(`network error: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }

    // M16 修复：响应体非 JSON（网关返回 HTML）时包装为 LLMError
    let json: { choices?: { message?: { content?: string | null; reasoning_content?: unknown; tool_calls?: unknown[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string };
    try {
      json = await res.json() as typeof json;
    } catch {
      const text = await res.text().catch(() => '');
      throw new LLMError(`响应体非 JSON 格式（可能是网关返回 HTML）: ${text.slice(0, 200)}`, res.status);
    }

    const choice = json.choices?.[0];
    if (!choice?.message) throw new LLMError('no choices in response');

    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
      const t = tc as { id?: string; function?: { name?: string; arguments?: string } };
      return {
        id: t.id ?? '',
        name: t.function?.name ?? '',
        args: t.function?.arguments ?? '{}',
      };
    });

    // 思考模式：思维链与 content 同级返回（仅捕获供观测；本架构不回传历史 assistant 消息，
    // tools 请求的 reasoning_content 回传义务不适用——见 docs DeepSeek 思考模式）
    const reasoning = typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : undefined;

    // M17 修复：total_tokens 缺失时从 prompt + completion 计算
    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    const totalTokens = json.usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
      content: choice.message.content ?? null,
      toolCalls,
      usage: { promptTokens, completionTokens, totalTokens },
      model: json.model ?? this.config.model,
      reasoning,
    };
  }

}

// ---------- 思考四档判定（详见 shared-types/config.ts 的 ThinkingMode 注释） ----------

/**
 * 四档总入口：本次调用是否开思考。
 * - daily：恒关；long：step>2 恒开（前 2 步流程化关）；deep：恒开
 * - auto：评分制（complexityScore），软阈值带内按步种子 50% 概率
 * thinkingHint 缺省时（internal 调用），auto 退化为仅按消息静态信号评分。
 */
export function decideThinking(
  messages: ChatMessage[],
  mode: ThinkingMode,
  hint?: ThinkingHint,
): boolean {
  switch (mode) {
    case 'daily': return false;
    case 'deep': return true;
    case 'long': return (hint?.step ?? estimateStep(messages)) > 2;
    case 'auto': {
      const score = complexityScore(messages, hint);
      // 强信号直通：近期失败过半 = 试错中的模型最该停下来想
      if (hint && hint.recentFailures >= 3) return true;
      // 软阈值带：40-59 分按种子 50% 概率（同一步种子固定 → 判定稳定不抖动）
      if (score >= 60) return true;
      if (score >= 40) return seededRandom(hint?.seed ?? 0) < 0.5;
      return false;
    }
  }
}

/**
 * auto 档复杂度评分（0-100）：
 * 历史深度 35 + 上下文规模 25 + 失败密度 30 + 画面停滞 10。
 * 信号叠加是弹性的核心：单信号不够阈值，凑一起就触发。
 */
export function complexityScore(messages: ChatMessage[], hint?: ThinkingHint): number {
  const assistantCount = messages.filter((m) => m.role === 'assistant').length;
  const depth = Math.min(assistantCount, 20) / 20 * 35;

  let textLen = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') textLen += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text' && part.text) textLen += part.text.length;
      }
    }
  }
  const bulk = Math.min(textLen / 12000, 1) * 25;

  const failures = hint ? Math.min(hint.recentFailures, 6) / 6 * 30 : 0;
  const stagnation = hint && hint.noChangeCount >= 2 ? 10 : 0;

  return Math.round(depth + bulk + failures + stagnation);
}

/** 无 hint 时从消息估算步数（assistant 条数的粗略代理） */
function estimateStep(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

/** 简单可复现伪随机（mulberry32 风格）：同一种子同一步判定一致 */
function seededRandom(seed: number): number {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}