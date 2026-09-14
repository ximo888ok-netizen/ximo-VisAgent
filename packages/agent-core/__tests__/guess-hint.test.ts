/**
 * guess-hint.test.ts — 条目2：拿不准就查证（不硬猜）
 *
 * 三件事一起钉住：
 * 1) detectGuessSignals 能识别"在猜"的表达；
 * 2) 注入器同一关键词组合只提示一次，且 web_search 不可用时绝不引导去调它
 *    （GLM/Kimi/DeepSeek 调它必报错——提示语必须与 provider 能力一致）；
 * 3) 可选工具目录按 provider 能力过滤（web_search 仅 qwen）。
 */
import { describe, expect, it } from 'vitest';
import type { ToolSchema } from '@ximo-visagent/shared-types';
import { buildOptionalCatalog, createGuessHintInjector, detectGuessSignals } from '../src/agent/loop-helpers';
import { supportsWebSearch } from '@ximo-visagent/llm-providers';

describe('detectGuessSignals', () => {
  it('命中"在猜"表达 → 返回命中的原始词', () => {
    const r = detectGuessSignals('C 列的值大概是 110');
    expect(r.guessing).toBe(true);
    expect(r.hits).toContain('大概是');
  });

  it('多个命中词全部回显（提示语可据此说明原因）', () => {
    const r = detectGuessSignals('应该是这里，我不确定');
    expect(r.hits).toContain('应该是');
    expect(r.hits).toContain('我不确定');
  });

  it('确定表达 → 不命中', () => {
    expect(detectGuessSignals('在编辑区输入 110，然后按 Ctrl+S 保存').guessing).toBe(false);
    expect(detectGuessSignals('').guessing).toBe(false);
  });
});

describe('createGuessHintInjector', () => {
  it('命中即提示，并引导 web_search 查证（qwen 可用时）', () => {
    const hint = createGuessHintInjector(true)('大概是 110', [{ name: 'keyboard_type', args: {} }]);
    expect(hint).toContain('web_search');
    expect(hint).toContain('大概是');
  });

  it('同一关键词组合只提示一次（避免每步重复注入烧 token）', () => {
    const inject = createGuessHintInjector(true);
    expect(inject('大概是 110', [])).not.toBeNull();
    expect(inject('大概是 110', [])).toBeNull();
  });

  it('出现新的关键词组合 → 再提示一次', () => {
    const inject = createGuessHintInjector(true);
    expect(inject('大概是 110', [])).not.toBeNull();
    expect(inject('我不确定这一列', [])).not.toBeNull();
  });

  it('web_search 不可用时提示语不含它，改为放大确认（否则引导必失败的调用）', () => {
    const hint = createGuessHintInjector(false)('我不确定这个值', []);
    expect(hint).not.toContain('web_search');
    expect(hint).toContain('look_close');
  });

  it('动作参数里的不确定表达同样被识别（不只 thought）', () => {
    const hint = createGuessHintInjector(true)('', [{ name: 'keyboard_type', args: { text: '大概是 110' } }]);
    expect(hint).not.toBeNull();
  });
});

describe('buildOptionalCatalog（按 provider 能力过滤）', () => {
  const custom: ToolSchema = { name: 'custom_hello', description: '自定义工具', level: 1, source: 'meta', parameters: {} };

  it('默认目录含 web_search', () => {
    expect(buildOptionalCatalog(undefined).map((t) => t.name)).toContain('web_search');
  });

  it('禁用 web_search 后目录不含它，其余可选工具与自定义工具保留', () => {
    const names = buildOptionalCatalog([custom], ['web_search']).map((t) => t.name);
    expect(names).not.toContain('web_search');
    expect(names).toContain('look_close');
    expect(names).toContain('custom_hello');
  });

  it('supportedWebSearch 口径与目录过滤一致（仅 qwen 为 true）', () => {
    expect(supportsWebSearch('qwen')).toBe(true);
    expect(supportsWebSearch('glm')).toBe(false);
    expect(supportsWebSearch('kimi')).toBe(false);
    expect(supportsWebSearch('deepseek')).toBe(false);
  });
});
