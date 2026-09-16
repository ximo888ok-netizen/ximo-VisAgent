// 窗口索引存储生命周期单测（假侧车注入，不碰进程）：
// build/命中、signature 判等、delta、TTL、六类重建信号（含"绝不每步重建"回归线）、
// ref 解析失败不硬点、自动建索引两条路径（有/无 targetApp）、摘要 token 预算、filter 检索。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowIndexStore } from '../src/window-index';
import type { IndexedElement, IndexWindowOptions, ResolveRefItem } from '../src/uia-index';

function el(ref: number, name: string, over: Partial<IndexedElement> = {}): IndexedElement {
  return {
    ref, runtimeId: `rid,${ref}`, name, controlType: 'Button', className: '', automationId: '',
    rect: { x: ref * 10, y: 20, w: 80, h: 30 }, center: { x: ref * 10 + 40, y: 35 },
    enabled: true, offscreen: false, focused: false, focusable: true,
    patterns: { invoke: true, toggle: false, scroll: false, selectionItem: false, expandCollapse: false },
    path: `窗口/${name}`, ...over,
  };
}

function makeStore(init: IndexedElement[]): {
  store: WindowIndexStore; calls: IndexWindowOptions[]; resolveCalls: ResolveRefItem[][];
  setElements: (els: IndexedElement[], sig?: string) => void; setFail: (why: string) => void;
} {
  let elements = init;
  let signature = 'sig-1';
  let fail: string | null = null;
  const calls: IndexWindowOptions[] = [];
  const resolveCalls: ResolveRefItem[][] = [];
  const store = new WindowIndexStore();
  store.configure({
    index: async (o) => {
      calls.push(o);
      if (fail) return { ok: false, reason: fail };
      return { ok: true, signature, windows: [{ hwnd: 100, title: '记事本', className: 'Notepad', pid: 7, elements }], ms: 12 };
    },
    resolve: async (items) => {
      resolveCalls.push(items);
      return {
        ok: true,
        resolved: items.map((i) => ({ runtimeId: i.runtimeId, ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, center: { x: 99, y: 88 }, enabled: true, offscreen: false })),
      };
    },
  });
  return {
    store, calls, resolveCalls,
    setElements: (els, sig) => { elements = els; if (sig) signature = sig; },
    setFail: (why) => { fail = why; },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('WindowIndexStore.build / 命中', () => {
  it('无索引 → observeStep(cold) 建一次，摘要含 #ref 行', async () => {
    const { store, calls } = makeStore([el(1, '保存'), el(2, '另存为')]);
    const r = await store.observeStep({ foreground: { title: '记事本', className: 'Notepad' } });
    expect(r.reason).toBe('cold');
    expect(calls).toHaveLength(1);
    expect(store.indexed).toBe(true);
    expect(store.findRef(2)?.el.name).toBe('另存为');
    const text = store.formatSummary();
    expect(text).toContain('#1 保存 (Button) @(50,35) [可点击]');
    expect(text).toContain('点击用 ui_click(ref:#编号)');
  });

  it('无信号绝不每步重建（20 步内仅冷建 + 1 次 TTL 到期建）', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    await store.observeStep({ foreground: { title: '记事本' } });
    for (let i = 0; i < 19; i++) await store.observeStep({ foreground: { title: '记事本' }, signature: '0'.repeat(64) });
    // 步1冷建、步14 TTL 重建；其余 18 步零侧车调用
    expect(calls).toHaveLength(2);
  });

  it('signature 判等：重建但结构未变 → signatureChanged=false + delta +0/-0', async () => {
    const els = [el(1, '保存')];
    const { store } = makeStore(els);
    const r1 = await store.build();
    expect(r1.signatureChanged).toBe(true);
    const r2 = await store.build();
    expect(r2.signatureChanged).toBe(false);
    expect(r2.added).toBe(0);
    expect(r2.removed).toBe(0);
  });

  it('delta 计算：元素增删 → +a/-b 且摘要行给「索引已刷新」', async () => {
    const { store, setElements } = makeStore([el(1, '保存'), el(2, '旧项')]);
    await store.build();
    setElements([el(1, '保存'), el(3, '新项')]);
    const r = await store.build();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const text = store.formatSummary();
    expect(text).toContain('索引已刷新 +1/-1');
    // delta 只显示一次
    expect(store.formatSummary()).not.toContain('索引已刷新');
  });
});

describe('重建信号集合', () => {
  it('前台标题变化 → title-changed（仅无锚定目标时）', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    await store.observeStep({ foreground: { title: '记事本' } });
    const n = calls.length;
    await store.observeStep({ foreground: { title: '计算器' } });
    expect(calls.length).toBe(n + 1);
    expect(store.needsRebuild({ foreground: { title: '记事本' } })).toBeNull();
  });

  it('上一步写动作 + 画面有变 → action-effect；缺任一半边都不重建', async () => {
    const A = '0'.repeat(64);
    const B = `1${'1'.repeat(9)}${'0'.repeat(54)}`; // 汉明距离 10 > 6 → 有变
    const { store, calls } = makeStore([el(1, '保存')]);
    await store.observeStep({ foreground: { title: '记事本' }, signature: A }); // 冷建
    const n = calls.length;
    // 画面大改但上一步没写动作 → 不重建
    await store.observeStep({ foreground: { title: '记事本' }, signature: B });
    expect(calls.length).toBe(n);
    // 写动作但画面没变 → 不重建
    store.noteAction('mouse_click', {});
    await store.observeStep({ foreground: { title: '记事本' }, signature: B });
    expect(calls.length).toBe(n);
    // 写动作 + 画面变（B→A 同样距离 10）→ 重建
    store.noteAction('ui_click', { ref: 1 });
    await store.observeStep({ foreground: { title: '记事本' }, signature: A });
    expect(calls.length).toBe(n + 1);
  });

  it('同进程族新窗口 → new-window（需注入 listWindows）', async () => {
    const { store } = makeStore([el(1, '保存')]);
    let extra: { hwnd: number; title: string; pid: number }[] = [];
    store.configure({ listWindows: async () => [{ hwnd: 100, title: '记事本', pid: 7 }, ...extra] });
    await store.observeStep({ foreground: { title: '记事本' } });
    expect(store.needsRebuild({ foreground: { title: '记事本' } })).toBeNull();
    extra = [{ hwnd: 555, title: '另存为', pid: 7 }];
    const r = await store.observeStep({ foreground: { title: '记事本' } });
    expect(r.reason).toBe('new-window');
  });

  it('TTL：12 步内不重建，第 14 步重建', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    await store.observeStep({ foreground: { title: '记事本' } });
    const n = calls.length;
    for (let i = 0; i < 12; i++) await store.observeStep({ foreground: { title: '记事本' } });
    expect(calls.length).toBe(n);
    await store.observeStep({ foreground: { title: '记事本' } });
    expect(calls.length).toBe(n + 1);
  });

  it('ref 解析失败 / invalidate → 下步强制重建', async () => {
    const { store, calls, resolveCalls } = makeStore([el(1, '保存')]);
    await store.observeStep({ foreground: { title: '记事本' } });
    const n = calls.length;
    // 解析失败（假 resolve 返回 ok:false 需要单独开关）：用未命中编号触发
    const miss = await store.resolveForClick(999);
    expect(miss.ok).toBe(false);
    const r = await store.observeStep({ foreground: { title: '记事本' } });
    expect(r.reason).toBe('ref-invalid');
    expect(calls.length).toBe(n + 1);
    expect(resolveCalls).toHaveLength(0); // 未命中编号不打无意义 RPC
    store.invalidate('watchdog-resume');
    expect((await store.observeStep({ foreground: { title: '记事本' } })).reason).toBe('ref-invalid');
  });

  it('建索引失败：同目标不逐步重试空转（抑制），换前台标题再试', async () => {
    const { store, calls, setFail } = makeStore([]);
    setFail('uia-degraded');
    await store.observeStep({ foreground: { title: '游戏' } });
    const n = calls.length;
    await store.observeStep({ foreground: { title: '游戏' } });
    await store.observeStep({ foreground: { title: '游戏' } });
    expect(calls.length).toBe(n); // 失败后同目标抑制
    setFail('');
    await store.observeStep({ foreground: { title: '记事本' } });
    expect(calls.length).toBe(n + 1); // 标题变 → 重试
  });
});

