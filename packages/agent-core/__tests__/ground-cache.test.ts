// 坐标表缓存单测：命中条件（整帧前置闸 + 局部外观复核）、失效（窗口/帧距/局部距/scroll/TTL）、
// 自愈（缓存点击无效→条目剔除，连败 2 次→任务级停用）、LRU、保守 miss、执行器包装（UIA 实时优先）。
// 区域指纹与截图能力全部用替身注入（agent-core 不依赖宿主）。
import { describe, expect, it } from 'vitest';
import {
  GroundCache,
  hashDistance,
  normalizeCropBox,
  normalizeLocateTarget,
  windowSignatureOf,
  wrapExecutorWithGroundCache,
  type GroundBox,
  type RegionFingerprint,
} from '../src/agent/ground-cache';
import type { ToolResult } from '../src/tools/registry';

const WIN = 'Untitled - Notepad|Notepad';
const FRAME = '0'.repeat(64);
/** 造 n 位汉明距离的指纹 */
const flipped = (n: number): string => FRAME.split('').map((c, i) => (i < n ? '1' : c)).join('');
const frame = (step: number, win = WIN, hash = FRAME) => ({ windowSignature: win, frameHash: hash, step });
const BOX = { x: 100, y: 50, w: 40, h: 20 };
/** 默认区域指纹替身：永远稳定（返回与记表同串的常量） */
const fpStable = async (): Promise<string> => FRAME;
/** 可调当前区域指纹的替身：fpNow 变了即模拟目标区域局部变化 */
function fpSwitchable(initial = FRAME): { fp: RegionFingerprint; set: (h: string | null) => void; seen: GroundBox[] } {
  let now: string | null = initial;
  const seen: GroundBox[] = [];
  return {
    seen,
    set: (h) => { now = h; },
    fp: async (box) => { seen.push(box); return now; },
  };
}
const cacheWith = (fp: RegionFingerprint, opts = {}) => new GroundCache({ regionFingerprint: fp, ...opts });

const okUia = (name = '保存'): ToolResult => ({
  ok: true,
  summary: `找到1个: #7 "${name}"(Button) [Notepad]`,
  data: { matches: [{ id: 7, name, x: 10, y: 20, w: 30, h: 40 }] },
});
const okGrounding: ToolResult = {
  ok: true,
  summary: 'grounding 视觉定位: "橡皮擦" 中心(500,80) 尺寸 24x24。目标无 UIA 元素 id，请直接 mouse_click 中心坐标',
  data: { matches: [{ name: '橡皮擦', x: 488, y: 68, w: 24, h: 24 }] },
};
const locFail: ToolResult = { ok: false, summary: '', error: '未找到' };
/** control-kit click-verify 结果形状（data.clickVerify.changed） */
const clickResult = (changed: boolean | null): ToolResult => ({
  ok: true,
  summary: '点击',
  ...(changed === null ? {} : { data: { clickVerify: { changed } } }),
});

/** 脚本化底层执行器：ui_locate 返回可换的 loc 结果，点击类动作按队列吐校验结果 */
function makeBase(loc: ToolResult, clicks: (ToolResult | null)[] = []) {
  const state = { loc, click: 0 };
  let locCalls = 0;
  return {
    locCalls: () => locCalls,
    setLoc: (r: ToolResult) => { state.loc = r; },
    executor: {
      async execute(name: string): Promise<ToolResult> {
        if (name === 'ui_locate') { locCalls++; return state.loc; }
        return clicks[state.click++] ?? clickResult(null);
      },
    },
  };
}

describe('GroundCache 局部外观复核（复用前必须重看那块地方）', () => {
  it('整帧指纹通过但局部指纹距离超阈(>4) → miss 且旧条目剔除；≤4 仍命中', async () => {
    const { fp, set } = fpSwitchable();
    const c = cacheWith(fp);
    c.beginStep(frame(1));
    expect(await c.record('a', BOX, 'uia')).toBe(true);
    c.beginStep(frame(2)); // 整帧指纹不变
    set(flipped(4));
    expect(await c.lookup('a')).not.toBeNull(); // 阈内（≤4）放行
    set(flipped(5)); // 局部变了（弹下拉/列表刷新），整帧却可能没动
    expect(await c.lookup('a')).toBeNull();
    expect(c.stats().entries).toBe(0);
  });

  it('无 regionFingerprint 回调 → 不记表、查表一律 miss（保守优先）', async () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    expect(await c.record('a', BOX, 'uia')).toBe(false);
    expect(await c.lookup('a')).toBeNull();
  });

  it('区域指纹返回 null（截图失败/越出屏幕右下边界） → 不记表；负坐标 box 同样拒绝', async () => {
    const { fp, set } = fpSwitchable();
    const c = cacheWith(fp);
    c.beginStep(frame(1));
    set(null);
    expect(await c.record('a', BOX, 'uia')).toBe(false);
    expect(await c.record('b', { x: -8, y: 10, w: 20, h: 20 }, 'uia')).toBe(false); // 负坐标越界
    expect(await c.lookup('a')).toBeNull();
  });

  it('区域归一化：过小 box 外扩到最小采样边长（≥16px）后再取指纹', async () => {
    const { fp, seen } = fpSwitchable();
    const c = cacheWith(fp);
    c.beginStep(frame(1));
    expect(await c.record('tiny', { x: 100, y: 50, w: 6, h: 6 }, 'uia')).toBe(true);
    expect(seen[0]!.w).toBeGreaterThanOrEqual(16);
    expect(seen[0]!.h).toBeGreaterThanOrEqual(16);
    const n = normalizeCropBox({ x: 100, y: 50, w: 40, h: 20 }); // 足够大则中心不变、原样保留
    expect(n).toEqual({ x: 100, y: 50, w: 40, h: 20 });
  });
});

