// Qwen 联网搜索：通过 OpenAI 兼容端点流式调用 enable_search
//
// Qwen 多模态模型联网搜索约束（官方文档）：
// 1. 必须流式调用（stream:true），否则返回 "Non-streaming mode does not support Web Search"
// 2. 参数：enable_search: true + search_options: { search_strategy, enable_source }
// 3. 搜索策略因模型而异：
//    - qwen3.5-omni 系列 → "agent"（仅支持）
//    - Qwen3.8 系列 → 不支持 "agent"，用默认（turbo/max）
//    - 其余模型 → "turbo"/"max"/"agent" 均可
//
// 实现方式：在 OpenAI 兼容 /chat/completions 端点上附加 enable_search + stream:true，
// 读取 SSE 流拼接 content，返回搜索结果摘要文本。
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

/** 搜索策略选择规则 */
function pickSearchStrategy(model: string): string | undefined {
  const lower = model.toLowerCase();
  // qwen3.5-omni 系列仅支持 agent 策略
  if (lower.includes('omni')) return 'agent';
  // Qwen3.8 系列不支持 agent，用默认（不传 searchStrategy = 走服务端默认 turbo）
  if (lower.startsWith('qwen3.8') || lower.startsWith('qwen3-8')) return undefined;
  // 其余模型默认用 turbo
  return 'turbo';
}

/**
 * Qwen 联网搜索客户端。
 *
 * 复用主 LLM 的 provider/baseUrl/apiKey/model 配置——搜索与主大脑共用一个 Key，
 * 不需要用户额外配置。仅在 provider 为 'qwen' 时有效；其他供应商返回错误。
 */
export class WebSearchClient {
  constructor(private config: LLMConfig) {}

  async search(query: string): Promise<SearchResult> {
    if (this.config.provider !== 'qwen') {
      throw new LLMError(`联网搜索仅支持 Qwen 系列模型（当前供应商: ${this.config.provider}）`);
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    // 确保 URL 指向 /chat/completions
    const url = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const searchStrategy = pickSearchStrategy(this.config.model);
    const searchOptions: Record<string, unknown> = {
      enable_source: true,
    };
    if (searchStrategy) searchOptions.search_strategy = searchStrategy;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: '你是一个搜索助手。根据用户的问题进行联网搜索，用中文简洁回答。如果有来源链接，在回答末尾列出。不要编造信息。',
        },
        { role: 'user', content: query },
      ],
      temperature: 0.3,
      stream: true, // Qwen 联网搜索强制流式
      enable_search: true,
      search_options: searchOptions,
      // Qwen 视觉高分辨率：与主客户端保持一致
      vl_high_resolution_images: true,
    };

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

    if (!res.body) {
      throw new LLMError('搜索响应无 body（流式响应需 body stream）');
    }

    // 解析 SSE 流拼接 content
    const { content: raw, totalTokens } = await parseSSEStream(res.body);

    // 净化：去套话 + 去来源链接块 + 压缩长度
    const content = sanitizeSearchResult(raw);

    return {
      content: content || '(搜索未返回结果)',
      totalTokens,
    };
  }
}

/** 搜索结果净化：去套话、去来源链接块、压缩长度
 *
 * 噪声来源：
 * 1. 模型套话：「根据搜索结果」「以下是」「根据以上信息」等
 * 2. 来源链接块：模型末尾常列出 [1]url://... [2]url://... 占大量 token
 * 3. 过长回答：Qwen 搜索回答可能 2000+ 字，灌入 Agent 历史会占满窗口
 */
function sanitizeSearchResult(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  // 1. 去除常见套话前缀
  text = text.replace(/^(根据搜索结果[，,]?|根据以上信息[，,]?|以下是为您找到的相关信息[：:]?|以下是相关搜索结果[：:]?|根据网络搜索结果[，,]?|综合搜索结果[，,]?)\s*/g, '');

  // 2. 去除末尾来源链接块：[1] https://... [2] https://... 或 参考链接：\nurl://...
  // 匹配末尾连续多行链接列表
  text = text.replace(/\n\s*(参考来源|参考链接|来源[：:])\s*[\s\S]*$/i, '');
  text = text.replace(/\n\s*\[\d+\]\s*https?:\/\/[\s\S]*$/i, '');
  // 去除行内来源标记：[1] [2] 等
  text = text.replace(/\s*\[\d+\]\s*/g, ' ');

  // 3. 去除多余空行（搜索回答有时有连续空行）
  text = text.replace(/\n{3,}/g, '\n\n');

  // 4. 长度压缩：保留前 800 字符（足够 Agent 提取关键事实）
  if (text.length > 800) {
    // 在句子边界截断，避免半句话
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

      // SSE 事件以 \n\n 分隔
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // 每行解析 data: 前缀
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
          } catch {
            // 跳过无法解析的行（可能是心跳/注释行）
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content: content.trim(), totalTokens };
}
