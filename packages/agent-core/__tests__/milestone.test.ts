// 里程碑审计单测：门控条件 / 审计解析容错 / 注入文案（含已完成清单）
import { describe, expect, it } from 'vitest';
import { applyMilestoneCheck, isMilestoneStep, milestoneMessage, runMilestoneAudit, type MilestoneAudit } from '../src/agent/milestone';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ChatResult } from '@ximo-visagent/llm-providers';
import type { StepDetail } from '../src/agent/types';

function llmWith(content: string): ILLMClient {
  return {
    config: defaultAgentConfig().textLLM,
    async chat(): Promise<ChatResult> {
      return { content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
    },
  };
}

describe('isMilestoneStep 门控', () => {
  it('长任务（maxSteps≥40）单子任务也要对账：1/3 与 2/3 处命中', () => {
    expect(isMilestoneStep(40, 120, 1)).toBe(true); // 120/3
    expect(isMilestoneStep(80, 120, 1)).toBe(true); // 120*2/3
    expect(isMilestoneStep(39, 120, 1)).toBe(false);
    expect(isMilestoneStep(41, 120, 1)).toBe(false);
  });

  it('短任务单子任务（maxSteps<40）不对账', () => {
    expect(isMilestoneStep(10, 30, 1)).toBe(false);
    expect(isMilestoneStep(20, 30, 1)).toBe(false);
  });

  it('多子任务不受步数预算限制', () => {
    expect(isMilestoneStep(10, 30, 2)).toBe(true); // 30/3
  });
});

describe('runMilestoneAudit 解析', () => {
  const steps: StepDetail[] = [{ index: 1, thought: '', actionName: 'mouse_click', resultSummary: 'ok' }];

  it('正常 JSON → 解析出 done 数组与 current', async () => {
    const audit = await runMilestoneAudit(
      llmWith('{"done":["打开记事本","输入文本"],"current":"保存文件","drift":false}'),
      '目标', steps,
    );
    expect(audit).not.toBeNull();
    expect(audit!.done).toEqual(['打开记事本', '输入文本']);
    expect(audit!.doneCount).toBe(2);
    expect(audit!.current).toBe('保存文件');
    expect(audit!.drift).toBe(false);
  });

  it('非法输出 / 抛错 → null（调用方静默跳过）', async () => {
    expect(await runMilestoneAudit(llmWith('我觉得没跑偏'), '目标', steps)).toBeNull();
    const broken: ILLMClient = {
      config: defaultAgentConfig().textLLM,
      async chat(): Promise<ChatResult> { throw new Error('down'); },
    };
    expect(await runMilestoneAudit(broken, '目标', steps)).toBeNull();
  });
});

describe('milestoneMessage 注入文案', () => {
  const audit: MilestoneAudit = {
    drift: false,
    done: ['打开记事本', '输入文本'],
    doneCount: 2,
    current: '保存文件',
  };

  it('跑偏 → 含 ⛔ 与总目标', () => {
    const msg = milestoneMessage({ ...audit, drift: true, current: '刷网页' }, 40, 120, '整理周报');
    expect(msg).toContain('⛔');
    expect(msg).toContain('整理周报');
    expect(msg).toContain('刷网页');
  });

  it('正常 → 列出已完成的具体项（防重做）', () => {
    const msg = milestoneMessage(audit, 40, 120, '整理周报');
    expect(msg).toContain('1) 打开记事本');
    expect(msg).toContain('2) 输入文本');
    expect(msg).toContain('不重做');
  });
});

describe('applyMilestoneCheck（A3：返回审计供 loop 更新进度账本）', () => {
  const steps: StepDetail[] = [{ index: 1, thought: '', actionName: 'mouse_click', resultSummary: 'ok' }];
  it('检查点命中 → 注入消息 + 发一条事件 + 返回审计（doneCount）', async () => {
    const messages: ChatMessage[] = [];
    const emitted: unknown[] = [];
    const audit = await applyMilestoneCheck(
      { textLLM: llmWith('{"done":["打开记事本","输入文本"],"current":"保存","drift":false}'), goal: '整理', stepsDetail: steps, step: 40, maxSteps: 120, subTaskCount: 1 },
      { messages, emit: (e) => { emitted.push(e); } },
    );
    expect(audit?.doneCount).toBe(2);
    expect(messages.some((m) => typeof m.content === 'string' && m.content.includes('里程碑审计'))).toBe(true);
    expect(emitted.length).toBe(1);
  });
  it('非检查点 → 返回 null 且零副作用（不卡主流程）', async () => {
    const messages: ChatMessage[] = [];
    const audit = await applyMilestoneCheck(
      { textLLM: llmWith('{"done":[],"current":"x","drift":false}'), goal: 'g', stepsDetail: steps, step: 10, maxSteps: 120, subTaskCount: 1 },
      { messages, emit: () => {} },
    );
    expect(audit).toBeNull();
    expect(messages.length).toBe(0);
  });
});
