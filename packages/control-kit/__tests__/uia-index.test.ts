// uia-index 客户端单测：假侧车报文（不 spawn 进程），覆盖
// · indexWindow 参数装配（pid/hwnd/maxNodes/excludePids + 宿主 pid 恒注入）
// · Element 全字段解析（patterns 可选项/缺矩形）
// · truncated 透传、侧车错误帧、坏 JSON、降级短路、超时/reject 降级
// · resolveRefs 线格式与逐条 ok:false
import { describe, expect, it } from 'vitest';
import { withSelfPid } from '../src/uia-client';
import {
  indexWindow,
  resolveRefs,
  type ResolveRefItem,
  type UiaTransport,
} from '../src/uia-index';

interface Captured {
  method: string;
  payload: Record<string, unknown>;
}

// 假侧车：记录发出的线报文，回放 canned result（不 spawn 进程）
function makeFake(result: unknown, opts: { degraded?: boolean; healthy?: boolean; startThrows?: string; requestThrows?: string } = {}) {
  const calls: Captured[] = [];
  let started = 0;
  const client: UiaTransport = {
    healthy: opts.healthy ?? true,
    degraded: opts.degraded ?? false,
    start: async () => {
      started++;
      if (opts.startThrows) throw new Error(opts.startThrows);
    },
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (opts.requestThrows) throw new Error(opts.requestThrows);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  };
  return { client, calls, get started() { return started; } };
}

function firstCall(f: { calls: Captured[] }): Captured {
  const c = f.calls[0];
  if (!c) throw new Error('期望有 1 次侧车调用，实际 0');
  return c;
}

const okResult = {
  ok: true,
  signature: 'abc123',
  ms: 210,
  truncated: false,
  windows: [
    {
      hwnd: 123456,
      title: '无标题 - 记事本',
      className: 'Notepad',
      pid: 4321,
      elements: [
        {
          ref: 1,
          runtimeId: '42,60397',
          name: '另存为',
          controlType: 'Button',
          className: 'Button',
          automationId: 'saveAs',
          rect: { x: 10, y: 20, w: 100, h: 30 },
          center: { x: 60, y: 35 },
          enabled: true,
          offscreen: false,
          focused: false,
          focusable: true,
          patterns: { invoke: true, toggle: false, scroll: false, selectionItem: false, expandCollapse: false },
          path: '窗口/工具栏/另存为',
        },
        {
          ref: 2,
          runtimeId: '42,60398',
          name: '深色模式',
          controlType: 'CheckBox',
          className: '',
          automationId: '',
          rect: { x: 0, y: 0, w: 10, h: 10 },
          center: { x: 5, y: 5 },
          enabled: true,
          offscreen: true,
          focused: false,
          focusable: true,
          patterns: {
            invoke: false, toggle: true, scroll: false, selectionItem: false, expandCollapse: false,
            toggleState: 1, value: 'v', selected: true, expanded: false,
            rangeValue: { min: 0, max: 100, value: 42 },
          },
          path: '设置/深色模式',
        },
        {
          // 缺 rect/center 的离屏节点（合法形状）
          ref: 3,
          runtimeId: '42,60399',
          name: '',
          controlType: 'Pane',
          className: '',
          automationId: '',
          enabled: false,
          offscreen: true,
          focused: false,
          focusable: false,
          patterns: { invoke: false, toggle: false, scroll: true, selectionItem: false, expandCollapse: true },
          path: '窗口',
        },
      ],
    },
  ],
};

