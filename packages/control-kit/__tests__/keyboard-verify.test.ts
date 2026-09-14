/**
 * keyboard-verify.test.ts — 中文输入回读闭环纯逻辑门禁
 *
 * 背景：keyboard_type 注入后无验证，输入法干扰丢字时模型盲信成功。
 * 轻量方案 = UIA focused value 尾部抽样，读不到就跳过（不误报、不重试、不阻塞）。
 * 「注入→回读」全链路涉及真实 sidecar/焦点，属设备级验证（test:device），此处只钉纯逻辑。
 */
import { describe, it, expect } from 'vitest';
import { needsInputVerify, verifyTypedText } from '../src/keyboard-verify';

describe('needsInputVerify', () => {
  it('含中文/全角字符才值得回读，纯 ASCII 跳过', () => {
    expect(needsInputVerify('把会议安排在明天')).toBe(true);
    expect(needsInputVerify('ＡＢＣ')).toBe(true);
    expect(needsInputVerify('hello world 123')).toBe(false);
    expect(needsInputVerify('')).toBe(false);
  });
});

describe('verifyTypedText', () => {
  it('回读包含期望尾部 → matched', () => {
    expect(verifyTypedText('请帮我把文件重命名', '已输入内容：请帮我把文件重命名')).toEqual({ skipped: false, matched: true });
  });

  it('尾部丢字 → matched:false（调用方只告警，不重试）', () => {
    expect(verifyTypedText('中文输入测试abcdef', '中文输入测').matched).toBe(false);
  });

  it('空白差异容忍（编辑器自动加空格等）', () => {
    expect(verifyTypedText('你好 世界', '你 好 世 界').matched).toBe(true);
  });

  it('回读为空 = 不可验证 → skipped，不判失败', () => {
    expect(verifyTypedText('中文', '')).toEqual({ skipped: true, matched: false });
    expect(verifyTypedText('   ', '有内容')).toEqual({ skipped: true, matched: false });
  });
});
