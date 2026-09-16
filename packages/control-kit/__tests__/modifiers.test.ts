// 修饰键键序 + 悬停 diff + 滚动结果映射的纯逻辑单测
import { describe, expect, it } from 'vitest';
import { normalizeModifiers, heldKeyEvents, runWithHeldKeys, type HeldKeyEvent } from '../src/modifiers';
import { diffNewNodes } from '../src/hover-diff';
import { scrollResultToTool } from '../src/uia-scroll';

describe('normalizeModifiers', () => {
  it('缺省/空 → 空数组', () => {
    expect(normalizeModifiers(undefined)).toEqual([]);
    expect(normalizeModifiers(null)).toEqual([]);
    expect(normalizeModifiers([])).toEqual([]);
  });
  it('大小写不敏感 + control 别名 + 去重 + 规范序 ctrl→shift→alt', () => {
    expect(normalizeModifiers(['ALT', 'Control', 'shift', 'alt'])).toEqual(['ctrl', 'shift', 'alt']);
  });
  it('非法成员报错并给出允许值', () => {
    expect(() => normalizeModifiers(['meta'])).toThrowError(/未知修饰键/);
    expect(() => normalizeModifiers('ctrl')).toThrowError(/必须是数组/);
  });
});

describe('withHeld 键序（按住→动作→逆序释放）', () => {
  it('downs 规范序在前，ups 逆序在后', () => {
    const { downs, ups } = heldKeyEvents(['ctrl', 'alt']);
    expect(downs).toEqual([{ vk: 0x11, up: false }, { vk: 0x12, up: false }]);
    expect(ups).toEqual([{ vk: 0x12, up: true }, { vk: 0x11, up: true }]);
  });

  it('无修饰键 = 直通动作且不发任何键事件', async () => {
    const events: HeldKeyEvent[][] = [];
    const r = await runWithHeldKeys([], async () => 'done', (e) => events.push(e));
    expect(r).toBe('done');
    expect(events).toHaveLength(0);
  });

  it('动作抛错也必须补 up（键卡住=桌面不可用，这是硬约束）', async () => {
    const sent: HeldKeyEvent[][] = [];
    await expect(
      runWithHeldKeys(['ctrl', 'shift'], async () => { throw new Error('点击中途失败'); }, (e) => sent.push(e)),
    ).rejects.toThrow('点击中途失败');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual([{ vk: 0x11, up: false }, { vk: 0x10, up: false }]);
    expect(sent[1]).toEqual([{ vk: 0x10, up: true }, { vk: 0x11, up: true }]);
  });
});

describe('hover diff：停留前后 UIA 快照对比', () => {
  it('任一侧缺省（UIA 不可用）→ null，调用方按“无法回报”措辞', () => {
    expect(diffNewNodes(null, [{ id: 1, name: 'a', type: 'Button' }])).toBeNull();
    expect(diffNewNodes([{ id: 1, name: 'a', type: 'Button' }], null)).toBeNull();
  });
  it('新 id 计为新增；无名节点以类型展示，报告截断在 6 个以内', () => {
    const before = [{ id: 1, name: '工具栏', type: 'ToolBar' }];
    const after = [
      before[0]!,
      { id: 2, name: '保存', type: 'Button' },
      { id: 3, name: '', type: 'ToolTip' },
    ];
    const d = diffNewNodes(before, after);
    expect(d?.newCount).toBe(2);
    expect(d?.names).toEqual(['保存', 'ToolTip']);
  });
});

describe('ui_scroll_to 结果映射', () => {
  it('成功：回报滚动后中心坐标（截图坐标系）', () => {
    const r = scrollResultToTool(9, { ok: true, x: 100, y: 200, w: 40, h: 20 });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('进入视口');
    expect(r.data?.center).toEqual({ x: 120, y: 210 });
  });
  it('元素不存在 → 明确提示重新 ui_locate', () => {
    const r = scrollResultToTool(9, { ok: false, error: 'element not found' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ui_locate');
  });
  it('容器无 ScrollItem 模式 → 明确改走 mouse_scroll', () => {
    const r = scrollResultToTool(9, { ok: false, error: 'no ScrollItem pattern' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mouse_scroll');
  });
});
