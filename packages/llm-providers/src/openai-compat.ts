// OpenAI 兼容协议客户端（DeepSeek / Qwen / GLM / 任意兼容端点）
import type { LLMConfig } from '@desktop-agi/shared-types';
import { LLMError, type ChatMessage, type ChatResult, type ILLMClient, type ToolDef } from './types';

const OPENAI_CHAT_ENDPOINT = '/chat/completions';

export class OpenAIClient implements ILLMClient {
  readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = { ...config };
    const url = new URL(this.config.baseUrl);
    if (!url.pathname.endsWith(OPENAI_CHAT_ENDPOINT)) {
      this.config.baseUrl = this.config.baseUrl.replace(/\/+$/, '') + OPENAI_CHAT_ENDPOINT;
    }
  }

  async chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: 0.2,
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;

    let res: Response;
    try {
      res = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new LLMError(`network error: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };

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

    return {
      content: choice.message.content ?? null,
      toolCalls,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
      model: json.model ?? this.config.model,
    };
  }
}