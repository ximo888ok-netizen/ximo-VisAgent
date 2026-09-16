// 定位摘要与候选相关性单测：summary 带坐标（token 预算分档）+ 查询词/候选名校验（残留候选防盲点）
import { beforeEach, describe, expect, it } from 'vitest';
import type { UiNode } from '@ximo-visagent/shared-types';
import {
  flattenTree, formatLocateDetail, formatLocateLine, nameRelevance, somMismatchNote, windowMatches,
} from '../src/ui-locate';
import { setScreenScale } from '../src/screen-scale';

const tree: UiNode = {
  id: 0, type: 'Pane', name: '桌面',
  children: [
    {
      id: 1, type: 'Window', name: '记事本', isWindow: true, x: 0, y: 0, w: 800, h: 600,
      children: [
        { id: 11, type: 'Button', name: '保存', x: 700, y: 520, w: 80, h: 32 },
      ],
    },
  ],
};

beforeEach(() => setScreenScale(1, 1));

describe('formatLocateLine / formatLocateDetail（候选摘要带坐标）', () => {
  it('格式：#id "名称"(类型) @(中心x,中心y 宽x高) [窗口]', () => {
    const m = flattenTree(tree).find((x) => x.id === 11)!;
    expect(formatLocateLine(m, true)).toBe('#11 "保存"(Button) @(740,536 80x32) [记事本]');
    expect(formatLocateLine(m, false)).toBe('#11 "保存"(Button) [记事本]');
  });

  it('候选 ≤8（默认 limit）：每条都带坐标', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: i, name: `项${i}`, type: 'Button', window: 'W', x: i * 10, y: 0, w: 8, h: 8, center: { x: i * 10 + 4, y: 4 },
    }));
    const detail = formatLocateDetail(many);
    expect(detail.match(/@\(/g)).toHaveLength(8);
    expect(detail).not.toContain('仅前');
  });

  it('候选 >8：只有 top-4 带坐标并附消歧提示（token 预算纪律）', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: i, name: `项${i}`, type: 'Button', window: 'W', x: i * 10, y: 0, w: 8, h: 8, center: { x: i * 10 + 4, y: 4 },
    }));
    const detail = formatLocateDetail(many);
    expect(detail.match(/@\(/g)).toHaveLength(4);
    expect(detail).toContain('#0 "项0"');
    expect(detail).toContain('仅前 4 条带坐标');
  });
});

describe('nameRelevance / somMismatchNote（查询词与候选名一致性）', () => {
  it('真实事故复刻：查询「卸载」候选「番茄意面」「13.mp4」= 零字符交集 → mismatch 并出警示语', () => {
    expect(nameRelevance('卸载', '番茄意面')).toBe('mismatch');
    expect(nameRelevance('卸载', '13.mp4')).toBe('mismatch');
    expect(somMismatchNote('卸载', '番茄意面')).toContain('疑似残留');
  });

  it('子串/包含/共同字符 → match；无名占位 "(Button)" → unknown 不标注', () => {
    expect(nameRelevance('卸载', '卸载程序')).toBe('match');
    expect(nameRelevance('保存草稿', '保存')).toBe('match');
    expect(nameRelevance('uninstall', 'Uninstall a program')).toBe('match');
    expect(nameRelevance('卸载', '添加或删除程序')).toBe('mismatch'); // 无任何共同字符（保守：只标注不拦截）
    expect(nameRelevance('卸载', '(Button)')).toBe('unknown');
    expect(somMismatchNote('卸载', '(Button)')).toBe('');
  });

  it('windowMatches：双向包含判定（UIA 窗口名 vs Win32 前台标题）', () => {
    expect(windowMatches('记事本', '记事本 - Text')).toBe(true);
    expect(windowMatches('设置', 'Windows 设置')).toBe(true);
    expect(windowMatches('Chrome', '记事本')).toBe(false);
  });
});