describe('indexWindow', () => {
  it('pid 模式：参数装配 + 宿主 pid 恒并入 excludePids + 全字段解析', async () => {
    const f = makeFake(okResult);
    const r = await indexWindow({ pid: 4321, maxNodes: 500, excludePids: [777] }, f.client);
    expect(f.calls).toHaveLength(1);
    const p = firstCall(f).payload;
    expect(firstCall(f).method).toBe('indexWindow');
    expect(p.pid).toBe(4321);
    expect(p.maxNodes).toBe(500);
    expect('hwnd' in p).toBe(false);
    expect((p.excludePids as number[])).toContain(777);
    expect((p.excludePids as number[])).toContain(process.pid); // 交付3：自我污染防线
    expect(r.ok).toBe(true);
    expect(r.signature).toBe('abc123');
    expect(r.ms).toBe(210);
    expect(r.truncated).toBe(false);
    const el = r.windows?.[0]?.elements[0];
    expect(el?.ref).toBe(1);
    expect(el?.runtimeId).toBe('42,60397');
    expect(el?.center).toEqual({ x: 60, y: 35 });
    expect(el?.patterns.invoke).toBe(true);
    expect(el?.path).toBe('窗口/工具栏/另存为');
    const cb = r.windows?.[0]?.elements[1];
    expect(cb?.patterns.toggleState).toBe(1);
    expect(cb?.patterns.value).toBe('v');
    expect(cb?.patterns.selected).toBe(true);
    expect(cb?.patterns.expanded).toBe(false);
    expect(cb?.patterns.rangeValue).toEqual({ min: 0, max: 100, value: 42 });
    const noRect = r.windows?.[0]?.elements[2];
    expect(noRect?.rect).toBeUndefined();
    expect(noRect?.center).toBeUndefined();
    expect(noRect?.enabled).toBe(false);
  });

  it('hwnd 模式只发 hwnd，不带 pid/maxNodes', async () => {
    const f = makeFake(okResult);
    await indexWindow({ hwnd: 987 }, f.client);
    const p = firstCall(f).payload;
    expect(p.hwnd).toBe(987);
    expect('pid' in p).toBe(false);
    expect('maxNodes' in p).toBe(false);
  });

  it('truncated 透传', async () => {
    const f = makeFake({ ...okResult, truncated: true });
    const r = await indexWindow({}, f.client);
    expect(r.truncated).toBe(true);
  });

  it('侧车错误帧 → { ok:false, reason } 不抛错', async () => {
    const f = makeFake({ ok: false, error: 'no visible window' });
    const r = await indexWindow({ pid: 1 }, f.client);
    expect(r).toEqual({ ok: false, reason: 'no visible window' });
  });

  it('坏 JSON → reason=sidecar-bad-json', async () => {
    const f = makeFake('not json {{{');
    const r = await indexWindow({}, f.client);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('sidecar-bad-json');
  });

  it('降级态短路：不发请求', async () => {
    const f = makeFake(okResult, { degraded: true });
    const r = await indexWindow({}, f.client);
    expect(r).toEqual({ ok: false, reason: 'uia-degraded' });
    expect(f.calls).toHaveLength(0);
  });

  it('超时 reject → { ok:false, reason } 不抛错', async () => {
    const f = makeFake(null, { requestThrows: 'sidecar timeout: indexWindow' });
    const r = await indexWindow({}, f.client);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('timeout');
  });

  it('不健康时先 start 再请求', async () => {
    const f = makeFake(okResult, { healthy: false });
    const r = await indexWindow({}, f.client);
    expect(f.started).toBe(1);
    expect(r.ok).toBe(true);
  });

  it('start 失败（spawn 崩）也收敛为降级', async () => {
    const f = makeFake(okResult, { healthy: false, startThrows: 'sidecar error: ENOENT' });
    const r = await indexWindow({}, f.client);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ENOENT');
  });
});

describe('resolveRefs', () => {
  it('线格式：items 带可选 hwnd；逐条解析 ok:false 项', async () => {
    const f = makeFake({
      ok: true,
      resolved: [
        { runtimeId: '42,1', ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, center: { x: 2, y: 4 }, enabled: true, offscreen: false },
        { runtimeId: '42,2', ok: false, error: 'unresolvable' },
      ],
    });
    const items: ResolveRefItem[] = [
      { runtimeId: '42,1', hwnd: 55 },
      { runtimeId: '42,2' },
    ];
    const r = await resolveRefs(items, f.client);
    expect(firstCall(f).method).toBe('resolveRefs');
    const wireItems = firstCall(f).payload.items as Record<string, unknown>[];
    expect(wireItems[0]).toEqual({ runtimeId: '42,1', hwnd: 55 });
    expect('hwnd' in (wireItems[1] ?? {})).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.resolved?.[0]?.ok).toBe(true);
    expect(r.resolved?.[0]?.rect).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(r.resolved?.[1]).toEqual({ runtimeId: '42,2', ok: false });
  });

  it('空 items 直接拒发（不打无意义 RPC）', async () => {
    const f = makeFake({ ok: true, resolved: [] });
    const r = await resolveRefs([], f.client);
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe('withSelfPid（交付3 参数面）', () => {
  it('恒含宿主 pid 且去重', () => {
    const list = withSelfPid([process.pid, 123]);
    expect(list.filter((v) => v === process.pid)).toHaveLength(1);
    expect(list).toContain(123);
  });
});
