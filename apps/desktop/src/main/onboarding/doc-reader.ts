/**
 * onboarding/doc-reader.ts — 资料研读阶段
 *
 * 分块阅读资料 → LLM 提取事实卡（claim + sourceRef + 置信度）。
 * 断点续读由调用方通过 cursor 管理。
 */
import type { ChatMessage, ILLMClient } from '@ximo-visagent/llm-providers';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeSource } from '../../shared/schemas/employee';
import type { PositionRow } from '../stores/employee-types';
import {
  CHUNK_CHAR_LIMIT,
  MIN_CHUNK_SIZE,
  type DocChunk,
  type RawFactCard,
} from './types';
import { hashStr } from './helpers';

/** 从岗位配置解析知识来源列表 */
export function parseKnowledgeSources(position: PositionRow): KnowledgeSource[] {
  try {
    return JSON.parse(position.knowledgeJson) as KnowledgeSource[];
  } catch {
    return [];
  }
}

/** 解析断点游标 JSON */
export function parseCursor(json: string): Record<string, number> {
  try {
    return JSON.parse(json) as Record<string, number>;
  } catch {
    return {};
  }
}

/** 读取资料并分块 */
export function readAndChunk(src: KnowledgeSource, workspaceDir: string): DocChunk[] {
  const fullPath = path.isAbsolute(src.path) ? src.path : path.join(workspaceDir, src.path);

  if (src.kind === 'dir') {
    return readDirAsChunks(fullPath, src.path);
  }

  if (src.kind === 'url') {
    return [{
      source: src.path,
      chunkIndex: 0,
      text: `[URL 资料: ${src.path} — 需人工确认内容]`,
      lineStart: 0,
      lineEnd: 0,
      hash: hashStr(src.path),
    }];
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    return splitIntoChunks(content, src.path);
  } catch {
    return [];
  }
}

/** 用 LLM 读取单个分块，提取事实卡 */
export async function readChunk(
  llm: ILLMClient,
  chunk: DocChunk,
  sourcePath: string,
): Promise<RawFactCard[]> {
  const systemPrompt = `你是一个资料分析助手。阅读以下文档片段，提取关键事实。
每张事实卡必须包含：
- topic: 主题标签（简短）
- claim: 事实陈述（一句话）
- sourceRef: 来源引用（格式：${sourcePath} L${chunk.lineStart}-${chunk.lineEnd}）
- confidence: 置信度 0-1（1=明确陈述，0.5=推测，0.3=模糊）

只输出 JSON 数组，不要多余文本。格式：
[{"topic":"","claim":"","sourceRef":"","confidence":0.8}]

如果片段无有价值的事实，返回空数组 []。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: chunk.text.slice(0, CHUNK_CHAR_LIMIT) },
  ];

  try {
    const res = await llm.chat(messages);
    const text = res.content?.trim() ?? '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as RawFactCard[];
    return parsed
      .filter((c) => c.claim && c.topic)
      .map((c) => ({
        ...c,
        sourceRef: c.sourceRef || `${sourcePath} L${chunk.lineStart}-${chunk.lineEnd}`,
        confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.6,
      }));
  } catch {
    return [];
  }
}

// ---------- 内部辅助 ----------

function readDirAsChunks(dirPath: string, source: string): DocChunk[] {
  const chunks: DocChunk[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!['.md', '.txt', '.json', '.ts', '.js', '.py', '.yml', '.yaml', '.csv'].includes(ext)) continue;
      const fullPath = path.join(dirPath, e.name);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        chunks.push(...splitIntoChunks(content, `${source}/${e.name}`));
      } catch { /* 跳过 */ }
    }
  } catch { /* 跳过 */ }
  return chunks;
}

function splitIntoChunks(content: string, source: string): DocChunk[] {
  const lines = content.split('\n');
  const chunks: DocChunk[] = [];
  let current: string[] = [];
  let lineStart = 0;
  let charCount = 0;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    current.push(line);
    charCount += line.length + 1;

    if (charCount >= CHUNK_CHAR_LIMIT) {
      const text = current.join('\n');
      chunks.push({
        source,
        chunkIndex,
        text,
        lineStart: lineStart + 1,
        lineEnd: i + 1,
        hash: hashStr(text),
      });
      current = [];
      lineStart = i + 1;
      charCount = 0;
      chunkIndex++;
    }
  }

  if (current.length > 0 && current.join('\n').length >= MIN_CHUNK_SIZE) {
    const text = current.join('\n');
    chunks.push({
      source,
      chunkIndex,
      text,
      lineStart: lineStart + 1,
      lineEnd: lines.length,
      hash: hashStr(text),
    });
  }

  return chunks;
}
