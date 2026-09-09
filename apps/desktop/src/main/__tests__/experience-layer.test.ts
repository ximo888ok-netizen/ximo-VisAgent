/**
 * experience-layer.test.ts — 经验层的纯逻辑契约
 *
 * 覆盖：SOP 骨架渲染（占位符/填参/损坏容错）、
 * 自定义工具脚本生成（脚本体 + 沙箱静态检查 + 安全等级继承原子）。
 */
import { describe, it, expect } from 'vitest';
import { renderSkeleton } from '../orchestrator-sop';
import {
  buildScriptBody,
  atomsInScript,
  deriveLevel,
  staticSandboxCheck,
} from '../tool-script';
import type { SopRow } from '../audit-store';

describe('SOP 骨架渲染', () => {
  const sop = {
    id: 's1', name: 'n', description: '', goalTemplate: 'g',
    stepsJson: JSON.stringify([
      { actionName: 'keyboard_type', argsTemplate: { text: '{{param_1}}' }, resultSummary: '输入 {{param_1}}' },
      { actionName: 'mouse_click', argsTemplate: { x: 100, y: 200 }, resultSummary: '点击' },
    ]),
    variablesJson: '[]', runCount: 0, lastRunAt: null, createdAt: 1,
    origin: 'distilled', status: 'candidate', applicabilityJson: '{}', successCount: 0, failCount: 0, promotedAt: null,
  } satisfies SopRow;

  it('未填参时占位符渲染为 <参数>，不泄漏字面花括号', () => {
    const { lines, actions } = renderSkeleton(sop);
    expect(actions).toEqual(['keyboard_type', 'mouse_click']);
    expect(lines[0]).toContain('<参数>');
    expect(lines[0]).not.toContain('{{');
  });

  it('填参后按 {{key}} 替换（M8）', () => {
    const { lines } = renderSkeleton(sop, { param_1: '季度报告' });
    expect(lines[0]).toContain('季度报告');
  });

  it('stepsJson 损坏时安全返回空', () => {
    const broken = { ...sop, stepsJson: '不是 JSON' };
    expect(renderSkeleton(broken)).toEqual({ lines: [], actions: [] });
  });
});

describe('自定义工具脚本生成（F17.1）', () => {
  it('生成的脚本只调用已注册原子，且不触发沙箱', () => {
    const steps = [{ tool: 'activate_window', args: { appName: 'Excel' } }, { tool: 'wait', args: { ms: 300 } }];
    const script = buildScriptBody('custom_demo', steps);
    expect(atomsInScript(script)).toEqual(['activate_window', 'wait']);
    expect(staticSandboxCheck(script).ok).toBe(true);
    expect(script).not.toContain('require(');
  });

  it('沙箱静态检查：破坏性/外发 API 被拦截', () => {
    expect(staticSandboxCheck('fs.rmSync("x")').ok).toBe(false);
    expect(staticSandboxCheck('await fetch("http://evil")').ok).toBe(false);
    expect(staticSandboxCheck('invoke("mouse_click", {}); log("ok")').ok).toBe(true);
  });

  it('安全等级继承组成步骤的最高档', () => {
    expect(deriveLevel(['get_clipboard', 'wait'])).toBeLessThanOrEqual(1);
    expect(deriveLevel(['get_clipboard', 'file_write'])).toBe(2);
    expect(deriveLevel(['nope_unknown_tool'])).toBe(0);
  });
});
