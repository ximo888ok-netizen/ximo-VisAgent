// 长任务失忆修复单测：8 步窗口 / token 驱动压缩 / 失败原文保留 / 已放弃路径清单
import { describe, expect, it } from 'vitest';
import { ContextManager, isFailureStep, type StepRecord } from '../src/agent/memory';
import type { ChatMessage } from '@ximo-visagent/llm-providers';

const text = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : '');

const ok = (actionName: string, args: Record<string, unknown>, result = '(成功)'): StepRecord =>
  ({ thought: `做 ${actionName}`, actionName, actionArgs: args, resultSummary: result });
const fail = (actionName: string, args: Record<string, unknown>, error: string): StepRecord =>
  ({ thought: `尝试 ${actionName}`, actionName, actionArgs: args, resultSummary: `失败: ${error}` });

describe('压缩新判据（token 驱动 + 步数兜底）', () => {
  it('宿主回传上下文占用：达阈值才需要压缩', () => {
    const mem = new ContextManager(async () => '摘要');
    for (let i = 0; i < 20; i++) mem.addStep(ok('mouse_click', { x: i, y: i }));
    expect(mem.needsCompression(9_999)).toBe(false);
    expect(mem.needsCompression(10_000)).toBe(true);
  });

  it('步数兜底：宿主未回传占用（老行为）时 40 步仍强制压缩', () => {
    const mem = new ContextManager(async () => '摘要');
    for (let i = 0; i < 39; i++) mem.addStep(ok('mouse_click', { x: i, y: i }));
    expect(mem.needsCompression(5_000)).toBe(false);
    mem.addStep(ok('mouse_click', { x: 99, y: 99 }));
    expect(mem.needsCompression(5_000)).toBe(true); // 40 步兜底压过 token 判定
    expect(mem.needsCompression()).toBe(true);
  });

  it('短窗口不压缩：<=8 步 compressNow 是 no-op', async () => {
    let called = false;
    const mem = new ContextManager(async () => { called = true; return '摘要'; });
    for (let i = 0; i < 8; i++) mem.addStep(ok('mouse_click', { x: i, y: i }));
    await mem.compressNow();
    expect(called).toBe(false);
    expect(mem.rawSteps).toHaveLength(8);
  });
});

describe('<8 步短任务零回归（对照）', () => {
  it('短任务：无压缩、无摘要块、无放弃清单，历史 = 原样动作行', () => {
    const mem = new ContextManager(async () => '不该被调用的摘要');
    mem.setTasks(['目标']);
    mem.addStep(ok('open_app', { nameOrPath: 'notepad' }, '已启动 notepad'));
    mem.addStep(ok('keyboard_type', { text: 'hello' }));
    const msgs = mem.buildHistoryMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => !text(m).includes('[此前摘要]'))).toBe(true);
    expect(msgs.every((m) => !text(m).includes('已放弃路径'))).toBe(true);
    expect(mem.needsCompression()).toBe(false);
    expect(mem.needsCompression(1_000)).toBe(false);
  });
});

