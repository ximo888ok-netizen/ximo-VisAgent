// 每步索引摘要（原「可交互元素清单」升级版）单测：同一数据源（window-index），
// 冷建出 #ref 行；UIA 降级/无候选整段省略（保留旧行为红线）；超时不拖主循环。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInteractiveListSection } from '../src/interactive-list';
import { configureWindowIndexDeps, getWindowIndex, resetWindowIndex } from '../src/window-index';
import type { IndexedElement, IndexWindowResult } from '../src/uia-index';

vi.spyOn(console, 'log').mockImplementation(() => undefined);

function el(ref: number, name: string, over: Partial<IndexedElement> = {}): IndexedElement {
  return {
    ref, runtimeId: `rid,${ref}`, name, controlType: 'Button', className: '', automationId: '',
    rect: { x: ref * 10, y: 20, w: 80, h: 30 }, center: { x: ref * 10 + 40, y: 35 },
    enabled: true, offscreen: false, focused: false, focusable: true,
    patterns: { invoke: true, toggle: false, scroll: false, selectionItem: false, expandCollapse: false },
    path: `窗口/${name}`, ...over,
  };
}

let elements: IndexedElement[] = [];
let failReason: string | null = null;

beforeEach(() => {
  resetWindowIndex();
  elements = [el(1, '保存'), el(2, '无标题 - 记事本', { controlType: 'Edit', patterns: { invoke: false, toggle: false, scroll: false, selectionItem: false, expandCollapse: false } })];
  failReason = null;
  configureWindowIndexDeps({
    index: async () => failReason
      ? { ok: false, reason: failReason }
      : { ok: true, signature: 'sig-1', ms: 12, windows: [{ hwnd: 9, title: '记事本', className: 'Notepad', pid: 42, elements }] },
    resolve: async (items) => ({ ok: true, resolved: items.map((i) => ({ runtimeId: i.runtimeId, ok: true, center: { x: 1, y: 1 }, enabled: true, offscreen: false })) }),
  });
});

describe('buildInteractiveListSection（索引摘要版）', () => {
  it('首步冷建 → 带 #编号与状态的摘要 + ref 点击引导行', async () => {
    const text = await buildInteractiveListSection({ foreground: { title: '记事本', className: 'Notepad' } });
    expect(text).toContain('窗口索引[记事本]');
    expect(text).toContain('#1 保存 (Button) @(50,35) [可点击]');
    expect(text).toContain('#2 无标题 - 记事本 (Edit) @(60,35)');
    expect(text).toContain('点击用 ui_click(ref:#编号)');
  });

  it('已建索引无信号 → 直接命中缓存（不再调侧车）', async () => {
    await buildInteractiveListSection({ foreground: { title: '记事本' } });
    const spy = vi.fn();
    configureWindowIndexDeps({ index: spy });
    await buildInteractiveListSection({ foreground: { title: '记事本' }, signature: '0'.repeat(64) });
    expect(spy).not.toHaveBeenCalled();
    expect(getWindowIndex().indexed).toBe(true);
  });

  it('UIA 降级 → undefined：整段省略，绝不输出空清单', async () => {
    failReason = 'uia-degraded';
    expect(await buildInteractiveListSection({ foreground: { title: '记事本' } })).toBeUndefined();
    expect(await buildInteractiveListSection({ foreground: { title: '记事本' } })).toBeUndefined();
  });

  it('前台窗口无在屏可点元素 → undefined（宁缺毋滥，同旧红线）', async () => {
    elements = [el(1, '幽灵', { offscreen: true, center: undefined })];
    expect(await buildInteractiveListSection({ foreground: { title: '记事本' } })).toBeUndefined();
  });

  it('采集超时 → 本步整段省略；后台建完下步命中', async () => {
    vi.useFakeTimers();
    try {
      let release: (r: IndexWindowResult) => void = () => undefined;
      configureWindowIndexDeps({
        index: () => new Promise<IndexWindowResult>((res) => { release = res; }),
      });
      const pending = buildInteractiveListSection({ foreground: { title: '记事本' } });
      await vi.advanceTimersByTimeAsync(1_600);
      expect(await pending).toBeUndefined();
      release({ ok: true, signature: 'sig-1', windows: [{ hwnd: 9, title: '记事本', className: 'Notepad', pid: 42, elements }] });
      await vi.runAllTimersAsync(); // 冲刷后台构建完成后的微任务链（索引照常入表）
    } finally {
      vi.useRealTimers();
    }
    const text = await buildInteractiveListSection({ foreground: { title: '记事本' } });
    expect(text).toContain('#1 保存 (Button)');
  });
});