describe('GroundCache 命中与失效', () => {
  it('窗口签名一致 + 整帧/局部指纹都过 → 命中并返回坐标/中心/来源', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    expect(await c.record('保存按钮', BOX, 'uia')).toBe(true);
    c.beginStep(frame(2));
    const hit = await c.lookup('保存按钮');
    expect(hit).not.toBeNull();
    expect(hit!.box).toEqual(BOX);
    expect(hit!.center).toEqual({ x: 120, y: 60 });
    expect(hit!.stepsAgo).toBe(1);
  });

  it('归一化键等价：大小写与多余空格折叠为同一键', async () => {
    expect(normalizeLocateTarget('  Save   Button ')).toBe('save button');
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('Save   Button', BOX, 'uia');
    expect(await c.lookup('save button')).not.toBeNull();
    expect(await c.lookup('SAVE BUTTON')).not.toBeNull();
  });

  it('hashDistance：全等=0，二进制串按汉明距离，其余不可比=null', () => {
    expect(hashDistance(FRAME, FRAME)).toBe(0);
    expect(hashDistance(FRAME, flipped(3))).toBe(3);
    expect(hashDistance(FRAME, 'abc')).toBeNull();
    expect(hashDistance('0'.repeat(64), '0'.repeat(32))).toBeNull();
  });

  it('前台窗口变化 → beginStep 整表失效', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('保存按钮', BOX, 'uia');
    c.beginStep(frame(2, '其他窗口|Other'));
    expect(await c.lookup('保存按钮')).toBeNull();
    expect(c.stats().entries).toBe(0);
  });

  it('整帧指纹超阈(>6，布局动了) → miss 且旧条目剔除；阈内仍命中', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    c.beginStep(frame(2, WIN, flipped(3)));
    expect(await c.lookup('a')).not.toBeNull();
    c.beginStep(frame(3, WIN, flipped(10)));
    expect(await c.lookup('a')).toBeNull();
    expect(c.stats().entries).toBe(0);
  });

  it('执行过 scroll 动作 → 整表失效；其他动作不清表', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    c.onAction('mouse_click');
    expect(await c.lookup('a')).not.toBeNull();
    c.onAction('mouse_scroll');
    expect(await c.lookup('a')).toBeNull();
  });

  it('步数 TTL 收紧为 8 步：≤8 步命中，超 8 步 miss', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(5));
    await c.record('a', BOX, 'uia');
    c.beginStep(frame(13));
    expect(await c.lookup('a')).not.toBeNull();
    c.beginStep(frame(14));
    expect(await c.lookup('a')).toBeNull();
  });

  it('invalidateAll 清空条目但保留计数（跨任务量总命中率）', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    await c.lookup('a');
    c.invalidateAll('task-end');
    expect(c.stats().entries).toBe(0);
    expect(c.stats().hits).toBe(1);
    expect(await c.lookup('a')).toBeNull();
    expect(c.stats().misses).toBe(1);
  });
});