describe('失败原因保留原文（重复撞墙修复）', () => {
  const LONG_ERROR = 'UIA 未在窗口「小答AI客服」中找到控件「卸载」，已滚动 3 次仍不可见，疑似入口在「设置-应用-安装的应用」而非应用自身页面';

  it('isFailureStep 判定各失败形态', () => {
    expect(isFailureStep(fail('ui_click', { elementId: 3 }, 'element not found'))).toBe(true);
    expect(isFailureStep({ thought: '工具失败: boom', actionName: null, actionArgs: null, resultSummary: '重试或换方案' })).toBe(true);
    expect(isFailureStep({ thought: '操作被审批拒绝: 不要删', actionName: null, actionArgs: null, resultSummary: '拒绝' })).toBe(true);
    expect(isFailureStep(ok('mouse_click', { x: 1, y: 1 }))).toBe(false);
  });

  it('压缩时成功步进 LLM 摘要，失败步原文进「失败·原因原文保留」块', async () => {
    const compressedInputs: StepRecord[][] = [];
    const mem = new ContextManager(async (steps) => { compressedInputs.push(steps); return '做了些常规操作'; });
    for (let i = 0; i < 8; i++) mem.addStep(ok('mouse_click', { x: i, y: i }));
    mem.addStep(fail('ui_click', { elementId: 42 }, LONG_ERROR));
    for (let i = 0; i < 8; i++) mem.addStep(ok('keyboard_press', { combo: 'Ctrl+S' }, `保存${i}`));
    await mem.compressNow();
    // 失败步不交给 LLM 压缩
    expect(compressedInputs[0]!.some((s) => isFailureStep(s))).toBe(false);
    const msgs = mem.buildHistoryMessages();
    const summary = text(msgs.find((m) => text(m).includes('[此前摘要]')) ?? { role: 'assistant', content: '' });
    expect(summary).toContain('[失败·原因原文保留]');
    expect(summary).toContain(LONG_ERROR); // 原文，不被压成模糊要点
    expect(summary).toContain('ui_click(42)');
    expect(summary).toContain('做了些常规操作'); // 成功步照常摘要
  });

  it('滑窗内失败行不被 60 字截断（成功行仍短）', () => {
    const mem = new ContextManager(async () => '摘要');
    const longOk = `保存成功${'啊'.repeat(80)}`;
    mem.addStep(ok('keyboard_press', { combo: 'Ctrl+S' }, longOk));
    mem.addStep(fail('mouse_click', { x: 500, y: 300 }, LONG_ERROR));
    const msgs = mem.buildHistoryMessages();
    const okLine = text(msgs.find((m) => text(m).startsWith('keyboard_press'))!);
    const failLine = text(msgs.find((m) => text(m).startsWith('mouse_click(500,300)'))!);
    expect(okLine).not.toContain(longOk); // 成功行截到 60 字（86 字全文不出现）
    expect(failLine).toContain(LONG_ERROR.slice(0, 150)); // 失败行保留远超 60 字
  });
});

describe('已放弃路径清单（常驻 + 上限 + 销账）', () => {
  it('每步历史都可见，含被放弃原因原文', () => {
    const mem = new ContextManager(async () => '摘要');
    mem.addStep(fail('ui_click', { elementId: 7 }, '控件在不可见区域'));
    for (let i = 0; i < 10; i++) mem.addStep(ok('mouse_scroll', { y: 0 }));
    const first = mem.buildHistoryMessages()[0]!;
    expect(first.content).toContain('[已放弃路径·勿重走]');
    expect(first.content).toContain('控件在不可见区域');
  });

  it('同工具后来成功 = 路走通了，自动销账', () => {
    const mem = new ContextManager(async () => '摘要');
    mem.addStep(fail('ui_click', { elementId: 7 }, '没找到'));
    expect(mem.abandonedPaths).toHaveLength(1);
    mem.addStep(ok('ui_click', { elementId: 7 }, '已点击'));
    expect(mem.abandonedPaths).toHaveLength(0);
    expect(text(mem.buildHistoryMessages()[0]!)).not.toContain('已放弃路径');
  });

  it('上限裁剪：只保留最近 N 条，同签名去重更新', () => {
    const mem = new ContextManager(async () => '摘要');
    for (let i = 0; i < 10; i++) mem.addStep(fail(`tool_${i}`, { x: i }, `原因${i}`));
    expect(mem.abandonedPaths.length).toBeLessThanOrEqual(6);
    expect(mem.abandonedPaths.at(-1)).toContain('原因9');
    expect(mem.abandonedPaths.at(-1)).toContain('tool_9');
    mem.addStep(fail('tool_9', { x: 9 }, '原因9b'));
    expect(mem.abandonedPaths.filter((l) => l.includes('tool_9'))).toHaveLength(1);
    expect(mem.abandonedPaths.at(-1)).toContain('原因9b');
  });
});
