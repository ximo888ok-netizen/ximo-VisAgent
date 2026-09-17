// 点击守卫单测：同位置熔断、生效复位、UIA 命中提示、熔断候选建议
import { describe, expect, it } from 'vitest';
import { ClickGuard } from '../src/click-guard';

describe('ClickGuard 同位置熔断', () => {
  it('同目标前 3 次放行，第 4 次熔断（±60px 近邻归并）', () => {
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

describe('ClickGuard ±60px 近邻归并（旧 24px 栅格的抖动漏洞回归）', () => {
  it('跨不同 24px 栅格的 ±60px 重瞄计入同目标连击，第 4 次熔断', () => {
    const g = new ClickGuard();
    // (400,400)(421,412)(408,430)(430,448) 落在不同 24px 栅格、两两相距 <60px：
    // 旧实现按栅格分桶 → 每桶各计数、永不熔断；近邻归并后第 4 次熔断
    expect(g.check(400, 400)).toBeNull();
    expect(g.check(421, 412)).toBeNull();
    expect(g.check(408, 430)).toBeNull();
    expect(g.check(430, 448)).toContain('已熔断');
  });

  it('漂移超过近邻半径视为新目标，不与旧点合并计数', () => {
    const g = new ClickGuard();
    for (let i = 0; i < 3; i++) expect(g.check(400, 400)).toBeNull();
    // 远点（>60px）另起炉灶，不触发旧目标的熔断
    expect(g.check(700, 700)).toBeNull();
  });
});

describe('ClickGuard 坐标拉黑（observe-policy switch 档 → 执行器拒点）', () => {
  it('invalidate 后落在失效半径内的点击直接拒绝', () => {
    const g = new ClickGuard();
    g.invalidate(500, 500);
    expect(g.check(505, 502)).toContain('无效点');
    // 远离失效点的正常点击不受影响
    expect(g.check(900, 900)).toBeNull();
  });

  it('forget 清空失效坐标（不跨任务残留前科）', () => {
    const g = new ClickGuard();
    g.invalidate(300, 300);
    expect(g.check(301, 301)).toContain('无效点');
    g.forget();
    expect(g.check(301, 301)).toBeNull();
  });

  it('noteEffective 不清失效拉黑：区域确认无变化的坐标需显式换路径才解', () => {
    const g = new ClickGuard();
    g.invalidate(200, 200);
    g.noteEffective();
    expect(g.check(201, 201)).toContain('无效点');
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

describe('ClickGuard 重复查询检测（场景复刻自同 query 27 次返回同一过期元素的事故）', () => {
  it('首次查询不提示，重复且结果相同 → 轻提示，第 3 次起升级为禁止再查', () => {
    const g = new ClickGuard();
    const sig = '2072887594@798,243';
    expect(g.locateRepeatNote('小答AI客服', sig)).toBeNull();
    expect(g.locateRepeatNote('小答AI客服', sig)).toContain('已第 2 次');
    const strong = g.locateRepeatNote('小答AI客服', sig);
    expect(strong).toContain('禁止再 ui_locate');
    expect(g.locateRepeatNote('小答AI客服', sig)).toContain('4 次');
  });

  it('结果签名变化（界面真的变了）→ 计数重置，合法重查不受影响', () => {
    const g = new ClickGuard();
    expect(g.locateRepeatNote('卸载', '1@100,100')).toBeNull();
    expect(g.locateRepeatNote('卸载', '1@100,100')).toContain('已第 2 次');
    expect(g.locateRepeatNote('卸载', '2@300,300')).toBeNull();
  });

  it('不同 query 互不影响', () => {
    const g = new ClickGuard();
    expect(g.locateRepeatNote('保存', '1@1,1')).toBeNull();
    expect(g.locateRepeatNote('取消', '1@1,1')).toBeNull();
  });
});

describe('ClickGuard.forget（任务边界清理）', () => {
  it('forget 后候选提示与重复查询统计全部清零（上一任务残留不参与下一任务）', () => {
    const g = new ClickGuard();
    g.remember([{ id: 12, name: '保存', x: 900, y: 40, w: 60, h: 24 }]);
    expect(g.locateRepeatNote('保存', '1@1,1')).toBeNull();
    expect(g.locateRepeatNote('保存', '1@1,1')).toContain('已第 2 次');
    expect(g.hintAt(930, 52)).toContain('ui_click(12)');
    g.forget();
    expect(g.hintAt(930, 52)).toBeNull();
    // 重复计数回到首次语义：不再警告
    expect(g.locateRepeatNote('保存', '1@1,1')).toBeNull();
  });
});
