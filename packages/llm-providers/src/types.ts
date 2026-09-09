// LLM 统一接口（OpenAI 兼容协议）
import type { LLMConfig, ThinkingHint } from '@ximo-visagent/shared-types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  // LIB-03 修复：OpenAI 兼容协议要求 tool 消息必须携带 tool_call_id
  tool_call_id?: string;
  // assistant 消息携带 tool_calls（OpenAI 协议）
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  /** detail: DeepSeek 图像理解处理档位（low=缩到 512×512！original=保留原图）。不显式设置可能被服务端降采样 */
  image_url?: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  id: string;
  name: string;
  args: string; // JSON 字符串
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCallResult[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  /** DeepSeek 思考模式的思维链（reasoning_content，未开启/未返回时缺省） */
  reasoning?: string;
}

export interface ChatOptions {
  /** 思考判定信号（loop 层采集）。缺省 = 按日常档恒关（internal 调用：验收/意图等） */
  thinkingHint?: ThinkingHint;
}

export interface ILLMClient {
  readonly config: LLMConfig;
  chat(messages: ChatMessage[], tools?: ToolDef[], options?: ChatOptions): Promise<ChatResult>;
}

// 远程不可用时抛此错误，调用方做重试/故障转移
export class LLMError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LLMError';
  }
}

export type { LLMConfig };