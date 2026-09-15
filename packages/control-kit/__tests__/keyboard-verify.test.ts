/**
 * keyboard-verify.test.ts — 输入回读闭环纯逻辑门禁
 *
 * 背景：keyboard_type 注入后无验证，输入法干扰丢字时模型盲信成功。
 * 方案 = UIA focused value 尾部抽样；value 不可得时降级「字段 bbox 区域 OCR 回读」。
 * 结论三态（verified/mismatch/unverifiable），仅告警不阻塞。
 * 「注入→回读」全链路涉及真实 sidecar/截图/OCR 二进制，属设备级验证（test:device）；
 * 这里全部用依赖注入替身钉纯逻辑与分支选择，不碰真实设备。
 */
import { describe, expect, it } from 'vitest';
import {
  compareTypedText,
  needsInputVerify,
  normalizeForCompare,
  verifyTypedInput,
  type FocusedSnapshot,
} from '../src/keyboard-verify';

describe('needsInputVerify', () => {
  it('含中文/全角字符才值得回读，纯 ASCII 跳过', () => {
    expect(needsInputVerify('把会议安排在明天')).toBe(true);
    expect(needsInputVerify('ＡＢＣ')).toBe(true);
    expect(needsInputVerify('hello world 123')).toBe(false);
    expect(needsInputVerify('')).toBe(false);
  });
});

describe('normalizeForCompare', () => {
  it('去空白 + 大小写折叠 + 全角→半角', () => {
    expect(normalizeForCompare('ＡＢＣ ＤＥＦ')).toBe('abcdef');
    expect(normalizeForCompare('Ｈｅｌｌｏ　世界')).toBe('hello世界');
    expect(normalizeForCompare('中文　全角空格')).toBe('中文全角空格');
  });
});

describe('compareTypedText 三态', () => {
  it('回读包含期望尾部 → verified', () => {
    expect(compareTypedText('请帮我把文件重命名', '已输入内容：请帮我把文件重命名')).toBe('verified');
  });

  it('尾部丢字 → mismatch（调用方只告警，不重试）', () => {
    expect(compareTypedText('中文输入测试abcdef', '中文输入测')).toBe('mismatch');
  });

  it('空白/大小写/全半角差异容忍', () => {
    expect(compareTypedText('你好 世界', '你 好 世 界')).toBe('verified');
    expect(compareTypedText('Hello ＷＯＲＬＤ 测试', 'helloworld 测试')).toBe('verified');
  });

  it('任一侧为空 = 不可验证 → unverifiable，不判失败', () => {
    expect(compareTypedText('中文', '')).toBe('unverifiable');
    expect(compareTypedText('   ', '有内容')).toBe('unverifiable');
  });
});

const snap = (value: string, rect: FocusedSnapshot['rect'] = null): FocusedSnapshot => ({ value, rect });
const RECT = { x: 100, y: 200, w: 300, h: 24 };

describe('verifyTypedInput 通道选择与结构化结论', () => {
  it('纯 ASCII 文本无需验证 → null（不产生任何开销）', async () => {
    const out = await verifyTypedInput('hello', 0, { readFocused: async () => snap('hello') });
    expect(out).toBeNull();
  });

  it('UIA value 可得且匹配 → verified / channel=uia / note 空', async () => {
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('日程标题：把会议安排在明天'),
    });
    expect(out?.status).toBe('verified');
    expect(out?.channel).toBe('uia');
    expect(out?.note).toBe('');
  });

  it('UIA value 可得但不匹配 → mismatch，note 含期望与实际（仅告警）', async () => {
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('把会议布置'),
    });
    expect(out?.status).toBe('mismatch');
    expect(out?.channel).toBe('uia');
    expect(out?.note).toContain('⚠');
    expect(out?.note).toContain('把会议布置');
  });

  it('UIA value 不可得 → 走字段 bbox OCR 回读分支，命中 → verified / channel=ocr', async () => {
    let ocrRect: FocusedSnapshot['rect'] = null;
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('', RECT),
      ocrRegion: async (rect) => {
        ocrRect = rect;
        return '输入框内容 把会议安排在明天';
      },
    });
    expect(out?.status).toBe('verified');
    expect(out?.channel).toBe('ocr');
    expect(ocrRect).toEqual(RECT);
  });

  it('OCR 回读文本不符 → mismatch，actual 为 OCR 文本', async () => {
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('', RECT),
      ocrRegion: async () => '搜索 文件 下载',
    });
    expect(out?.status).toBe('mismatch');
    expect(out?.channel).toBe('ocr');
    expect(out?.actual).toBe('搜索 文件 下载');
    expect(out?.note).toContain('OCR');
  });

  it('UIA rect 也缺失 → unverifiable（无从回读）', async () => {
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('', null),
      ocrRegion: async () => '不该被调用',
    });
    expect(out?.status).toBe('unverifiable');
    expect(out?.channel).toBe('none');
    expect(out?.note).toContain('未验证');
  });

  it('rect 可得但 OCR 也不可用（返回 null）→ unverifiable，不阻塞', async () => {
    const out = await verifyTypedInput('把会议安排在明天', 0, {
      readFocused: async () => snap('', RECT),
      ocrRegion: async () => null,
    });
    expect(out?.status).toBe('unverifiable');
    expect(out?.channel).toBe('ocr');
    expect(out?.actual).toBe('');
  });
});
