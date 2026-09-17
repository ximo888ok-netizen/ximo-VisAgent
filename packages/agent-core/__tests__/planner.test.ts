/**
 * planner.test.ts — 条目4：规划器启发式开关与输出容错
 *
 * 钉住两件事：
 * 1) shouldPlan 只在"目标确实多步"时才放行规划调用（简单任务/纯对话不白烧一次 LLM 调用）；
 * 2) plan() 的输出容错：非法输出不得抛错，且最多 5 步。
 */
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';
import type { ILLMClient, ChatMessage, ToolDef, ChatResult } from '@ximo-visagent/llm-providers';
import { shouldPlan, plan, planAlternative } from '../src/agent/planner';

class OneShotLLM implements ILLMClient {
  readonly config = defaultAgentConfig().textLLM;
  constructor(private readonly content: string) {}
  async chat(_messages: ChatMessage[], _tools?: ToolDef[]): Promise<ChatResult> {
    return { content: this.content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake' };
  }
}

describe('shouldPlan（启发式开关）', () => {
  it('多步目标 → 规划', () => {
    expect(shouldPlan('打开计算器算 123*456 然后把结果写到记事本并保存')).toBe(true);
    expect(shouldPlan('打开 Excel 汇总销售数据，导出到桌面')).toBe(true);
  });

  it('单动作 / 纯对话 → 不规划（省一次 LLM 调用）', () => {
    expect(shouldPlan('你好')).toBe(false);
    expect(shouldPlan('打开记事本')).toBe(false);
    expect(shouldPlan('现在几点')).toBe(false);
  });
});

describe('plan（输出容错）', () => {
  it('合法 JSON 数组 → 逐步拆解', async () => {
    const res = await plan(new OneShotLLM('["打开记事本","输入文本","按Ctrl+S保存"]'), '写两行字并保存');
    expect(res.tasks).toEqual(['打开记事本', '输入文本', '按Ctrl+S保存']);
  });

  it('夹带解释文字也能提取数组', async () => {
    const res = await plan(new OneShotLLM('好的，步骤如下：["打开记事本","输入"]'), '写点东西');
    expect(res.tasks).toEqual(['打开记事本', '输入']);
  });

  it('超过 5 步 → 截断为 5', async () => {
    const res = await plan(new OneShotLLM('["a","b","c","d","e","f","g"]'), '长目标');
    expect(res.tasks.length).toBe(5);
  });

  it('无数组字面量 → 整段当单任务（不抛错）', async () => {
    const raw = '{"steps": 3}';
    expect((await plan(new OneShotLLM(raw), '目标 X')).tasks).toEqual([raw]);
  });

  it('数组里全是非字符串项 → 回退单任务（不抛错）', async () => {
    const raw = '[{"step":1},{"step":2}]';
    expect((await plan(new OneShotLLM(raw), '目标 Y')).tasks).toEqual([raw]);
  });

  it('空输出 → 回退到原始目标', async () => {
    expect((await plan(new OneShotLLM(''), '目标 Z')).tasks).toEqual(['目标 Z']);
  });
});

describe('planAlternative（B4-b 卡点重规划）', () => {
  class CapturingLLM implements ILLMClient {
    readonly config = defaultAgentConfig().textLLM;
    lastMessages: ChatMessage[] = [];
    constructor(private readonly content: string) {}
    async chat(messages: ChatMessage[], _tools?: ToolDef[]): Promise<ChatResult> {
      this.lastMessages = messages;
      return { content: this.content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake' };
    }
  }

  it('合法数组 → 替代计划', async () => {
    const res = await planAlternative(new OneShotLLM('["按Win搜应用名","回车启动","Ctrl+Shift+Esc 结束进程"]'), '卸载小答AI', '点击图标没反应x3');
    expect(res.tasks).toEqual(['按Win搜应用名', '回车启动', 'Ctrl+Shift+Esc 结束进程']);
  });
  it('非法输出 → 单任务回退不抛错', async () => {
    expect((await planAlternative(new OneShotLLM('换键盘试试'), '目标', 'x')).tasks).toEqual(['换键盘试试']);
  });
  it('请求里带上"已失败路径"摘要 + 重规划人设', async () => {
    const llm = new CapturingLLM('["换方案A","换方案B"]');
    await planAlternative(llm, '整理周报', '点击导出按钮 3 次无变化；菜单未展开');
    const user = llm.lastMessages.find((m) => m.role === 'user')?.content ?? '';
    const sys = llm.lastMessages.find((m) => m.role === 'system')?.content ?? '';
    expect(user).toContain('点击导出按钮 3 次无变化');
    expect(sys).toContain('重规划');
  });
});
