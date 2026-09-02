import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIClient } from '../src/openai-compat';
import { defaultAgentConfig, PROVIDER_PRESETS, getPreset } from '../src/provider-presets';
import { encodeImageForLLM } from '../src/vision';

describe('provider-presets', () => {
  it('预置 DeepSeek / Qwen', () => {
    expect(getPreset('deepseek')?.baseUrl).toBe('https://api.deepseek.com');
    expect(getPreset('qwen')?.visionModels.length).toBeGreaterThan(0);
  });

  it('默认组合 = DeepSeek 文本 + Qwen 视觉', () => {
    const cfg = defaultAgentConfig();
    expect(cfg.textLLM.provider).toBe('deepseek');
    expect(cfg.visionLLM.provider).toBe('qwen');
    expect(cfg.visionLLM.enabled).toBe(false);
  });
});

describe('OpenAIClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('构造时自动追加 /chat/completions 路径', () => {
    const c = new OpenAIClient({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      enabled: true,
    });
    expect(c.config.baseUrl).toBe('https://api.deepseek.com/chat/completions');
  });

  it('成功解析 tool_calls 与 usage', async () => {
    const c = new OpenAIClient({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      enabled: true,
    });
    const fake = { ok: true, json: async () => ({ choices: [{ message: { content: 'c', tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{"a":1}' } }] } }], usage: { total_tokens: 5 } }) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake as Response);
    const r = await c.chat([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('c');
    expect(r.toolCalls[0].name).toBe('f');
    expect(JSON.parse(r.toolCalls[0].args)).toEqual({ a: 1 });
    expect(r.usage.totalTokens).toBe(5);
  });

  it('HTTP 失败抛 LLMError', async () => {
    const c = new OpenAIClient({
      provider: 'deepseek',
      baseUrl: 'https://x.com',
      apiKey: 'k',
      model: 'm',
      enabled: true,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as Response);
    await expect(c.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ name: 'LLMError' });
  });
});

describe('vision 编码', () => {
  it('小图不缩小直接 base64', () => {
    // 构造 8x8 RGBA PNG（最小合法 PNG）
    const png = makeTinyPng(8, 8);
    const part = encodeImageForLLM(png);
    expect(part.type).toBe('image_url');
    const url = (part as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('大图降采样后仍返回 data url', () => {
    const png = makeTinyPng(64, 64);
    const part = encodeImageForLLM(png, { maxDim: 32 });
    expect(part.type).toBe('image_url');
  });
});

function makeTinyPng(w: number, h: number): Buffer {
  // 极简无过滤 RGBA PNG（仅测试头解析用；实际编码 PNG 需 zlib）
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13);
  const chunkType = Buffer.from('IHDR');
  return Buffer.concat([sig, ihdrLen, chunkType, ihdr]);
}