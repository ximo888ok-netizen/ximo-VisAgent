import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIClient, complexityScore, decideThinking } from '../src/openai-compat';
import { defaultAgentConfig, getPreset } from '../src/provider-presets';
import { encodeImageForLLM, imageDetailFor } from '../src/vision';

describe('imageDetailFor（供应商 detail 档位适配）', () => {
  it('deepseek → original（私有档位）；qwen/glm/custom → high（OpenAI 标准）', () => {
    expect(imageDetailFor('deepseek')).toBe('original');
    expect(imageDetailFor('qwen')).toBe('high');
    expect(imageDetailFor('glm')).toBe('high');
    expect(imageDetailFor('custom')).toBe('high');
  });
});

describe('provider-presets', () => {
  it('预置 DeepSeek / Qwen / GLM', () => {
    expect(getPreset('deepseek')?.baseUrl).toBe('https://api.deepseek.com');
    expect(getPreset('qwen')?.visionModels.length).toBeGreaterThan(0);
    expect(getPreset('glm')?.visionModels).toContain('glm-5.3-flash');
  });

  it('默认组合 = 单一多模态主大脑（text 与 vision 同源，默认 qwen3.8-flash）', () => {
    const cfg = defaultAgentConfig();
    expect(cfg.textLLM.provider).toBe('qwen');
    expect(cfg.textLLM.model).toBe('qwen3.8-flash');
    expect(cfg.visionLLM.provider).toBe(cfg.textLLM.provider);
    expect(cfg.visionLLM.model).toBe(cfg.textLLM.model);
    expect(cfg.visionLLM.enabled).toBe(true);
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
    expect(r.toolCalls[0]?.name).toBe('f');
    expect(JSON.parse(r.toolCalls[0]?.args ?? '{}')).toEqual({ a: 1 });
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

describe('Qwen 视觉高分辨率参数注入', () => {
  afterEach(() => vi.restoreAllMocks());

  async function captureBody(provider: string): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'c' } }] }) } as Response;
    });
    const c = new OpenAIClient({ provider, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', enabled: true } as never);
    await c.chat([{ role: 'user', content: 'x' }]);
    return body;
  }

  it('qwen → vl_high_resolution_images=true（避免截图被降采样）', async () => {
    const body = await captureBody('qwen');
    expect(body.vl_high_resolution_images).toBe(true);
  });

  it('非 qwen 供应商 → 不下发 vl_high_resolution_images', async () => {
    for (const provider of ['deepseek', 'glm', 'kimi', 'custom']) {
      const body = await captureBody(provider);
      expect(body.vl_high_resolution_images).toBeUndefined();
    }
  });
});

describe('思考模式参数（DeepSeek thinking）', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeClient(provider: string, thinkingEffort?: 'off' | 'low' | 'high' | 'max') {
    return new OpenAIClient({ provider, baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', enabled: true, thinkingEffort });
  }

  async function captureBody(c: OpenAIClient): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'c' } }] }) } as Response;
    });
    await c.chat([{ role: 'user', content: 'x' }]);
    return body;
  }

  it('deepseek + effort=low → thinking enabled + reasoning_effort=low', async () => {
    const body = await captureBody(makeClient('deepseek', 'low'));
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
  });

  it('effort=max 透传 max；off → thinking disabled 且不带 reasoning_effort', async () => {
    expect((await captureBody(makeClient('deepseek', 'max'))).reasoning_effort).toBe('max');
    const off = await captureBody(makeClient('deepseek', 'off'));
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.reasoning_effort).toBeUndefined();
  });

  it('未配置 thinkingEffort 或非 deepseek 供应商 → 不下发任何思考参数', async () => {
    for (const c of [makeClient('deepseek'), makeClient('qwen', 'high')]) {
      const body = await captureBody(c);
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  it('捕获思维链 reasoning_content 到 ChatResult', async () => {
    const c = makeClient('deepseek', 'high');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '答案', reasoning_content: '先想一想…' } }], usage: { total_tokens: 9 } }),
    } as Response);
    const r = await c.chat([{ role: 'user', content: 'x' }]);
    expect(r.reasoning).toBe('先想一想…');
    expect(r.content).toBe('答案');
  });
});