describe('自动建索引两条路径（交付4）', () => {
  it('有 targetApp：beginTask(targetPids) → 按 pid 建，不被前台标题劫持', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    store.beginTask({ targetPids: [4242] });
    await store.observeStep({ foreground: { title: '记事本' } });
    expect(calls[0]).toEqual({ pid: 4242 });
    // 前台漂到别的应用：锚定任务仍刷同一进程族（title-changed 不触发）
    store.noteAction('mouse_click', {});
    await store.observeStep({ foreground: { title: '微信' } });
    expect(calls[calls.length - 1]).toEqual({ pid: 4242 });
  });

  it('无 targetApp：默认给前台窗口建（opts={} = 侧车前台语义）', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    store.beginTask();
    await store.observeStep({ foreground: { title: '记事本' } });
    expect(calls[0]).toEqual({});
  });

  it('ui_index{window} 显式切换目标后成为自动刷新对象', async () => {
    const { store, calls } = makeStore([el(1, '保存')]);
    await store.buildFor({ hwnd: 777 });
    expect(calls[0]).toEqual({ hwnd: 777 });
    await store.observeStep({ foreground: { title: '别的应用' } });
    expect(calls[calls.length - 1]).toEqual({ hwnd: 777 }); // sticky：不被前台漂移劫持
  });
});