describe('GroundCache 自愈失效（点击校验判无效）', () => {
  it('缓存坐标点击 changed=false → 该条目立即剔除并计入失效观测', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    c.beginStep(frame(2));
    expect(await c.lookup('a')).not.toBeNull(); // 命中 → 挂账「待点击校验（缓存坐标）」
    c.settlePendingClick(false);
    expect(c.stats().entries).toBe(0);
    expect(c.stats().clickFailures).toBe(1);
    expect(c.stats().disabled).toBe(false); // 第 1 次只剔条目，尚未停用
  });

  it('同一任务连续 2 次缓存点击无效 → 停用缓存；beginTask 复位', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    await c.record('b', { x: 1, y: 1, w: 20, h: 20 }, 'uia');
    c.beginStep(frame(2));
    expect(await c.lookup('a')).not.toBeNull();
    c.settlePendingClick(false); // 连败 1
    expect(await c.lookup('b')).not.toBeNull();
    c.settlePendingClick(false); // 连败 2 → 停用
    expect(c.stats().disabled).toBe(true);
    expect(await c.lookup('a')).toBeNull(); // 停用后本任务一律 miss
    expect(await c.record('c', BOX, 'uia')).toBe(false); // 且不再记表
    expect(c.statsLine()).toContain('已停用');
    expect(c.statsLine()).toContain('自愈失效2');
    c.beginTask();
    expect(c.stats().disabled).toBe(false);
  });

  it('点击校验成功 → 清零连败并标记该目标已验证；新定位（非缓存）点击失败只剔条目不计数', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia'); // record 挂账 fromCache=false
    c.settlePendingClick(true);
    c.beginStep(frame(2));
    expect(await c.lookup('a')).not.toBeNull();
    c.settlePendingClick(false); // 连败 1（缓存坐标）
    c.beginStep(frame(3));
    await c.record('b', BOX, 'uia'); // 重新实时定位
    c.settlePendingClick(false); // 非缓存坐标 → 不计连败
    expect(c.stats().clickFailures).toBe(1);
    expect(c.stats().disabled).toBe(false);
  });

  it('无校验数据（changed 缺失）→ 只清挂账，不奖惩', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('a', BOX, 'uia');
    c.settlePendingClick(null);
    c.beginStep(frame(2));
    expect(await c.lookup('a')).not.toBeNull();
  });

  it('纯视觉框（grounding）：上一次该目标点击校验成功前不给复用', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    await c.record('橡皮擦', { x: 488, y: 68, w: 24, h: 24 }, 'grounding');
    c.beginStep(frame(2));
    expect(await c.lookup('橡皮擦')).toBeNull(); // 视觉估的框未经点击验证 → 保守 miss
    c.beginStep(frame(3));
    await c.record('橡皮擦', { x: 488, y: 68, w: 24, h: 24 }, 'grounding');
    c.settlePendingClick(true); // 该次实时定位后的点击校验成功
    c.beginStep(frame(4));
    expect(await c.lookup('橡皮擦')).not.toBeNull(); // 局部复核 + 已验证 → 可复用
  });
});

describe('GroundCache 保守与容量', () => {
  it('窗口签名/整帧指纹缺失：record 跳过、lookup 一律 miss', async () => {
    const c = cacheWith(fpStable);
    expect(await c.record('a', BOX, 'uia')).toBe(false); // 未 beginStep
    expect(await c.lookup('a')).toBeNull();
    c.beginStep({ windowSignature: undefined, frameHash: FRAME, step: 1 });
    expect(await c.record('a', BOX, 'uia')).toBe(false); // 缺窗口签名
    expect(await c.lookup('a')).toBeNull();
    c.beginStep({ windowSignature: WIN, frameHash: undefined, step: 2 });
    expect(await c.record('a', BOX, 'uia')).toBe(false); // 缺整帧指纹
    expect(await c.lookup('a')).toBeNull();
  });

  it('非有限数坐标不记表', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    expect(await c.record('a', { x: NaN, y: 0, w: 10, h: 10 }, 'uia')).toBe(false);
  });

  it('LRU：超上限淘汰最久未用条目', async () => {
    const c = cacheWith(fpStable, { maxEntries: 4 });
    c.beginStep(frame(1));
    for (const t of ['a', 'b', 'c', 'd']) await c.record(t, BOX, 'uia');
    expect(await c.lookup('a')).not.toBeNull(); // a 变最近使用
    await c.record('e', BOX, 'uia');
    expect(c.stats().entries).toBe(4);
    expect(await c.lookup('b')).toBeNull(); // b 是最久未用 → 被淘汰
    expect(await c.lookup('a')).not.toBeNull();
    expect(await c.lookup('e')).not.toBeNull();
  });

  it('默认上限 64 条', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    for (let i = 0; i < 70; i++) await c.record(`t${i}`, BOX, 'uia');
    expect(c.stats().entries).toBe(64);
    expect(await c.lookup('t0')).toBeNull();
    expect(await c.lookup('t69')).not.toBeNull();
  });

  it('windowSignatureOf：无前台窗口返回 undefined', () => {
    expect(windowSignatureOf(undefined)).toBeUndefined();
    expect(windowSignatureOf({ title: 'T', className: 'C' })).toBe('T|C');
  });
});

