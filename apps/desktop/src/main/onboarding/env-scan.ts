/**
 * onboarding/env-scan.ts — 环境扫描阶段
 *
 * 扫描已安装应用 / 常用目录 / 默认工作目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EnvProfile } from './types';

/**
 * 扫描环境：已安装应用 + 工作目录子目录。
 * 结果截断到 50 个应用 / 30 个目录，防止 LLM token 爆炸。
 */
export function scanEnvironment(workspaceDir: string): EnvProfile {
  const apps: string[] = [];
  const dirs: string[] = [];

  const appDirs = [
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    path.join(workspaceDir, '..', '..'),
  ];

  for (const d of appDirs) {
    try {
      if (fs.existsSync(d)) {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) apps.push(path.join(d, e.name));
        }
      }
    } catch { /* 权限/不存在，跳过 */ }
  }

  try {
    if (fs.existsSync(workspaceDir)) {
      const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) dirs.push(path.join(workspaceDir, e.name));
      }
    }
  } catch { /* 跳过 */ }

  return { apps: apps.slice(0, 50), dirs: dirs.slice(0, 30), workspaceDir };
}