describe('resolveForClick：失败即拒绝，坐标永远来自重解析', () => {
  it('成功 → 返回重解析后的"当前"中心（非索引旧坐标）', async () => {
    const { store } = makeStore([el(1, '保存')]);
    await store.build();
    const out = await store.resolveForClick(1);
    expect(out.ok).toBe(true);
    expect(out.center).toEqual({ x: 99, y: 88 }); // 假侧车给的新坐标，索引里的 (50,35) 不被使用
  });

  it('侧车解析 ok:false → 失败 + 置重建信号，调用方无坐标可点', async () => {
    const store = new WindowIndexStore();
    store.configure({
      index: async () => ({ ok: true, signature: 's', windows: [{ hwnd: 1, title: 'T', className: '', pid: 5, elements: [el(1, '保存')] }] }),
      resolve: async (items) => ({ ok: true, resolved: items.map((i) => ({ runtimeId: i.runtimeId, ok: false })) }),
    });
    await store.build();
    const out = await store.resolveForClick(1);
    expect(out.ok).toBe(false);
    expect(out.center).toBeUndefined();
    expect(out.why).toContain('失效');
    expect(store.needsRebuild({ foreground: { title: 'T' } })).toBe('ref-invalid');
  });

  it('离屏 → 失败且置重建；禁用 → 失败但不置重建（元素还在）', async () => {
    for (const over of [{ offscreen: true }, { enabled: false }]) {
      const store = new WindowIndexStore();
      store.configure({
        index: async () => ({ ok: true, signature: 's', windows: [{ hwnd: 1, title: 'T', className: '', pid: 5, elements: [el(1, '按钮')] }] }),
        resolve: async (items) => ({ ok: true, resolved: items.map((i) => ({ runtimeId: i.runtimeId, ok: true, center: { x: 1, y: 1 }, ...over })) }),
      });
      await store.build();
      const out = await store.resolveForClick(1);
      expect(out.ok).toBe(false);
      expect(store.needsRebuild({ foreground: { title: 'T' } })).toBe(over.offscreen ? 'ref-invalid' : null);
    }
  });
});

describe('formatIndexSummary token 预算（交付2 硬约束）', () => {
  it('默认 40 行封顶 + 每行 ≤90 字符 + 截断提示', async () => {
    const many = Array.from({ length: 90 }, (_, i) => el(i + 1, `按钮${'很长'.repeat(20)}${i}`));
    const store = new WindowIndexStore();
    store.configure({ index: async () => ({ ok: true, signature: 's', windows: [{ hwnd: 1, title: '窗口', className: '', pid: 2, elements: many }] }) });
    await store.build();
    const text = store.formatSummary()!;
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(40);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(90);
    expect(text).toContain('共 90 可见，列前 40 个');
    expect(text).toContain('ui_index{filter:"关键词"} 检索');
    // 整段 ≈ 名称截断后每行 ~40 字符
    expect(text.length).toBeLessThanOrEqual(40 * 90);
  });

  it('全离屏/无可视元素 → undefined（保留整段省略行为）', async () => {
    const store = new WindowIndexStore();
    store.configure({ index: async () => ({ ok: true, signature: 's', windows: [{ hwnd: 1, title: 'W', className: '', pid: 2, elements: [el(1, 'x', { offscreen: true })] }] }) });
    await store.build();
    expect(store.formatSummary()).toBeUndefined();
  });

  it('状态后缀按需：禁用/已选中/展开收起；多窗口带 [窗口:] 标签', async () => {
    const store = new WindowIndexStore();
    store.configure({
      index: async () => ({
        ok: true, signature: 's',
        windows: [
          { hwnd: 1, title: '记事本', className: '', pid: 2, elements: [el(1, '深色', { patterns: { invoke: false, toggle: true, scroll: false, selectionItem: true, expandCollapse: false, selected: true, expanded: true } })] },
          { hwnd: 2, title: '另存为对话框', className: '', pid: 2, elements: [el(2, '保存', { enabled: false })] },
        ],
      }),
    });
    await store.build();
    const text = store.formatSummary()!;
    expect(text).toContain('[已选中][展开]');
    expect(text).toContain('[禁用]');
    expect(text).toContain('[窗口:另存为对话框]');
  });
});

describe('filter 检索（复用子串/字符集思路，不新造依赖）', () => {
  it('名称/路径/类型子串命中；零命中回退字符集宽松匹配；limit 生效', async () => {
    const { store } = makeStore([
      el(1, '另存为'), el(2, '保存', { controlType: 'MenuItem', path: '文件/保存' }),
      el(3, 'Zoom In', { path: '视图/缩放' }),
    ]);
    await store.build();
    expect(store.filterEntries('保存', 40).map((h) => h.el.ref)).toEqual([2]);
    expect(store.filterEntries('menuitem', 40).map((h) => h.el.ref)).toEqual([2]);
    expect(store.filterEntries('文件/', 40).length).toBe(1);
    // 子串零命中 → 字符集回退（"缩" 在"缩放"路径里）
    expect(store.filterEntries('缩小', 40).length).toBeGreaterThan(0);
    expect(store.filterEntries('另', 1)).toHaveLength(1);
    expect(store.filterEntries('', 40)).toHaveLength(0);
  });
});
