// 每步可交互元素清单单测：裁剪规则（只前台窗口/上限/紧凑格式）与 sidecar 降级整段省略
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiNode } from '@ximo-visagent/shared-types';
import { buildInteractiveListSection, formatInteractiveList, selectForegroundInteractive } from '../src/interactive-list';
import { flattenTree } from '../src/ui-locate';
import { setHost } from '../src/host';
import { setScreenScale } from '../src/screen-scale';

const uiaMocks = vi.hoisted(() => ({
  degraded: false,
  healthy: true,
  start: vi.fn(async () => undefined),
  getUiTree: vi.fn(async () => ({ ok: true, total: 0, cache: 0, tree: undefined as unknown })),
}));
vi.mock('../src/uia-client', () => ({
  getUiaClient: () => ({
    get degraded() { return uiaMocks.degraded; },
    get healthy() { return uiaMocks.healthy; },
    start: uiaMocks.start,
    stop: () => undefined,
    getUiTree: uiaMocks.getUiTree,
  }),
}));

/** 记事本（前台）+ 资源管理器（后台）两窗口树；坐标为物理=截图（缩放 1:1） */
const tree: UiNode = {
  id: 0, type: 'Pane', name: '桌面',
  children: [
    {
      id: 1, type: 'Window', name: '记事本', isWindow: true, x: 0, y: 0, w: 800, h: 600,
      children: [
        { id: 11, type: 'Button', name: '保存', x: 700, y: 520, w: 80, h: 32 },
        { id: 12, type: 'Edit', name: '无标题 - 记事本', x: 10, y: 10, w: 780, h: 500 },
        { id: 13, type: 'Button', x: 600, y: 520, w: 40, h: 32 },
        { id: 14, type: 'ListItem', name: '离屏项', x: 0, y: 0, w: 10, h: 10, offscreen: true },
      ],
    },
    {
      id: 2, type: 'Window', name: '资源管理器', isWindow: true, x: 0, y: 0, w: 800, h: 600,
      children: [{ id: 21, type: 'Button', name: '后台按钮', x: 100, y: 100, w: 40, h: 20 }],
    },
  ],
};

beforeEach(() => {
  setScreenScale(1, 1);
  uiaMocks.degraded = false;
  uiaMocks.healthy = true;
  uiaMocks.start.mockClear();
  uiaMocks.getUiTree.mockImplementation(async () => ({ ok: true, total: 0, cache: 0, tree }));
  setHost({
    captureScreen: async () => Buffer.from('shot'),
    getForegroundInfo: async () => ({ title: '记事本', className: 'Notepad' }),
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openApp: async () => undefined,
  });
});

describe('selectForegroundInteractive（清单裁剪）', () => {
  const all = () => flattenTree(tree, 2000, true);

  it('只收前台窗口元素（有名 + 无名可交互），不回退全量', () => {
    const pool = selectForegroundInteractive(all(), '记事本');
    expect(pool).not.toBeNull();
    expect(pool!.map((m) => m.name)).toEqual(['保存', '无标题 - 记事本', '(Button)']);
    expect(pool!.some((m) => m.name.includes('后台'))).toBe(false);
    expect(pool!.some((m) => m.name.includes('离屏'))).toBe(false); // offscreen 由 flattenTree 过滤
  });

  it('前台窗口无候选 → null（宁缺毋滥；错窗清单会主动误导）', () => {
    expect(selectForegroundInteractive(all(), '一个不存在标题')).toBeNull();
    expect(selectForegroundInteractive(all(), null)).toBeNull();
  });

  it('上限封顶：默认 40 条', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: i, name: `按钮${i}`, type: 'Button', window: '记事本', x: 0, y: 0, w: 8, h: 8, center: { x: 4, y: 4 },
    }));
    expect(selectForegroundInteractive(many, '记事本')!.length).toBe(40);
  });
});

describe('formatInteractiveList（清单文本格式）', () => {
  it('序号. 名称 (短类型) @(中心x,中心y) + 头部统计', () => {
    const pool = selectForegroundInteractive(flattenTree(tree, 2000, true), '记事本')!;
    const text = formatInteractiveList(pool, pool.length, '记事本');
    expect(text).toContain('可交互元素清单[记事本]（共 3 个）');
    expect(text).toContain('1. 保存 (Button) @(740,536)');
    expect(text).not.toContain('ControlType.');
  });

  it('截断时给总数与精查提示；长名称 16 字截断', () => {
    const longName = '一'.repeat(30);
    const pool = Array.from({ length: 3 }, (_, i) => ({
      id: i, name: i === 1 ? longName : `项${i}`, type: 'ControlType.Button', window: 'W', x: 0, y: 0, w: 10, h: 10, center: { x: 5, y: 5 },
    }));
    const text = formatInteractiveList(pool, 97, 'W');
    expect(text).toContain('共 97 个，列前 3 个');
    expect(text).toContain('其余 94 个未列；清单外/要精确定位用 ui_locate');
    expect(text).toContain('一'.repeat(16));
    expect(text).not.toContain('一'.repeat(17));
  });
});

describe('buildInteractiveListSection（IO 侧行为）', () => {
  it('sidecar 降级 → undefined：整段省略，绝不输出空清单', async () => {
    uiaMocks.degraded = true;
    expect(await buildInteractiveListSection()).toBeUndefined();
    expect(uiaMocks.start).not.toHaveBeenCalled();
  });

  it('正常路径 → 前台窗口清单文本（与截图同坐标系）', async () => {
    const text = await buildInteractiveListSection();
    expect(text).toContain('可交互元素清单[记事本]');
    expect(text).toContain('1. 保存 (Button) @(740,536)');
  });

  it('前台窗口在 UIA 树里无候选 → undefined（不做全量回退）', async () => {
    setHost({
      captureScreen: async () => Buffer.from('shot'),
      getForegroundInfo: async () => ({ title: '某游戏全屏', className: 'X' }),
      readClipboard: async () => '',
      writeClipboard: async () => undefined,
      openApp: async () => undefined,
    });
    expect(await buildInteractiveListSection()).toBeUndefined();
  });

  it('UIA 抛错 → undefined（感知不因清单失败而中断）', async () => {
    uiaMocks.getUiTree.mockRejectedValue(new Error('sidecar died'));
    expect(await buildInteractiveListSection()).toBeUndefined();
  });
});
