// LLM 统一接口（OpenAI 兼容协议）
import type { LLMConfig } from '@desktop-agi/shared-types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string }; // data:image/jpeg;base64,...
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
}

export interface ILLMClient {
  readonly config: LLMConfig;
  chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<ChatResult>;
}

// 远程不可用时抛此错误，调用方做重试/故障转移
export class LLMError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LLMError';
  }
}

export type { LLMConfig };