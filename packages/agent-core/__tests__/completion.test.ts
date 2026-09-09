// 目标收尾强化单测：动作重复签名 + 感知文本的步数预算提醒 + EfficiencyGuard 行为
import { describe, expect, it } from 'vitest';
import { actionSignature, buildPerceptionText } from '../src/agent/loop-helpers';
import { EfficiencyGuard } from '../src/agent/loop-efficiency';

describe('actionSignature（相似动作重复检测）', () => {
  it('mouse_click 按 24px 栅格归并坐标抖动', () => {
    const a = actionSignature('mouse_click', { x: 1503, y: 116, times: 2 });
    const b = actionSignature('mouse_click', { x: 1512, y: 124 });
    const c = actionSignature('mouse_click', { x: 1600, y: 300 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('ui_click 按元素 id、keyboard_press 按组合键，ui_locate/open_app 按参数，其他工具返回 null', () => {
    expect(actionSignature('ui_click', { elementId: 42 })).toBe('ui_click#42');
    expect(actionSignature('keyboard_press', { combo: 'Escape' })).toBe('press:escape');
    expect(actionSignature('ui_locate', { query: '小答AI' })).toBe('ui_locate:小答ai');
    expect(actionSignature('open_app', { nameOrPath: 'control.exe' })).toBe('open_app:control.exe');
    expect(actionSignature('mouse_scroll', { delta: -5 })).toBeNull();
    expect(actionSignature('keyboard_type', { text: '你好' })).toBeNull();
    expect(actionSignature('mouse_click', undefined)).toBeNull();
    expect(actionSignature('mouse_click', {})).toBeNull();
  });
});

describe('buildPerceptionText（步数预算提醒）', () => {
  const snap = {};
  const tasks = ['打开Qoder CN看一下项目在做什么'];

  it('未传 maxSteps 或步数未到阈值时不提醒', () => {
    const t = buildPerceptionText(snap, tasks, 14, true, 0, [], 60);
    expect(t).not.toContain('task_done 收尾');
    expect(buildPerceptionText(snap, tasks, 30, true, 0, [])).not.toContain('task_done');
  });

  it('step>=15 轻提醒，step>=30 强提醒，均含步数预算', () => {
    expect(buildPerceptionText(snap, tasks, 15, true, 0, [], 60)).toContain('立即 task_done 收尾');
    const late = buildPerceptionText(snap, tasks, 31, true, 0, [], 60);
    expect(late).toContain('31/60');
    expect(late).toContain('task_done');
  });

  it('步数头带预算显示', () => {
    expect(buildPerceptionText(snap, tasks, 3, true, 0, [], 60)).toContain('[步 #3/60]');
    expect(buildPerceptionText(snap, tasks, 3, true, 0, [])).toContain('[步 #3]');
  });
});

describe('EfficiencyGuard（收尾守卫）', () => {
  const click = (x: number, y: number) => ({ name: 'mouse_click', args: { x, y } });

  it('连续 3 次相同 thought 注入换策略指令（含对照目标选项）', () => {
    const g = new EfficiencyGuard(60);
    const t = '我点击全面了解项目获取项目的完整概览和进度';
    expect(g.onStep(1, t, null)).toHaveLength(0);
    expect(g.onStep(2, t, null)).toHaveLength(0);
    const nudges = g.onStep(3, t, null);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.message).toContain('task_done');
  });

  it('措辞微变的 thought 不触发（动作签名兜底）', () => {
    const g = new EfficiencyGuard(60);
    expect(g.onStep(1, '我点击全面了解项目获取项目的完整概览和进度', click(1503, 116))).toHaveLength(0);
    expect(g.onStep(2, '让我点击全面了解项目来获取项目的完整概览', click(1512, 124))).toHaveLength(0);
    const nudges = g.onStep(3, '需要点击全面了解项目查看完整概览', click(1508, 120));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.message).toContain('几乎同一目标');
  });

  it('同一签名只注入一次，换目标位置后重新计数', () => {
    const g = new EfficiencyGuard(60);
    g.onStep(1, null, click(100, 100));
    g.onStep(2, null, click(104, 102));
    expect(g.onStep(3, null, click(98, 99))).toHaveLength(1);
    expect(g.onStep(4, null, click(101, 100))).toHaveLength(0); // 已注入过，不再重复
    expect(g.onStep(5, null, click(800, 400))).toHaveLength(0); // 新位置
    g.onStep(6, null, click(802, 401));
    expect(g.onStep(7, null, click(799, 400))).toHaveLength(1); // 新签名再触发
  });

  it('半程一次性注入收尾自查指令', () => {
    const g = new EfficiencyGuard(60);
    expect(g.onStep(29, null, null)).toHaveLength(0);
    const nudges = g.onStep(30, null, null);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.message).toContain('30/60');
    expect(g.onStep(31, null, null)).toHaveLength(0);
  });
});
