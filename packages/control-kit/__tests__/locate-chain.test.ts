// 降级链链级单测：UIA → SoM 编号选择 → 自由 grounding(+zoom) → OCR → null 交调用方目测
//（ComputerToolExecutor.uiLocate/groundingLookup 编排逻辑，全部用替身，不碰真实设备/模型）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SomCandidate, ToolResult } from '@ximo-visagent/agent-core';
import type { UiNode } from '@ximo-visagent/shared-types';

// uia-client / ocr-lookup 全量替身（sidecar 进程与 PowerShell OCR 都不允许真实启动）
const mocks = vi.hoisted(() => ({
  uia: {
    degraded: false,
    tree: undefined as unknown,
    start: vi.fn(async () => undefined),
    getUiTree: vi.fn(async () => ({ ok: true, total: 0, cache: 0, tree: undefined as unknown })),
  },
  ocrLookupTool: vi.fn(),
}));
vi.mock('../src/uia-client', () => ({
  getUiaClient: () => ({
    get degraded() { return mocks.uia.degraded; },
    healthy: true,
    start: mocks.uia.start,
    stop: () => undefined,
    getUiTree: mocks.uia.getUiTree,
  }),
}));
vi.mock('../src/ocr-lookup', () => ({
  ocrLookupTool: (...args: unknown[]) => mocks.ocrLookupTool(...args) as Promise<ToolResult | null>,
  ocrRecognizeAll: vi.fn(async () => null),
  ocrLookup: vi.fn(async () => null),
}));

import { ComputerToolExecutor } from '../src/executor';
import { setHost } from '../src/host';
import { setScreenScale } from '../src/screen-scale';

/** 记事本窗口：有名「保存」按钮 + 无名按钮（SoM 候选）；坐标为截图坐标系（缩放 1:1） */
const tree: UiNode = {
  id: 0, type: 'Pane', name: '桌面',
  children: [
    {
      id: 1, type: 'Window', name: '记事本', isWindow: true, x: 0, y: 0, w: 800, h: 600,
      children: [
        { id: 11, type: 'Button', name: '保存', x: 700, y: 520, w: 80, h: 32 },
        { id: 13, type: 'Button', x: 600, y: 520, w: 40, h: 32 },
      ],
    },
  ],
};

const groundingHit = { name: '目标', x: 100, y: 200, w: 60, h: 30, rawBox: [100, 200, 160, 230] };

const grounding = vi.fn();
const somLookup = vi.fn();
let ex: ComputerToolExecutor;

beforeEach(() => {
  setScreenScale(1, 1);
  mocks.uia.degraded = false;
  mocks.uia.tree = tree;
  mocks.uia.getUiTree.mockImplementation(async () => ({ ok: true, total: 0, cache: 0, tree: mocks.uia.tree }));
  mocks.uia.start.mockClear();
  mocks.ocrLookupTool.mockReset();
  mocks.ocrLookupTool.mockResolvedValue(null);
  grounding.mockReset();
  grounding.mockResolvedValue([groundingHit]);
  somLookup.mockReset();
  somLookup.mockResolvedValue(null);
  setHost({
    captureScreen: async () => Buffer.from('dirty-shot'),
    captureCleanScreen: async () => Buffer.from('clean-shot'),
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    getForegroundInfo: async () => ({ title: '记事本', className: 'Notepad' }),
    openApp: async () => undefined,
  });
  ex = new ComputerToolExecutor({ grounding, somLookup });
});

