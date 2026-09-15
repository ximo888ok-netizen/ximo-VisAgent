// 坐标表缓存单测：命中条件、四类失效（窗口/帧距/scroll/TTL）、LRU、归一化键、保守 miss、执行器包装
import { describe, expect, it } from 'vitest';
import {
  GroundCache,
  hashDistance,
  normalizeLocateTarget,
  windowSignatureOf,
  wrapExecutorWithGroundCache,
} from '../src/agent/ground-cache';
import type { ToolResult } from '../src/tools/registry';

const WIN = 'Untitled - Notepad|Notepad';
const FRAME = '0'.repeat(64);
/** 造 n 位汉明距离的帧指纹 */
const flipped = (n: number): string => FRAME.split('').map((c, i) => (i < n ? '1' : c)).join('');
const frame = (step: number, win = WIN, hash = FRAME) => ({ windowSignature: win, frameHash: hash, step });
const BOX = { x: 100, y: 50, w: 40, h: 20 };

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

function countingExecutor(result: ToolResult): { executor: { execute: (n: string, a: Record<string, unknown>) => Promise<ToolResult> }; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    executor: {
      async execute() {
        calls += 1;
        return result;
      },
    },
  };
}

describe('GroundCache 查表命中条件', () => {
  it('窗口签名一致且帧距在阈内 → 命中并返回坐标/中心/来源', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    expect(c.record('保存按钮', BOX, 'uia')).toBe(true);
    c.beginStep(frame(2));
    const hit = c.lookup('保存按钮');
    expect(hit).not.toBeNull();
    expect(hit!.box).toEqual(BOX);
    expect(hit!.center).toEqual({ x: 120, y: 60 });
    expect(hit!.source).toBe('uia');
    expect(hit!.stepsAgo).toBe(1);
  });

  it('归一化键等价：大小写与多余空格折叠为同一键', () => {
    expect(normalizeLocateTarget('  Save   Button ')).toBe('save button');
    const c = new GroundCache();
    c.beginStep(frame(1));
    c.record('Save   Button', BOX, 'grounding');
    expect(c.lookup('save button')).not.toBeNull();
    expect(c.lookup('SAVE BUTTON')).not.toBeNull();
  });

  it('hashDistance：全等=0，二进制串按汉明距离，其余不可比=null', () => {
    expect(hashDistance(FRAME, FRAME)).toBe(0);
    expect(hashDistance(FRAME, flipped(3))).toBe(3);
    expect(hashDistance(FRAME, 'abc')).toBeNull();
    expect(hashDistance('0'.repeat(64), '0'.repeat(32))).toBeNull();
  });
});

describe('GroundCache 失效触发', () => {
  it('前台窗口变化 → beginStep 整表失效', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    c.record('保存按钮', BOX, 'uia');
    c.beginStep(frame(2, '其他窗口|Other'));
    expect(c.lookup('保存按钮')).toBeNull();
    expect(c.stats().entries).toBe(0);
  });

  it('帧指纹距离超阈（布局动了）→ miss 且旧条目被剔除；阈内仍命中', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    c.record('a', BOX, 'grounding');
    c.beginStep(frame(2, WIN, flipped(3)));
    expect(c.lookup('a')).not.toBeNull();
    c.beginStep(frame(3, WIN, flipped(10)));
    expect(c.lookup('a')).toBeNull();
    expect(c.stats().entries).toBe(0);
  });

  it('执行过 scroll 动作 → 整表失效；其他动作不清表', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    c.record('a', BOX, 'uia');
    c.onAction('mouse_click');
    expect(c.lookup('a')).not.toBeNull();
    c.onAction('mouse_scroll');
    expect(c.lookup('a')).toBeNull();
  });

  it('步数 TTL：≤20 步仍命中，超 20 步 miss', () => {
    const c = new GroundCache();
    c.beginStep(frame(5));
    c.record('a', BOX, 'uia');
    c.beginStep(frame(25));
    expect(c.lookup('a')).not.toBeNull();
    c.beginStep(frame(26));
    expect(c.lookup('a')).toBeNull();
  });

  it('invalidateAll 清空条目但保留计数（跨任务量总命中率）', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    c.record('a', BOX, 'uia');
    c.lookup('a');
    c.invalidateAll('task-end');
    expect(c.stats().entries).toBe(0);
    expect(c.stats().hits).toBe(1);
    expect(c.lookup('a')).toBeNull();
    expect(c.stats().misses).toBe(1);
  });
});