describe('思考四档（qwen/glm）', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeProviderClient(provider: string, thinkingMode?: string) {
    return new OpenAIClient({ provider, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', enabled: true, thinkingMode } as never);
  }

  async function captureThinking(provider: string, messages: Parameters<OpenAIClient['chat']>[0], options?: Parameters<OpenAIClient['chat']>[2], thinkingMode?: string): Promise<{ enable_thinking?: unknown; thinking?: unknown }> {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'c' } }] }) } as Response;
    });
    const c = makeProviderClient(provider, thinkingMode);
    await c.chat(messages, undefined, options);
    return { enable_thinking: body.enable_thinking, thinking: body.thinking };
  }

  it('daily：恒关（无论复杂度）', async () => {
    const deep = [
      { role: 'system' as const, content: 's' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant' as const, content: `动作 ${i}` })),
      { role: 'user' as const, content: 'go' },
    ];
    const hint = { step: 10, recentFailures: 5, noChangeCount: 3, seed: 1 };
    expect((await captureThinking('qwen', deep, { thinkingHint: hint }, 'daily')).enable_thinking).toBe(false);
  });

  it('deep：恒开', async () => {
    const short = [{ role: 'user' as const, content: '看图' }];
    expect((await captureThinking('glm', short, undefined, 'deep')).thinking).toEqual({ type: 'enabled' });
  });

  it('long：前 2 步关（hint.step ≤2），第 3 步起开', async () => {
    const msgs = [{ role: 'user' as const, content: 'go' }];
    expect((await captureThinking('qwen', msgs, { thinkingHint: { step: 1, recentFailures: 0, noChangeCount: 0, seed: 1 } }, 'long')).enable_thinking).toBe(false);
    expect((await captureThinking('qwen', msgs, { thinkingHint: { step: 2, recentFailures: 0, noChangeCount: 0, seed: 1 } }, 'long')).enable_thinking).toBe(false);
    expect((await captureThinking('qwen', msgs, { thinkingHint: { step: 3, recentFailures: 0, noChangeCount: 0, seed: 1 } }, 'long')).enable_thinking).toBe(true);
  });

  it('auto：强失败信号直通开思考（评分不看，连败 ≥3 直接开）', async () => {
    const msgs = [{ role: 'user' as const, content: 'go' }];
    const hint = { step: 2, recentFailures: 3, noChangeCount: 0, seed: 1 };
    expect((await captureThinking('qwen', msgs, { thinkingHint: hint }, 'auto')).enable_thinking).toBe(true);
  });

  it('auto：多弱信号叠加过阈值开思考（浅历史+失败+停滞）', async () => {
    // 历史 16 条（28分）+ 失败 3/6（15分）+ 停滞（10分）≈ 53 → 软带；加 6000 字 text（12.5分）≈ 65 过硬阈值
    const msgs = [
      { role: 'system' as const, content: 's'.repeat(6000) },
      ...Array.from({ length: 16 }, (_, i) => ({ role: 'assistant' as const, content: `动作 ${i}` })),
      { role: 'user' as const, content: 'go' },
    ];
    const hint = { step: 16, recentFailures: 3, noChangeCount: 2, seed: 1 };
    expect(complexityScore(msgs, hint)).toBeGreaterThanOrEqual(60);
    expect((await captureThinking('qwen', msgs, { thinkingHint: hint }, 'auto')).enable_thinking).toBe(true);
  });

  it('auto：简单场景（短上下文、无失败、无停滞）关思考', async () => {
    const msgs = [
      { role: 'system' as const, content: '系统提示' },
      { role: 'user' as const, content: '看图' },
    ];
    expect((await captureThinking('qwen', msgs, { thinkingHint: { step: 1, recentFailures: 0, noChangeCount: 0, seed: 1 } }, 'auto')).enable_thinking).toBe(false);
  });

  it('默认（无 thinkingMode）= daily 恒关', async () => {
    const deep = [
      { role: 'system' as const, content: 's' },
      ...Array.from({ length: 15 }, (_, i) => ({ role: 'assistant' as const, content: `动作 ${i}` })),
    ];
    expect((await captureThinking('glm', deep, undefined, undefined)).thinking).toEqual({ type: 'disabled' });
  });

  it('kimi / custom 不下发思考参数（四档任一都不发）', async () => {
    for (const provider of ['kimi', 'custom']) {
      for (const mode of ['auto', 'daily', 'long', 'deep']) {
        const r = await captureThinking(provider, [{ role: 'user' as const, content: 'x' }], undefined, mode);
        expect(r.enable_thinking).toBeUndefined();
        expect(r.thinking).toBeUndefined();
      }
    }
  });
});

describe('complexityScore（auto 评分器）', () => {
  it('四信号加权求和：深度35 + 规模25 + 失败30 + 停滞10', () => {
    const msgs = [
      { role: 'system' as const, content: 'x'.repeat(12000) },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant' as const, content: 'a' })),
    ];
    const full = complexityScore(msgs, { step: 20, recentFailures: 6, noChangeCount: 5, seed: 1 });
    expect(full).toBe(100);
    const empty = complexityScore([{ role: 'user' as const, content: 'hi' }]);
    expect(empty).toBe(0);
  });

  it('截图 base64 不计入规模分（只算 text part）', () => {
    const multimodal = [
      { role: 'user' as const, content: [
        { type: 'text' as const, text: '看图' },
        { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${'a'.repeat(200000)}` } },
      ] },
    ];
    expect(complexityScore(multimodal)).toBe(0);
  });

  it('软阈值带：40-59 分的判定由种子决定且稳定（同种子同结果）', () => {
    // 构造 ~45 分：20 条历史(35) + 失败 2/6(10)
    const msgs = [
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant' as const, content: 'a' })),
    ];
    const hint = { step: 20, recentFailures: 2, noChangeCount: 0, seed: 42 };
    const r1 = decideThinking(msgs, 'auto', hint);
    const r2 = decideThinking(msgs, 'auto', hint);
    expect(r1).toBe(r2); // 同一步判定稳定
    // 分数应落在软阈值带
    expect(complexityScore(msgs, hint)).toBeGreaterThanOrEqual(40);
    expect(complexityScore(msgs, hint)).toBeLessThan(60);
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