describe('ui_locate 降级链（链级顺序与交棒）', () => {
  it('UIA 命中 → 短路：不调 SoM/grounding/OCR', async () => {
    const r = await ex.execute('ui_locate', { query: '保存' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('找到1个');
    expect(somLookup).not.toHaveBeenCalled();
    expect(grounding).not.toHaveBeenCalled();
    expect(mocks.ocrLookupTool).not.toHaveBeenCalled();
  });

  it('UIA 未命中 → 落 SoM：优先于自由 grounding，候选来自 UIA 树、截图用净帧', async () => {
    somLookup.mockResolvedValue({ name: '(Button)', x: 600, y: 520, w: 40, h: 32 });
    const r = await ex.execute('ui_locate', { query: '不存在的目标' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('SoM 视觉选择');
    expect(r.summary).toContain('中心(620,536)');
    // grounding 排后：SoM 命中即返回，不回归坐标
    expect(grounding).not.toHaveBeenCalled();
    expect(mocks.ocrLookupTool).not.toHaveBeenCalled();
    // 净帧优先 + 候选（含无名 Button，index 从 1 起连续）
    const [shot, query, candidates] = somLookup.mock.calls[0] as [Buffer, string, SomCandidate[]];
    expect(shot.toString()).toBe('clean-shot');
    expect(query).toBe('不存在的目标');
    expect(candidates.map((c) => c.index)).toEqual(candidates.map((_, i) => i + 1));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.label === '(Button)')).toBe(true);
  });

  it('SoM 未选中 → 落自由 grounding（host 无 captureZoom 时直接用粗框）', async () => {
    somLookup.mockResolvedValue(null);
    const r = await ex.execute('ui_locate', { query: '纯图标目标' });
    expect(somLookup).toHaveBeenCalledTimes(1);
    expect(grounding).toHaveBeenCalledTimes(1);
    expect((grounding.mock.calls[0] as [Buffer])[0].toString()).toBe('clean-shot');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('grounding 视觉定位');
    expect(r.summary).not.toContain('zoom 精修');
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(1);
    expect(mocks.ocrLookupTool).not.toHaveBeenCalled();
  });

  it('SoM 调用抛错 → 视同未命中，继续降级 grounding（链不因一档异常而断）', async () => {
    somLookup.mockRejectedValue(new Error('vision api down'));
    const r = await ex.execute('ui_locate', { query: '目标' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('grounding 视觉定位');
  });

  it('grounding 也失败（空/null）→ OCR 兜底命中则返回；OCR 也失败 → ok:false 交调用方目测', async () => {
    somLookup.mockResolvedValue(null);
    grounding.mockResolvedValue([]);
    mocks.ocrLookupTool.mockResolvedValue({ ok: true, summary: 'OCR 命中「目标」', data: { matches: [] } });
    const hit = await ex.execute('ui_locate', { query: '目标' });
    expect(hit.ok).toBe(true);
    expect(hit.summary).toContain('OCR');

    mocks.ocrLookupTool.mockResolvedValue(null);
    grounding.mockResolvedValue(null);
    const miss = await ex.execute('ui_locate', { query: '目标' });
    // 全链失败：executor 给出 ok:false + 明确的"回退看图点击"文案（目测档由模型接管）
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('未找到名称含「目标」的元素');
    expect(miss.error).toContain('回退为看图点击');
  });

  it('UIA sidecar 降级（重启预算耗尽）→ 异常路径同样走 grounding 兜底', async () => {
    mocks.uia.degraded = true;
    const r = await ex.execute('ui_locate', { query: '保存' });
    // UIA 树拉取抛错 → 未进按名搜索，直接视觉链；UIA 挂了 → SoM 零候选 → grounding 命中
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('grounding 视觉定位');
    expect(somLookup).toHaveBeenCalledTimes(1);
    expect((somLookup.mock.calls[0] as [Buffer, string, SomCandidate[]])[2]).toEqual([]);
  });

  it('未注入视觉定位依赖 → 直接 OCR 兜底；OCR 不可用返回 ok:false（不抛错）', async () => {
    const bare = new ComputerToolExecutor();
    const r = await bare.execute('ui_locate', { query: '不存在的目标' });
    expect(r.ok).toBe(false);
    expect(mocks.ocrLookupTool).toHaveBeenCalledTimes(1);
    expect(grounding).not.toHaveBeenCalled();
  });
});