describe('GroundCache 保守与容量', () => {
  it('窗口签名/帧指纹缺失：record 跳过、lookup 一律 miss', () => {
    const c = new GroundCache();
    expect(c.record('a', BOX, 'uia')).toBe(false); // 未 beginStep
    expect(c.lookup('a')).toBeNull();
    c.beginStep({ windowSignature: undefined, frameHash: FRAME, step: 1 });
    expect(c.record('a', BOX, 'uia')).toBe(false); // 缺窗口签名
    expect(c.lookup('a')).toBeNull();
    c.beginStep({ windowSignature: WIN, frameHash: undefined, step: 2 });
    expect(c.record('a', BOX, 'uia')).toBe(false); // 缺帧指纹
    expect(c.lookup('a')).toBeNull();
  });

  it('LRU：超上限淘汰最久未用条目', () => {
    const c = new GroundCache(4);
    c.beginStep(frame(1));
    for (const t of ['a', 'b', 'c', 'd']) c.record(t, BOX, 'uia');
    expect(c.lookup('a')).not.toBeNull(); // a 变最近使用
    c.record('e', BOX, 'uia');
    expect(c.stats().entries).toBe(4);
    expect(c.lookup('b')).toBeNull(); // b 是最久未用 → 被淘汰
    expect(c.lookup('a')).not.toBeNull();
    expect(c.lookup('e')).not.toBeNull();
  });

  it('默认上限 64 条', () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    for (let i = 0; i < 70; i++) c.record(`t${i}`, BOX, 'uia');
    expect(c.stats().entries).toBe(64);
    expect(c.lookup('t0')).toBeNull();
    expect(c.lookup('t69')).not.toBeNull();
  });

  it('windowSignatureOf：无前台窗口返回 undefined', () => {
    expect(windowSignatureOf(undefined)).toBeUndefined();
    expect(windowSignatureOf({ title: 'T', className: 'C' })).toBe('T|C');
  });
});

describe('wrapExecutorWithGroundCache 接线', () => {
  it('首次 ui_locate 穿透执行器并记表（UIA 命中 source=uia）；二次命中缓存不再调执行器', async () => {
    const c = new GroundCache();
    const base = countingExecutor(okUia());
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    const r1 = await ex.execute('ui_locate', { query: '保存' });
    expect(base.calls()).toBe(1);
    expect(r1.summary).toContain('找到1个');
    c.beginStep(frame(2));
    const r2 = await ex.execute('ui_locate', { query: '保存' });
    expect(base.calls()).toBe(1); // 降级链被跳过
    expect(r2.summary).toContain('[坐标缓存]');
    expect(r2.summary).toContain('中心(25,40)');
    expect(r2.summary).toContain('源 uia');
    // 观测：命中/未命中计数进 resultSummary（现有 step 事件，无新增 IPC）
    expect(r2.summary).toContain('坐标缓存 命中1/查2');
    const hit = c.lookup('保存');
    expect(hit!.source).toBe('uia');
  });

  it('grounding 结果记表 source=grounding；SoM 记 uia', async () => {
    const c = new GroundCache();
    const ex = wrapExecutorWithGroundCache(countingExecutor(okGrounding).executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '橡皮擦' });
    expect(c.lookup('橡皮擦')!.source).toBe('grounding');
    const c2 = new GroundCache();
    const ex2 = wrapExecutorWithGroundCache(countingExecutor({ ok: true, summary: 'SoM 视觉选择: "x" 中心(1,2)', data: { matches: [{ name: 'x', x: 0, y: 0, w: 2, h: 4 }] } }).executor, c2);
    c2.beginStep(frame(1));
    await ex2.execute('ui_locate', { query: 'x' });
    expect(c2.lookup('x')!.source).toBe('uia');
  });

  it('click:true（找到即点）不吃缓存：动作语义原样交给执行器', async () => {
    const c = new GroundCache();
    const base = countingExecutor(okUia());
    const ex = wrapExecutorWithGroundCache(base.executor, c);
    c.beginStep(frame(1));
    await ex.execute('ui_locate', { query: '保存' });
    c.beginStep(frame(2));
    await ex.execute('ui_locate', { query: '保存', click: true });
    expect(base.calls()).toBe(2);
  });

  it('失败结果与无坐标结果不记表；非 ui_locate 动作与空 query 原样透传', async () => {
    const c = new GroundCache();
    c.beginStep(frame(1));
    const failBase = countingExecutor({ ok: false, summary: '', error: '未找到' });
    await wrapExecutorWithGroundCache(failBase.executor, c).execute('ui_locate', { query: '不存在' });
    expect(c.stats().records).toBe(0);
    const noBoxBase = countingExecutor({ ok: true, summary: '找到0个' });
    await wrapExecutorWithGroundCache(noBoxBase.executor, c).execute('ui_locate', { query: '没有数据' });
    expect(c.stats().records).toBe(0);
    const passthrough = countingExecutor(okUia());
    const ex = wrapExecutorWithGroundCache(passthrough.executor, c);
    await ex.execute('mouse_click', { x: 1, y: 2 });
    await ex.execute('ui_locate', { query: '  ' });
    expect(passthrough.calls()).toBe(2); // 均穿透，不查表不记表
  });
});
