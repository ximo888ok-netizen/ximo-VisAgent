// grounding 单测：千分比归一化解析 + 绝对像素容错 + SoM 编号选择 + 查找闭包
import { describe, expect, it } from 'vitest';
import { createGroundingLookup, createSomLookup, parseGroundingBox, parseSomChoice } from '../src/agent/grounding';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult } from '@ximo-visagent/llm-providers';

function stub(content: string | null): ILLMClient {
  return {
    config: defaultAgentConfig().textLLM,
    async chat(): Promise<ChatResult> {
      return { content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
    },
  };
}

describe('parseGroundingBox', () => {
  it('0-1000 千分比归一化 → space=norm', () => {
    expect(parseGroundingBox('{"found":true,"box":[[418,950,436,962]]}')).toEqual({ box: [418, 950, 436, 962], space: 'norm' });
  });

  it('分量恰为 1000（Qwen 满格）仍为 norm；任何分量 >1000 → space=abs（绝对像素容错）', () => {
    expect(parseGroundingBox('{"found":true,"box":[[1000,0,1000,500]]}')).toEqual({ box: [1000, 0, 1000, 500], space: 'norm' });
    expect(parseGroundingBox('{"found":true,"box":[[1400,30,1500,80]]}')).toEqual({ box: [1400, 30, 1500, 80], space: 'abs' });
  });

  it('Qwen 原生 bbox_2d 格式（无 found 字段）容错解析', () => {
    expect(parseGroundingBox('{"bbox_2d":[323,118,444,825],"label":"watch"}')).toEqual({ box: [323, 118, 444, 825], space: 'norm' });
  });

  it('found=false / 非 JSON / 缺字段 / 负数 → null', () => {
    expect(parseGroundingBox('{"found":false}')).toBeNull();
    expect(parseGroundingBox('我看不见目标')).toBeNull();
    expect(parseGroundingBox('{"found":true,"box":[[1,2,3]]}')).toBeNull();
    expect(parseGroundingBox('{"found":true}')).toBeNull();
    expect(parseGroundingBox('{"found":true,"box":[[-1,2,3,4]]}')).toBeNull();
    expect(parseGroundingBox(null)).toBeNull();
  });
});

describe('createGroundingLookup', () => {
  it('归一化框按截图尺寸反解（默认 1920x1080）', async () => {
    const lookup = createGroundingLookup(stub('{"found":true,"box":[[418,950,436,962]]}'));
    const matches = await lookup(Buffer.from('not-a-real-jpeg'), '话术.txt');
    expect(matches).not.toBeNull();
    const m = matches![0]!;
    expect(m.name).toBe('话术.txt');
    expect(m.x).toBe(Math.round((418 / 1000) * 1920));
    expect(m.y).toBe(Math.round((950 / 1000) * 1080));
    expect(m.w).toBeGreaterThan(0);
    expect(m.h).toBeGreaterThan(0);
  });

  it('绝对像素框原样映射', async () => {
    const lookup = createGroundingLookup(stub('{"found":true,"box":[[1400,30,1500,80]]}'));
    const matches = await lookup(Buffer.from('x'), 'ZCode');
    expect(matches![0]!.x).toBe(1400);
    expect(matches![0]!.y).toBe(30);
  });

  it('模型返回 found=false 或调用异常 → null（调用方回退下一档）', async () => {
    expect(await createGroundingLookup(stub('{"found":false}'))(Buffer.from('x'), 'a')).toBeNull();
    const broken: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> { throw new Error('api down'); },
    };
    expect(await createGroundingLookup(broken)(Buffer.from('x'), 'a')).toBeNull();
  });

  it('空 query → 直接 null，不调模型', async () => {
    let called = 0;
    const counting: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(_m: ChatMessage[], _t?: ToolDef[]) { called++; throw new Error('should not be called'); },
    };
    expect(await createGroundingLookup(counting)(Buffer.from('x'), '  ')).toBeNull();
    expect(called).toBe(0);
  });
});

