// B1：SoM 候选补盲的纯逻辑门禁（OCR→候选映射 + UIA/OCR 合并去重）
import { describe, expect, it } from 'vitest';
import { mergeSomCandidates, ocrHitsToSom } from '../src/grounding-fallback';
import type { OcrHit } from '../src/ocr-lookup';

const hit = (text: string, x: number, y: number): OcrHit => ({ text, x, y, w: 40, h: 16 });

describe('ocrHitsToSom（OCR 文字框 → SoM 候选）', () => {
  it('空文本丢弃、label 截断、index 置 0 待合并重排', () => {
    const r = ocrHitsToSom([hit('  ', 1, 1), hit('发送消息给你们', 10, 20)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.label.length).toBeLessThanOrEqual(24);
    expect(r[0]!.index).toBe(0);
    expect(r[0]!).toMatchObject({ x: 10, y: 20, w: 40, h: 16 });
  });
});

describe('mergeSomCandidates（UIA 优先 + OCR 去重合并）', () => {
  const uia = [{ index: 1, label: '保存', x: 100, y: 100, w: 60, h: 24 }];
  it('OCR 项中心离 UIA 项 <40px → 视为重复丢弃；远离的保留并重排 index', () => {
    const ocr = [
      { index: 0, label: '保存(重复)', x: 110, y: 104, w: 40, h: 16 }, // 中心≈(130,112) 距 UIA 中心(130,112) 很近
      { index: 0, label: '取消', x: 500, y: 500, w: 40, h: 16 },
    ];
    const merged = mergeSomCandidates(uia, ocr);
    expect(merged.map((m) => m.label)).toEqual(['保存', '取消']);
    expect(merged.map((m) => m.index)).toEqual([1, 2]);
  });
  it('cap 封顶', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ index: 0, label: `b${i}`, x: 1000 + i * 200, y: 1000, w: 10, h: 10 }));
    expect(mergeSomCandidates(uia, many, 3).length).toBe(3);
  });
});
