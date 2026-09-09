// buildImagePart 单测：所有供应商一律 base64 内联（Files API 已移除）
import { describe, expect, it } from 'vitest';
import { buildImagePart } from '../src/agent/loop-helpers';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { LLMConfig } from '@ximo-visagent/shared-types';

function stubClient(provider: string): ILLMClient {
  const cfg: LLMConfig = { ...defaultAgentConfig().textLLM, provider };
  return {
    config: cfg,
    async chat() { throw new Error('chat not expected in this test'); },
  };
}

const IMG = Buffer.from('fake-jpeg-bytes');

describe('buildImagePart（截图 → LLM 图片块）', () => {
  it('DeepSeek → base64 内联', async () => {
    const part = await buildImagePart(stubClient('deepseek'), IMG);
    expect(part.type).toBe('image_url');
    expect((part as { image_url?: { url: string } }).image_url?.url).toContain('data:image/jpeg;base64,');
  });

  it('Qwen → base64 内联', async () => {
    const part = await buildImagePart(stubClient('qwen'), IMG);
    expect(part.type).toBe('image_url');
    expect((part as { image_url?: { url: string } }).image_url?.url).toContain('data:image/jpeg;base64,');
  });

  it('GLM → base64 内联', async () => {
    const part = await buildImagePart(stubClient('glm'), IMG);
    expect(part.type).toBe('image_url');
    expect((part as { image_url?: { url: string } }).image_url?.url).toContain('data:image/jpeg;base64,');
  });

  it('Kimi → base64 内联', async () => {
    const part = await buildImagePart(stubClient('kimi'), IMG);
    expect(part.type).toBe('image_url');
    expect((part as { image_url?: { url: string } }).image_url?.url).toContain('data:image/jpeg;base64,');
  });
});