describe('parseSomChoice', () => {
  it('合法编号 → 正整数', () => {
    expect(parseSomChoice('{"choice": 17}')).toBe(17);
    expect(parseSomChoice('好的，我选择 {"choice": 3} 这个')).toBe(3); // 容忍前后噪声文本
  });

  it('null / 非 JSON / 非正整数 / 字符串编号非法 → null', () => {
    expect(parseSomChoice('{"choice": null}')).toBeNull();
    expect(parseSomChoice('候选里没有')).toBeNull();
    expect(parseSomChoice('{"choice": 0}')).toBeNull();
    expect(parseSomChoice('{"choice": -3}')).toBeNull();
    expect(parseSomChoice('{"choice": "abc"}')).toBeNull();
    expect(parseSomChoice('{"choice": 2.5}')).toBeNull();
    expect(parseSomChoice(null)).toBeNull();
  });
});

describe('createSomLookup', () => {
  const cands = [
    { index: 1, label: '取消', x: 0, y: 0, w: 50, h: 20 },
    { index: 2, label: '发送', x: 100, y: 200, w: 80, h: 30 },
  ];

  it('选中编号 → 返回该候选框（坐标原样，非模型回归）', async () => {
    const hit = await createSomLookup(stub('{"choice": 2}'))(Buffer.from('x'), '发送按钮', cands);
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('发送');
    expect(hit!.x).toBe(100);
    expect(hit!.y).toBe(200);
    expect(hit!.w).toBe(80);
    expect(hit!.h).toBe(30);
  });

  it('choice=null / 编号越界 / 调用异常 → null（调用方回退自由 grounding）', async () => {
    expect(await createSomLookup(stub('{"choice": null}'))(Buffer.from('x'), '发送', cands)).toBeNull();
    expect(await createSomLookup(stub('{"choice": 99}'))(Buffer.from('x'), '发送', cands)).toBeNull();
    const broken: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> { throw new Error('api down'); },
    };
    expect(await createSomLookup(broken)(Buffer.from('x'), '发送', cands)).toBeNull();
  });

  it('空 query 或空候选 → 直接 null，不调模型', async () => {
    let called = 0;
    const counting: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(_m: ChatMessage[], _t?: ToolDef[]) { called++; throw new Error('should not be called'); },
    };
    const lookup = createSomLookup(counting);
    expect(await lookup(Buffer.from('x'), '  ', cands)).toBeNull();
    expect(await lookup(Buffer.from('x'), '发送', [])).toBeNull();
    expect(called).toBe(0);
  });
});

describe('grounding 多视图投票', () => {
  /** 按脚本逐次返回的 LLM 客户端（投票需要多次调用返回不同框） */
  function scripted(contents: string[]): ILLMClient {
    let i = 0;
    return {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> {
        const content = contents[Math.min(i, contents.length - 1)]!;
        i++;
        return { content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
      },
    };
  }

  it('散布超阈值时取中心中位数，而不是回退首结果', async () => {
    const lookup = createGroundingLookup(scripted([
      '{"found":true,"box":[[1000,500,1040,520]]}', // 首推理：40x20 小目标 → 触发投票
      '{"found":true,"box":[[1000,500,1040,520]]}', // 投票 1：中心 1020
      '{"found":true,"box":[[1500,500,1540,520]]}', // 投票 2：中心 1520
      '{"found":true,"box":[[2000,500,2040,520]]}', // 投票 3：中心 2020（散布 500px）
    ]));
    const m = (await lookup(Buffer.from('x'), '输入框'))![0]!;
    // 中位数中心 1520（首结果中心是 1020，回退首结果会点偏 500px）
    expect(m.x + m.w / 2).toBeCloseTo(1520, 0);
    expect(m.w).toBe(40);
  });

  it('大目标单次推理即返回，不触发投票', async () => {
    let calls = 0;
    const counting: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> {
        calls++;
        return { content: '{"found":true,"box":[[1000,500,1200,700]]}', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
      },
    };
    const m = (await createGroundingLookup(counting)(Buffer.from('x'), '大按钮'))![0]!;
    expect(m.w).toBe(200);
    expect(calls).toBe(1);
  });
});
