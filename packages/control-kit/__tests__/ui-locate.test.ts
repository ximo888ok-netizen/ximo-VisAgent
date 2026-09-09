// ui-locate 纯逻辑单测：展平/搜索/坐标换算/SoM 候选（场景复刻自 2026-09-05 Qoder CN 误点事故）
import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates, flattenTree, searchMatches, zoomedBoxToScreen, type UiMatch } from '../src/ui-locate';
import { setScreenScale } from '../src/screen-scale';
import type { UiNode } from '@ximo-visagent/shared-types';

/** 模拟桌面树：记事本窗口 + 桌面（Program Manager 下挂图标簇与真实 Qoder 图标，物理像素坐标） */
const tree: UiNode = {
  id: 0,
  type: 'Pane',
  name: '桌面',
  children: [
    {
      id: 1,
      type: 'Window',
      name: '记事本',
      isWindow: true,
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      children: [
        { id: 11, type: 'Button', name: '保存', x: 700, y: 520, w: 80, h: 32 },
        { id: 12, type: 'Edit', name: '无标题 - 记事本', x: 10, y: 10, w: 780, h: 500 },
        // 无名按钮（自绘/Chromium 应用的典型形态，仅 SoM 候选收集）
        { id: 13, type: 'Button', x: 600, y: 520, w: 40, h: 32 },
      ],
    },
    {
      id: 9,
      type: 'Window',
      name: 'Program Manager',
      isWindow: true,
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
      children: [
        // 顶部图标簇（事故现场：模型曾把它误认成 Qoder）
        { id: 2, type: 'ListItem', name: 'CatPaw', x: 1696, y: 96, w: 76, h: 92 },
        { id: 3, type: 'ListItem', name: 'CatPawAI', x: 1696, y: 8, w: 76, h: 92, offscreen: true },
        // 桌面中部真实 Qoder 图标（physical 948,735）
        { id: 4, type: 'ListItem', name: 'Qoder CN', x: 948, y: 735, w: 76, h: 92 },
        { id: 5, type: 'ListItem', name: 'Qoder CN - 快捷方式', x: 100, y: 735, w: 76, h: 92 },
      ],
    },
  ],
};

let all: UiMatch[];

beforeEach(() => {
  setScreenScale(1.5, 1.5);
  all = flattenTree(tree);
});

describe('flattenTree', () => {
  it('过滤 offscreen 与无名称节点，window 归属正确', () => {
    const ids = all.map((m) => m.id);
    expect(ids).not.toContain(3); // offscreen
    expect(ids).not.toContain(0); // 根节点无矩形则不收（有名称有 rect 才收）
    const save = all.find((m) => m.id === 11);
    expect(save?.window).toBe('记事本');
    const icon = all.find((m) => m.id === 4);
    expect(icon?.window).toBe('Program Manager');
  });

  it('物理坐标按当前缩放换算到截图坐标系（1.5x 下 Qoder CN 中心 = 657.3, 520.7）', () => {
    const icon = all.find((m) => m.id === 4);
    expect(icon).toBeDefined();
    expect(icon!.center.x).toBeCloseTo((948 + 76 / 2) / 1.5, 5);
    expect(icon!.center.y).toBeCloseTo((735 + 92 / 2) / 1.5, 5);
    expect(icon!.w).toBeCloseTo(76 / 1.5, 5);
  });

  it('缩放为 1（原生分辨率截图）时坐标即物理坐标', () => {
    setScreenScale(1, 1);
    const flat = flattenTree(tree);
    const icon = flat.find((m) => m.id === 4)!;
    expect(icon.center.x).toBe(948 + 38);
    expect(icon.center.y).toBe(735 + 46);
  });
});

describe('searchMatches', () => {
  it('大小写不敏感子串匹配', () => {
    const hits = searchMatches(all, 'qoder');
    expect(hits.map((m) => m.id)).toEqual([4, 5]);
  });

  it('全等命中排在包含命中前面', () => {
    const hits = searchMatches(all, 'qoder cn');
    expect(hits[0]!.id).toBe(4);
    expect(hits[0]!.name).toBe('Qoder CN');
  });

  it('limit 截断', () => {
    expect(searchMatches(all, 'o', 1)).toHaveLength(1);
  });

  it('空 query 返回空，未命中返回空', () => {
    expect(searchMatches(all, '  ')).toEqual([]);
    expect(searchMatches(all, '不存在的东西')).toEqual([]);
  });
});

describe('collectCandidates（SoM）', () => {
  it('额外收无名可交互控件，name 显示为 "(类型)"；默认 flattenTree 不收', () => {
    const cands = collectCandidates(tree);
    const unnamed = cands.find((c) => c.id === 13);
    expect(unnamed).toBeDefined();
    expect(unnamed!.name).toBe('(Button)');
    expect(unnamed!.center.x).toBeCloseTo((600 + 20) / 1.5, 5);
    // 有名控件两边都收
    expect(cands.some((c) => c.id === 11)).toBe(true);
    // 默认 flattenTree 不收无名（ui_locate 按名搜索行为不变）
    expect(all.some((m) => m.id === 13)).toBe(false);
  });

  it('limit 截断候选数', () => {
    expect(collectCandidates(tree, 2)).toHaveLength(2);
  });
});

describe('zoomedBoxToScreen（zoom 精修坐标映射）', () => {
  it('放大图像素 → 截图坐标：origin + 像素/zoom', () => {
    const r = zoomedBoxToScreen({ x: 40, y: 60, w: 100, h: 20 }, { x: 100, y: 200 }, 2);
    expect(r.x).toBe(120);
    expect(r.y).toBe(230);
    expect(r.w).toBe(50);
    expect(r.h).toBe(10);
  });

  it('zoom<=0 防御：原样返回', () => {
    const box = { x: 40, y: 60, w: 100, h: 20 };
    expect(zoomedBoxToScreen(box, { x: 100, y: 200 }, 0)).toEqual(box);
  });
});