describe('wrapExecutorWithGroundCache 接线', () => {
  it('grounding 首次穿透记表；点击校验成功后二次命中缓存且不再调执行器', async () => {
    const c = cacheWith(fpStable);
    const base = makeBase(okGrounding, [clickResult(true)]);
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    const r1 = await ex.execute('ui_locate', { query: '橡皮擦' });
    expect(base.locCalls()).toBe(1);
    expect(r1.summary).toContain('grounding 视觉定位');
    await ex.execute('mouse_click', { x: 500, y: 80 }); // 实时坐标点击 + 校验成功
    c.beginStep(frame(2));
    const r2 = await ex.execute('ui_locate', { query: '橡皮擦' });
    expect(base.locCalls()).toBe(1); // 降级链被短路
    expect(r2.summary).toContain('[坐标缓存]');
    expect(r2.summary).toContain('中心(500,80)');
    expect(r2.summary).toContain('源 grounding');
    expect(r2.summary).toContain('坐标缓存 命中1/查2'); // 观测行进 resultSummary（无新增 IPC）
  });

  it('UIA 可解析时永远先实时查询：uia 源命中仍走执行器并返回实时结果（缓存只兜底）', async () => {
    const c = cacheWith(fpStable);
    const base = makeBase(okUia());
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '保存' });
    expect((await c.lookup('保存'))!.source).toBe('uia');
    c.beginStep(frame(2));
    const r = await ex.execute('ui_locate', { query: '保存' });
    expect(base.locCalls()).toBe(2); // 未被缓存短路
    expect(r.summary).toContain('找到1个'); // 返回实时 rect，不吃缓存
  });

  it('UIA 完全不可用（实时链失败）→ uia 条目兜底返回缓存坐标', async () => {
    const c = cacheWith(fpStable);
    const base = makeBase(okUia());
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '保存' });
    base.setLoc(locFail); // UIA/整链都不可用
    c.beginStep(frame(2));
    const r = await ex.execute('ui_locate', { query: '保存' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('[坐标缓存]');
  });

  it('缓存坐标点击校验无效 → 该条失效（自愈剔除）', async () => {
    const c = cacheWith(fpStable);
    const base = makeBase(okGrounding, [clickResult(true), clickResult(false)]);
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '橡皮擦' }); // 实时定位（record 挂账 fromCache=false）
    await ex.execute('mouse_click', { x: 500, y: 80 }); // changed=true → 目标已验证
    c.beginStep(frame(2));
    const hit = await ex.execute('ui_locate', { query: '橡皮擦' }); // 命中缓存 → 挂账 fromCache=true
    expect(hit.summary).toContain('[坐标缓存]');
    await ex.execute('mouse_click', { x: 500, y: 80 }); // changed=false → 自愈剔除
    expect(c.stats().clickFailures).toBe(1);
    expect(c.stats().entries).toBe(0);
    expect(c.stats().disabled).toBe(false); // 单次失效不停用
  });

  it('grounding 结果记表 source=grounding；SoM 记 uia', async () => {
    const c = cacheWith(fpStable);
    const ex = wrapExecutorWithGroundCache(makeBase(okGrounding).executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '橡皮擦' });
    c.settlePendingClick(true); // grounding 源需点击验证过才允许查表命中（门控另有专测）
    expect((await c.lookup('橡皮擦'))!.source).toBe('grounding');
    const c2 = cacheWith(fpStable);
    const som: ToolResult = { ok: true, summary: 'SoM 视觉选择: "x" 中心(1,2)', data: { matches: [{ name: 'x', x: 0, y: 0, w: 20, h: 20 }] } };
    const ex2 = wrapExecutorWithGroundCache(makeBase(som).executor, c2);
    c2.beginStep(frame(1));
    await ex2.execute('ui_locate', { query: 'x' });
    expect((await c2.lookup('x'))!.source).toBe('uia');
  });

  it('click:true（找到即点）不吃缓存：动作语义原样交给执行器', async () => {
    const c = cacheWith(fpStable);
    const base = makeBase(okUia());
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '保存' });
    c.beginStep(frame(2));
    await ex.execute('ui_locate', { query: '保存', click: true });
    expect(base.locCalls()).toBe(2);
  });

  it('失败结果与无坐标结果不记表；非 ui_locate 动作与空 query 原样透传', async () => {
    const c = cacheWith(fpStable);
    c.beginStep(frame(1));
    const failBase = makeBase(locFail);
    await wrapExecutorWithGroundCache(failBase.executor, c).execute('ui_locate', { query: '不存在' });
    expect(c.stats().records).toBe(0);
    const noBoxBase = makeBase({ ok: true, summary: '找到0个' });
    await wrapExecutorWithGroundCache(noBoxBase.executor, c).execute('ui_locate', { query: '没有数据' });
    expect(c.stats().records).toBe(0);
    const passthrough = makeBase(okUia());
    const ex = wrapExecutorWithGroundCache(passthrough.executor, c);
    await ex.execute('mouse_click', { x: 1, y: 2 });
    await ex.execute('ui_locate', { query: '  ' });
    expect(passthrough.locCalls()).toBe(1); // 空 query 穿透；均不查表不记表
  });
});
