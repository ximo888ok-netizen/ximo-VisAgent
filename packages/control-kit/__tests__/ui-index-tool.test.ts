// #ref 寻址执行层单测：ui_index 工具四分支、ref 点击"先重解析后点击"（失败绝不硬点旧坐标）、
// elementId 路径不回归、观测包装统计。假侧车注入 window-index 单例，点击链全替身。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedElement, IndexWindowOptions } from '../src/uia-index';

vi.mock('../src/click-focus', () => ({
  ensureTargetForeground: vi.fn(async () => ({ selfOccluded: false, note: '' })),
  clickElementWithModifiers: vi.fn(async () => undefined),
  clickWithSelfPassthrough: vi.fn(async () => undefined),
}));
vi.mock('../src/click-verify', () => ({
  captureBaseline: vi.fn(async () => ({ tag: 'baseline' })),
  postClickVerify: vi.fn(async () => ({ changed: true, note: '；画面已变化' })),
}));
vi.mock('../src/stable-frame', () => ({
  STABLE_MAX_WAIT_MS: 2500,
  waitForStableFrame: vi.fn(async () => ({ rounds: 0 })),
}));

import { clickElementWithModifiers, ensureTargetForeground } from '../src/click-focus';
import { postClickVerify } from '../src/click-verify';
import { configureWindowIndexDeps, getWindowIndex, resetWindowIndex } from '../src/window-index';
import { locateByRef, parseRefArg, uiClickTool, uiIndexTool, wrapExecutorWithIndex } from '../src/ui-index-tool';
import type { RefToolCtx } from '../src/grounding-fallback';

function el(ref: number, name: string, over: Partial<IndexedElement> = {}): IndexedElement {
  return {
    ref, runtimeId: `rid,${ref}`, name, controlType: 'MenuItem', className: '', automationId: '',
    rect: { x: ref * 100, y: 10, w: 80, h: 30 }, center: { x: ref * 100 + 40, y: 25 },
    enabled: true, offscreen: false, focused: false, focusable: true,
    patterns: { invoke: true, toggle: false, scroll: false, selectionItem: false, expandCollapse: false },
    path: `窗口/${name}`, ...over,
  };
}

let lastIndexOpts: IndexWindowOptions | null = null;
let resolveBehavior: 'ok' | 'dead' = 'ok';

function makeCtx(): RefToolCtx {
  return {
    deps: {},
    uiTree: async () => ({ ok: true, tree: undefined, total: 0, cache: 0 }),
    mouseClick: async () => ({ ok: true, summary: 'mc' }),
    guard: { noteEffective: vi.fn(), check: vi.fn(() => null), hintAt: vi.fn(() => ''), remember: vi.fn(), forget: vi.fn(), locateRepeatNote: vi.fn(() => '') },
    clickCounts: new Map<string, number>(),
    overlay: vi.fn(),
    host: () => ({}),
  } as unknown as RefToolCtx;
}

beforeEach(() => {
  resetWindowIndex();
  vi.clearAllMocks(); // 点击链替身的调用记录不跨用例残留（"绝不硬点"断言依赖干净状态）
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  lastIndexOpts = null;
  resolveBehavior = 'ok';
  configureWindowIndexDeps({
    index: async (o) => {
      lastIndexOpts = o;
      return {
        ok: true, signature: 'sig-a', ms: 12,
        windows: [{ hwnd: 9, title: '记事本', className: 'Notepad', pid: 42, elements: [el(1, '文件'), el(2, '另存为'), el(3, '退出', { enabled: false })] }],
      };
    },
    resolve: async (items) => ({
      ok: true,
      resolved: items.map((i) => resolveBehavior === 'dead'
        ? { runtimeId: i.runtimeId, ok: false }
        : { runtimeId: i.runtimeId, ok: true, rect: { x: 500, y: 300, w: 60, h: 20 }, center: { x: 530, y: 310 }, enabled: true, offscreen: false }),
    }),
    listWindows: async () => [{ hwnd: 9, title: '记事本', pid: 42 }],
  });
});

describe('parseRefArg', () => {
  it('收 7 / "7" / "#7"；拒 0/负/非数/缺省', () => {
    expect(parseRefArg(7)).toBe(7);
    expect(parseRefArg('7')).toBe(7);
    expect(parseRefArg('#7')).toBe(7);
    expect(parseRefArg(' #7 ')).toBe(7);
    expect(parseRefArg(0)).toBeUndefined();
    expect(parseRefArg(-2)).toBeUndefined();
    expect(parseRefArg('abc')).toBeUndefined();
    expect(parseRefArg(undefined)).toBeUndefined();
  });
});

