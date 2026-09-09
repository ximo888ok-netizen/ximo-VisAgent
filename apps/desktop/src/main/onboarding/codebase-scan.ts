/**
 * onboarding/codebase-scan.ts — 代码库认知阶段
 *
 * 扫描目录结构 + 入口文件，生成代码库事实卡。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RawFactCard } from './types';

/** 扫描代码库结构，产出事实卡 */
export function scanCodebase(workspaceDir: string): RawFactCard[] {
  const cards: RawFactCard[] = [];

  // 目录结构
  try {
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length > 0) {
      cards.push({
        topic: 'codebase-structure',
        claim: `项目包含以下目录: ${dirs.join(', ')}`,
        sourceRef: `${workspaceDir}/`,
        confidence: 0.9,
      });
    }
  } catch { /* 跳过 */ }

  // 入口文件
  const entryFiles = ['package.json', 'AGENTS.md', 'docs/engineering.md', 'README.md'];
  for (const f of entryFiles) {
    const fullPath = path.join(workspaceDir, f);
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 500);
        cards.push({
          topic: 'codebase-entry',
          claim: `${f} 存在，内容摘要: ${content.slice(0, 200).replace(/\n/g, ' ')}...`,
          sourceRef: fullPath,
          confidence: 0.85,
        });
      }
    } catch { /* 跳过 */ }
  }

  return cards;
}
