// 点击守卫单测：同位置熔断、生效复位、UIA 命中提示、熔断候选建议
import { describe, expect, it } from 'vitest';
import { ClickGuard } from '../src/click-guard';

describe('ClickGuard 同位置熔断', () => {
  it('同栅格前 3 次放行，第 4 次熔断（24px 栅格归并抖动）', () => {
    const g = new ClickGuard();
    expect(g.check(470, 630)).toBeNull();
    expect(g.check(470, 631)).toBeNull();
    expect(g.check(470, 632)).toBeNull();
    const blocked = g.check(470, 633);
    expect(blocked).toContain('已熔断');
    // 熔断后计数复位：下一次重新放行（软熔断，不永久锁死坐标）
    expect(g.check(470, 634)).toBeNull();
  });

  it('不同栅格互不影响', () => {
    const g = new ClickGuard();
    for (let i = 0; i < 3; i++) expect(g.check(100, 100)).toBeNull();
    // 另一栅格首次点击不受影响；原栅格第 4 次才熔断
    expect(g.check(300, 300)).toBeNull();
    expect(g.check(100, 100)).toContain('已熔断');
  });

  it('点击被验证生效 → 计数清零（正常重复交互不被误熔断）', () => {
    const g = new ClickGuard();
    g.check(470, 630);
    g.check(470, 630);
    g.check(470, 630);
    g.noteEffective();
    expect(g.check(470, 630)).toBeNull();
    expect(g.check(470, 630)).toBeNull();
    expect(g.check(470, 630)).toBeNull();
  });

  it('熔断建议附最近 UIA 元素候选，而不是让模型瞎猜', () => {
    const g = new ClickGuard();
    g.remember([
      { id: 7, name: '发送', x: 460, y: 620, w: 80, h: 30 },
      { id: 8, name: '表情', x: 560, y: 620, w: 40, h: 30 },
      { id: 10, name: '加号', x: 600, y: 620, w: 30, h: 30 },
      { id: 9, name: '设置', x: 10, y: 10, w: 20, h: 20 },
    ]);
    for (let i = 0; i < 3; i++) g.check(470, 630);
    const blocked = g.check(470, 630);
    expect(blocked).toContain('#7 "发送"');
    expect(blocked).toContain('ui_click(#id)');
    // 最近的排在前，远处的设置不该出现在前三候选里
    expect(blocked).not.toContain('#9 "设置"');
  });

  it('无候选时给出 ui_locate/换坐标的替代方案', () => {
    const g = new ClickGuard();
    for (let i = 0; i < 3; i++) g.check(50, 50);
    const blocked = g.check(50, 50);
    expect(blocked).toContain('ui_locate');
  });
});

describe('ClickGuard 直点提示', () => {
  it('坐标落在近期 ui_locate 元素内 → 提示改用 ui_click', () => {
    const g = new ClickGuard();
    g.remember([{ id: 12, name: '保存', x: 900, y: 40, w: 60, h: 24 }]);
    expect(g.hintAt(930, 52)).toContain('ui_click(12)');
    expect(g.hintAt(500, 500)).toBeNull();
  });

  it('未 ui_locate 过时不提示', () => {
    expect(new ClickGuard().hintAt(100, 100)).toBeNull();
  });
});
