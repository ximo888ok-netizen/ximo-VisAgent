// HostPerception 快照装配单测：每步索引摘要的开关语义与降级缺席（假索引注入，不启动侧车进程）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedElement } from '../src/uia-index';

vi.spyOn(console, 'log').mockImplementation(() => undefined);

import { HostPerception } from '../src/index';
import { setHost } from '../src/host';
import { configureWindowIndexDeps, resetWindowIndex } from '../src/window-index';

const elements: IndexedElement[] = [{
  ref: 1, runtimeId: 'rid,1', name: '保存', controlType: 'Button', className: '', automationId: '',
  rect: { x: 700, y: 520, w: 80, h: 32 }, center: { x: 740, y: 536 },
  enabled: true, offscreen: false, focused: false, focusable: true,
  patterns: { invoke: true, toggle: false, scroll: false, selectionItem: false, expandCollapse: false },
  path: '记事本/保存',
}];

let indexCalls = 0;
let degraded = false;

beforeEach(() => {
  resetWindowIndex();
  indexCalls = 0;
  degraded = false;
  configureWindowIndexDeps({
    index: async () => {
      indexCalls++;
      return degraded
        ? { ok: false, reason: 'uia-degraded' }
        : { ok: true, signature: 'sig-1', ms: 10, windows: [{ hwnd: 9, title: '记事本', className: 'Notepad', pid: 42, elements }] };
    },
  });
  setHost({
    captureScreen: async () => Buffer.from('shot'),
    getForegroundInfo: async () => ({ title: '记事本', className: 'Notepad' }),
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openApp: async () => undefined,
  });
});

describe('HostPerception.snapshot（索引摘要接入）', () => {
  it('默认开：快照携带带 #ref 的窗口索引摘要', async () => {
    const snap = await new HostPerception().snapshot();
    expect(snap.interactiveList).toContain('窗口索引[记事本]');
    expect(snap.interactiveList).toContain('#1 保存 (Button) @(740,536) [可点击]');
    expect(snap.interactiveList).toContain('ui_click(ref:#编号)');
  });

  it('显式关（配置项 false）：不采摘要，快照字段整体缺席（对象形状与旧实现一致，回归红线）', async () => {
    const snap = await new HostPerception({ interactiveListEnabled: () => false }).snapshot();
    expect('interactiveList' in snap).toBe(false);
    expect(indexCalls).toBe(0);
  });

  it('sidecar 降级：整段省略，不输出空清单误导模型', async () => {
    degraded = true;
    const snap = await new HostPerception().snapshot();
    expect('interactiveList' in snap).toBe(false);
  });
});