describe('ui_index 工具（L0 只读，四分支）', () => {
  it('无参：未索引 → 引导；已索引 → 窗口/元素数/签名年龄 + 统计行', async () => {
    const r0 = await uiIndexTool({});
    expect(r0.ok).toBe(true);
    expect(r0.summary).toContain('尚无窗口索引');
    await getWindowIndex().build();
    const r = await uiIndexTool({});
    expect(r.summary).toContain('「记事本」3 元素');
    expect(r.summary).toContain('索引 建1');
    expect(lastIndexOpts).toEqual({});
  });

  it('window=标题子串/pid：为窗口建索引并回带 #ref 行', async () => {
    const r = await uiIndexTool({ window: '记事本' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('已索引「记事本」');
    expect(r.summary).toContain('#2 另存为');
    const byPid = await uiIndexTool({ window: '4242' });
    expect(byPid.ok).toBe(true);
    expect(lastIndexOpts).toEqual({ pid: 4242 });
  });

  it('window 找不到 → 列可见窗口候选，不静默换目标', async () => {
    const r = await uiIndexTool({ window: '不存在的窗' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到窗口');
  });

  it('filter：在已建索引内检索，行带 #ref；无索引时先引导建', async () => {
    const empty = await uiIndexTool({ filter: '另存' });
    expect(empty.ok).toBe(false);
    await getWindowIndex().build();
    const r = await uiIndexTool({ filter: '另存' });
    expect(r.summary).toContain('#2 另存为 (MenuItem)');
    expect((r.data as { refs: number[] }).refs).toEqual([2]);
  });

  it('refresh:true → 强制重建并报 delta/耗时', async () => {
    await getWindowIndex().build();
    const r = await uiIndexTool({ refresh: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('索引已刷新');
  });
});

describe('ui_click(ref)：先重解析再点；失败绝不硬点', () => {
  it('解析成功 → 点"当前"中心（非索引里的旧坐标），沿用点击链', async () => {
    await getWindowIndex().build();
    const ctx = makeCtx();
    const r = await uiClickTool(ctx, { ref: '#2' });
    expect(r.ok).toBe(true);
    expect(ensureTargetForeground).toHaveBeenCalledWith(530, 310); // resolve 后的新中心
    expect(clickElementWithModifiers).toHaveBeenCalledWith(530, 310, 'left', 1, undefined);
    expect(r.summary).toContain('另存为');
    expect(getWindowIndex().taskStatsLine()).toContain('ref1');
  });

  it('元素已销毁（resolve ok:false）→ 明确"已失效请刷新索引"，一次点击都不发生', async () => {
    await getWindowIndex().build();
    resolveBehavior = 'dead';
    const ctx = makeCtx();
    const r = await uiClickTool(ctx, { ref: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('失效');
    expect(r.error).toContain('ui_index{refresh:true}');
    expect(clickElementWithModifiers).not.toHaveBeenCalled();
    expect(ensureTargetForeground).not.toHaveBeenCalled();
    // 失效 → 下步感知带 ref-invalid 信号重建
    expect(getWindowIndex().needsRebuild({})).toBe('ref-invalid');
  });

  it('编号不在索引（未建/已切换）→ 失败 + 置重建，不打 resolve RPC', async () => {
    const r = await uiClickTool(makeCtx(), { ref: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('#7 失效');
    expect(clickElementWithModifiers).not.toHaveBeenCalled();
  });

  it('ref 与 elementId 都缺 → 参数错误文案引导两种写法', async () => {
    const r = await uiClickTool(makeCtx(), {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ref');
    expect(r.error).toContain('elementId');
  });

  it('同目标连点 3 次无效果 → 熔断（ref 键独立于 elementId）', async () => {
    await getWindowIndex().build();
    const ctx = makeCtx();
    const verify = vi.mocked(postClickVerify);
    for (let i = 0; i < 3; i++) verify.mockResolvedValueOnce({ changed: false, note: '；画面未变化' } as never);
    for (let i = 0; i < 3; i++) expect((await uiClickTool(ctx, { ref: 2 })).ok).toBe(true);
    const r = await uiClickTool(ctx, { ref: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('熔断');
  });
});

describe('ui_locate(ref)：返回当前坐标 + 可复用 ref', () => {
  it('成功 → summary 带 #编号与当前中心，data.ref 可复用', async () => {
    await getWindowIndex().build();
    const r = await locateByRef(makeCtx(), { ref: '#1' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('当前中心(530,310)');
    expect(r.data?.ref).toBe(1);
  });

  it('失效 → 拒绝 + 刷新指引', async () => {
    await getWindowIndex().build();
    resolveBehavior = 'dead';
    const r = await locateByRef(makeCtx(), { ref: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('失效');
  });
});

describe('wrapExecutorWithIndex（观测包装，不改行为）', () => {
  it('动作转发 + 写动作喂进 action-effect 信号', async () => {
    const inner = { execute: vi.fn(async () => ({ ok: true, summary: 'x' })) };
    const w = wrapExecutorWithIndex(inner);
    const A = '0'.repeat(64);
    await w.execute('mouse_click', { x: 1, y: 2 });
    expect(inner.execute).toHaveBeenCalledWith('mouse_click', { x: 1, y: 2 });
    await getWindowIndex().observeStep({ foreground: { title: '记事本' }, signature: A }); // 冷建（消费写标记）
    await w.execute('mouse_click', { x: 3, y: 4 }); // 写动作 + 目测点击计数
    const r = await getWindowIndex().observeStep({ foreground: { title: '记事本' }, signature: '1'.repeat(64) });
    expect(r.reason).toBe('action-effect');
    expect(getWindowIndex().taskStatsLine()).toContain('目测2');
  });
});
