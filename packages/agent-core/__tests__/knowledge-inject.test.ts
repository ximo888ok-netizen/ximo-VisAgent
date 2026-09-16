// 常识常驻注入 + 能力卡 top-k 注入单测（prompts/knowledge.ts / prompts/capability-inject.ts）
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, WINDOWS_KNOWLEDGE, selectKnowledge, formatCapabilityCards, type CapabilityBrief } from '../src/prompts/system';

describe('Windows 常识常驻注入与裁剪', () => {
  it('完整版包含三段：快捷键 / 应用路径 / 通用操作模式', () => {
    expect(WINDOWS_KNOWLEDGE).toContain('### 高频快捷键');
    expect(WINDOWS_KNOWLEDGE).toContain('### 系统应用与路径');
    expect(WINDOWS_KNOWLEDGE).toContain('### 通用操作模式');
  });

  it('无关任务裁剪掉应用路径段，快捷键与操作模式两段永远常驻', () => {
    const trimmed = selectKnowledge('帮我把这段文字翻译成英文');
    expect(trimmed).not.toContain('### 系统应用与路径');
    expect(trimmed).toContain('Ctrl+S 保存');
    expect(trimmed).toContain('### 通用操作模式');
    expect(trimmed.length).toBeLessThan(WINDOWS_KNOWLEDGE.length);
  });

  it('任务提到打开/卸载/应用等信号 → 注入完整版', () => {
    expect(selectKnowledge('卸载小答AI客服')).toContain('### 系统应用与路径');
    expect(selectKnowledge('打开记事本写点东西')).toContain('ms-settings');
    expect(selectKnowledge('')).toBe(WINDOWS_KNOWLEDGE);
  });

  it('常识随 system prompt 常驻下发（不再只在困境时补发）', () => {
    const prompt = buildSystemPrompt('把报告另存为 PDF');
    expect(prompt).toContain('## Windows 操作常识');
    expect(prompt).toContain('Ctrl+Shift+Esc 打开任务管理器');
    // 前台应用段随任务走：即使纯文本任务也至少有快捷键基本功
    const trimmedPrompt = buildSystemPrompt('回答：1+1 等于几');
    expect(trimmedPrompt).toContain('## Windows 操作常识');
    expect(trimmedPrompt).not.toContain('注册表编辑器');
  });
});

const card = (title: string): CapabilityBrief => ({ title, description: `如何完成「${title}」：分步骤的可执行路径`, tools: ['mouse_click'], precondition: '前置条件', acceptance: '验收标准' });

describe('能力卡 top-k 注入', () => {
  it('无卡/空数组 = 不注入（零 token 开销，行为与现状一致）', () => {
    expect(formatCapabilityCards(undefined)).toBe('');
    expect(formatCapabilityCards([])).toBe('');
    const prompt = buildSystemPrompt('目标', undefined, undefined, undefined, undefined, undefined, undefined, undefined, []);
    expect(prompt).not.toContain('相似任务能力卡');
  });

  it('top-k：k=5 封顶，卡面含工具/前提/验收', () => {
    const cards = Array.from({ length: 7 }, (_, i) => card(`能力${i}`));
    const seg = formatCapabilityCards(cards);
    expect(seg).toContain('能力0');
    expect(seg).toContain('能力4');
    expect(seg).not.toContain('能力5');
    expect(seg).toContain('工具: mouse_click');
    expect(seg).toContain('前提: 前置条件');
    const prompt = buildSystemPrompt('目标', undefined, undefined, undefined, undefined, undefined, undefined, undefined, cards);
    expect(prompt).toContain('## 相似任务能力卡（按相关度 top-5');
  });

  it('单卡渲染不超过两行（控 token）', () => {
    const seg = formatCapabilityCards([card('发送微信文件')]);
    expect(seg.split('\n').length).toBeLessThanOrEqual(4); // 标题 2 行 + 该卡 2 行
  });
});
