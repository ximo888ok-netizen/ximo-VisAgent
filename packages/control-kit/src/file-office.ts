// files/* + office/* 工具实现：工作目录沙箱 + exceljs 文件级读写
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolExecutor, ToolResult } from '@ximo-visagent/agent-core';
import ExcelJS from 'exceljs';

export class FileOfficeExecutor implements ToolExecutor {
  constructor(private workspaceDir: string) {}

  private resolveSafe(relPath: string): string {
    const base = path.resolve(this.workspaceDir);
    const target = path.resolve(base, relPath);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`路径越界: ${relPath}（仅允许工作目录内）`);
    }
    return target;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'file_read': return await this.fileRead(args);
        case 'file_write': return await this.fileWrite(args);
        case 'file_list': return await this.fileList(args);
        case 'excel_read_range': return await this.excelReadRange(args);
        case 'excel_write_cell': return await this.excelWriteCell(args);
        default:
          return { ok: false, summary: '', error: `FileOfficeExecutor 未知工具: ${name}` };
      }
    } catch (err) {
      const e = err as Error;
      return { ok: false, summary: '', error: e.message };
    }
  }

  private async fileRead(args: Record<string, unknown>): Promise<ToolResult> {
    const fp = this.resolveSafe(String(args.path));
    const content = await fs.readFile(fp, 'utf8');
    return { ok: true, summary: `读取 ${args.path} (${content.length} 字符)`, data: { content } };
  }

  private async fileWrite(args: Record<string, unknown>): Promise<ToolResult> {
    const fp = this.resolveSafe(String(args.path));
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, String(args.content ?? ''), 'utf8');
    return { ok: true, summary: `写入 ${args.path}` };
  }

  private async fileList(args: Record<string, unknown>): Promise<ToolResult> {
    const dir = String(args.dir ?? '');
    const fp = this.resolveSafe(dir);
    // 沙箱目录尚未创建时返回空列表而非 ENOENT（避免模型浪费步数在目录初始化上）
    if (!existsSync(fp)) {
      return { ok: true, summary: `目录不存在（视为空）: ${dir || '.'}` };
    }
    const entries = await fs.readdir(fp, { withFileTypes: true });
    const list = entries.map((e) => `${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`);
    return { ok: true, summary: `目录列表 (${list.length} 项):\n${list.join('\n')}` };
  }

  private async excelReadRange(args: Record<string, unknown>): Promise<ToolResult> {
    const fp = this.resolveSafe(String(args.file));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const sheetName = args.sheet ? String(args.sheet) : (wb.worksheets[0]?.name ?? '');
    const ws = wb.getWorksheet(sheetName);
    if (!ws) return { ok: false, summary: '', error: `工作表不存在: ${sheetName}` };
    const range = String(args.range ?? 'A1');
    const { colStart, rowStart, colEnd, rowEnd } = parseRange(range);
    const rows: Record<string, unknown>[] = [];
    for (let r = rowStart; r <= rowEnd; r++) {
      const row: Record<string, unknown> = {};
      for (let c = colStart; c <= colEnd; c++) {
        const cell = ws.getCell(r, c);
        row[colName(c)] = cell.value instanceof Object ? JSON.stringify(cell.value) : cell.value;
      }
      rows.push(row);
    }
    return { ok: true, summary: `读取 ${sheetName}!${range} (${rows.length} 行)`, data: { rows } };
  }

  private async excelWriteCell(args: Record<string, unknown>): Promise<ToolResult> {
    const fp = this.resolveSafe(String(args.file));
    const wb = new ExcelJS.Workbook();
    const exists = await fs.access(fp).then(() => true).catch(() => false);
    if (exists) await wb.xlsx.readFile(fp);
    const sheetName = args.sheet ? String(args.sheet) : (wb.worksheets[0]?.name ?? 'Sheet1');
    let ws = wb.getWorksheet(sheetName);
    if (!ws) {
      ws = wb.addWorksheet(sheetName);
    }
    const cell = String(args.cell);
    ws.getCell(cell).value = args.value as ExcelJS.CellValue;
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await wb.xlsx.writeFile(fp);
    return { ok: true, summary: `写入 ${sheetName}!${cell} = ${JSON.stringify(args.value)}` };
  }
}

function parseRange(range: string): { colStart: number; rowStart: number; colEnd: number; rowEnd: number } {
  const [startRef, endRef] = range.split(':');
  if (!startRef) throw new Error(`非法区域: ${range}`);
  const endRange = endRef ?? startRef;
  const s = parseCell(startRef);
  const e = parseCell(endRange);
  return {
    colStart: Math.min(s.col, e.col),
    rowStart: Math.min(s.row, e.row),
    colEnd: Math.max(s.col, e.col),
    rowEnd: Math.max(s.row, e.row),
  };
}

function parseCell(ref: string): { col: number; row: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!m || !m[1] || !m[2]) throw new Error(`非法单元格: ${ref}`);
  return { col: colIndex(m[1]), row: parseInt(m[2], 10) };
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colName(idx: number): string {
  let n = idx;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type { ToolResult, ToolExecutor };