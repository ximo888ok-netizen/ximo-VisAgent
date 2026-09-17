// 联网搜索：多 provider 支持（Qwen/GLM/Kimi）
//
// 各家搜索 API 差异：
// 1. Qwen：/chat/completions + enable_search:true + stream:true（SSE 流式）
// 2. GLM（智谱）：/chat/completions + tools=[builtin_function.$web_search]（工具调用模式）
// 3. Kimi（月之暗面）：/chat/completions + tools=[builtin_function.$web_search]（同 GLM，内置工具）
//
// 实现方式：按 provider 分发到对应的搜索策略，公共逻辑（SSE 解析/净化）复用。
import type { LLMConfig } from '@ximo-visagent/shared-types';
import { LLMError } from './types';

/** 搜索结果 */
export interface SearchResult {
  /** 模型基于搜索结果生成的回答文本（已净化） */
  content: string;
  /** 搜索引用来源（若 enable_source 开启，模型通常在回答中附带） */
  sources?: string[];
  /** 总 token 消耗（搜索+生成） */
  totalTokens: number;
}

/** 条目2：provider 是否支持联网搜索（与 WebSearchClient.search 的 provider 判断同口径，单一事实来源） */
export function supportsWebSearch(provider: string): boolean {
  return provider === 'qwen' || provider === 'glm' || provider === 'kimi';
}

/**
 * 联网搜索客户端（多 provider）。
 * 复用主 LLM 的 provider/baseUrl/apiKey/model 配置——搜索与主大脑共用一个 Key。
 */
export class WebSearchClient {
  constructor(private config: LLMConfig) {}

  async search(query: string): Promise<SearchResult> {
    switch (this.config.provider) {
      case 'qwen':
        return this.searchQwen(query);
      case 'glm':
      case 'kimi':
        return this.searchViaToolCall(query);
      default:
        throw new LLMError(`联网搜索不支持供应商「${this.config.provider}」（支持 qwen/glm/kimi）`);
    }
  }

  // ---------- Qwen：enable_search SSE 流式 ----------
  private async searchQwen(query: string): Promise<SearchResult> {
    const url = this.chatUrl();
    const searchStrategy = pickSearchStrategy(this.config.model);
    const searchOptions: Record<string, unknown> = { enable_source: true };
    if (searchStrategy) searchOptions.search_strategy = searchStrategy;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: '你是一个搜索助手。根据用户的问题进行联网搜索，用中文简洁回答。如果有来源链接，在回答末尾列出。不要编造信息。' },
        { role: 'user', content: query },
      ],
      temperature: 0.3,
      stream: true,
      enable_search: true,
      search_options: searchOptions,
      vl_high_resolution_images: true,
    };

    const res = await this.fetchSSE(url, body);
    const { content: raw, totalTokens } = await parseSSEStream(res.body!);
    const content = sanitizeSearchResult(raw);
    return { content: content || '(搜索未返回结果)', totalTokens };
  }

  // ---------- GLM/Kimi：内置工具调用 $web_search ----------
  private async searchViaToolCall(query: string): Promise<SearchResult> {
    const url = this.chatUrl();
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: '你是一个搜索助手。根据用户的问题进行联网搜索，用中文简洁回答。如果有来源链接，在回答末尾列出。不要编造信息。' },
        { role: 'user', content: query },
      ],
      temperature: 0.3,
      // GLM/Kimi 内置搜索工具：模型自动调用 $web_search 执行联网搜索
      tools: [{
        type: 'function',
        function: {
          name: 'builtin_function.$web_search',
          description: '联网搜索工具，根据用户查询返回搜索结果',
          parameters: { type: 'object', properties: { search_query: { type: 'string', description: '搜索关键词' } } },
        },
      }],
      tool_choice: 'auto',
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LLMError(`搜索请求失败: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`搜索请求 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }

    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const totalTokens = data.usage?.total_tokens ?? 0;
    const sanitized = sanitizeSearchResult(content);
    return { content: sanitized || '(搜索未返回结果)', totalTokens };
  }

  // ---------- 公共 HTTP ----------
  private chatUrl(): string {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  }

  private async fetchSSE(url: string, body: Record<string, unknown>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LLMError(`搜索请求失败: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`搜索请求 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    if (!res.body) throw new LLMError('搜索响应无 body（流式响应需 body stream）');
    return res;
  }
}

/** Qwen 搜索策略选择规则 */
function pickSearchStrategy(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('omni')) return 'agent';
  if (lower.startsWith('qwen3.8') || lower.startsWith('qwen3-8')) return undefined;
  return 'turbo';
}

/** 搜索结果净化：去套话、去来源链接块、压缩长度 */
function sanitizeSearchResult(raw: string): string {
  let text = raw.trim();
  if (!text) return '';
  // 1. 去除常见套话前缀
  text = text.replace(/^(根据搜索结果[，,]?|根据以上信息[，,]?|以下是为您找到的相关信息[：:]?|以下是相关搜索结果[：:]?|根据网络搜索结果[，,]?|综合搜索结果[，,]?)\s*/g, '');
  // 2. 去除末尾来源链接块
  text = text.replace(/\n\s*(参考来源|参考链接|来源[：:])\s*[\s\S]*$/i, '');
  text = text.replace(/\n\s*\[\d+\]\s*https?:\/\/[\s\S]*$/i, '');
  text = text.replace(/\s*\[\d+\]\s*/g, ' ');
  // 3. 去除多余空行
  text = text.replace(/\n{3,}/g, '\n\n');
  // 4. 长度压缩
  if (text.length > 800) {
    const cut = text.slice(0, 800);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
    text = lastPunct > 400 ? cut.slice(0, lastPunct + 1) : cut + '…';
  }
  return text.trim();
}

/** 解析 OpenAI 兼容 SSE 流，拼接 delta.content */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ content: string; totalTokens: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let totalTokens = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { total_tokens?: number };
            };
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) content += delta;
            if (obj.usage?.total_tokens) totalTokens = obj.usage.total_tokens;
          } catch { /* 跳过无法解析的行 */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { content: content.trim(), totalTokens };
}
