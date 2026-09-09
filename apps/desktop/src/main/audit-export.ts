/**
 * audit-export.ts — 审计导出到文件（CSV/JSON）
 *
 * 落盘位置固定为 userData/exports，文件名带时间戳（D6：派生文件由调用方按需清理）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { ZODB } from './audit-store';

export function exportAuditToFile(
  audit: ZODB,
  kind: 'csv' | 'json',
): { ok: boolean; path?: string; error?: string } {
  try {
    const content = kind === 'csv' ? audit.exportCsv() : audit.exportJson();
    const dir = path.join(app.getPath('userData'), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `audit-${new Date().toISOString().replace(/[:.]/g, '-')}.${kind}`);
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'export failed' };
  }
}
