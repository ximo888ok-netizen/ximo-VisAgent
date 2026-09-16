// HostPerception 快照装配单测：每步交互元素清单的开关语义与降级缺席（sidecar 全程替身，不启动进程）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiNode } from '@ximo-visagent/shared-types';

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

import { HostPerception } from '../src/index';
import { setHost } from '../src/host';
import { setScreenScale } from '../src/screen-scale';

const tree: UiNode = {
  id: 0, type: 'Pane', name: '桌面',
  children: [
    {
      id: 1, type: 'Window', name: '记事本', isWindow: true, x: 0, y: 0, w: 800, h: 600,
      children: [{ id: 11, type: 'Button', name: '保存', x: 700, y: 520, w: 80, h: 32 }],
    },
  ],
};

beforeEach(() => {
  setScreenScale(1, 1);
  uiaMocks.degraded = false;
  uiaMocks.healthy = true;
  uiaMocks.getUiTree.mockClear();
  uiaMocks.getUiTree.mockImplementation(async () => ({ ok: true, total: 0, cache: 0, tree }));
  setHost({
    captureScreen: async () => Buffer.from('shot'),
    getForegroundInfo: async () => ({ title: '记事本', className: 'Notepad' }),
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openApp: async () => undefined,
  });
});

describe('HostPerception.snapshot（清单接入）', () => {
  it('默认开：快照携带前台窗口清单', async () => {
    const snap = await new HostPerception().snapshot();
    expect(snap.interactiveList).toContain('可交互元素清单[记事本]');
    expect(snap.interactiveList).toContain('1. 保存 (Button) @(740,536)');
  });

  it('显式关（配置项 false）：不采清单，快照字段整体缺席（对象形状与旧实现一致，回归红线）', async () => {
    const snap = await new HostPerception({ interactiveListEnabled: () => false }).snapshot();
    expect('interactiveList' in snap).toBe(false);
    expect(uiaMocks.getUiTree).not.toHaveBeenCalled();
  });

  it('sidecar 降级：整段省略，不输出空清单误导模型', async () => {
    uiaMocks.degraded = true;
    const snap = await new HostPerception().snapshot();
    expect('interactiveList' in snap).toBe(false);
  });
});
