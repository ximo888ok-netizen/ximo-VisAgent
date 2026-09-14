// L1 机器断言求值器：fs/ExcelJS 直读（非沙箱——断言是任务提交方声明的可信数据，不经模型之手）。
// 相对路径由调用方传 baseDir（工作区沙箱）解析；求值器永不抛错，失败以 { passed, detail } 返回。
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { AssertionResult, TaskAssertion } from '@ximo-visagent/agent-core';

/** 求值一条机器断言。baseDir 用于解析相对路径（绝对路径原样使用）。 */
export async function evaluateTaskAssertion(a: TaskAssertion, baseDir?: string): Promise<AssertionResult> {
  const p = resolvePath(a.path, baseDir);
  try {
    if (a.kind === 'file_exists') {
      if (!existsSync(p)) return { passed: false, detail: `文件不存在: ${p}` };
      return { passed: true, detail: `文件存在: ${p}` };
    }
    if (a.kind === 'file_contains') {
      if (!existsSync(p)) return { passed: false, detail: `文件不存在: ${p}` };
      const content = await fs.readFile(p, 'utf8');
      if (!content.includes(a.text)) return { passed: false, detail: `文件存在但不含「${a.text}」（实际内容前 80 字: ${content.slice(0, 80) || '(空)'}）` };
      return { passed: true, detail: `文件含「${a.text}」` };
    }
    if (a.kind === 'excel_cell') return evalExcelCell(a, p);
    return { passed: false, detail: `未知断言类型: ${(a as { kind: string }).kind}` };
  } catch (err) {
    return { passed: false, detail: `断言执行出错: ${(err as Error).message}` };
  }
}

/** excel_cell：指定表名严格选表（不存在即失败，绝不静默回退第一张）+ 值归一化 + 数值等值 */
async function evalExcelCell(a: Extract<TaskAssertion, { kind: 'excel_cell' }>, p: string): Promise<AssertionResult> {
  if (!existsSync(p)) return { passed: false, detail: `工作簿不存在: ${p}` };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = a.sheet ? wb.getWorksheet(a.sheet) : wb.worksheets[0];
  if (!ws) {
    const names = wb.worksheets.map((w) => w.name).join(', ');
    return { passed: false, detail: `工作表不存在: ${a.sheet}（现有: ${names}）` };
  }
  const actual = normalizeCellValue(ws.getCell(a.cell).value);
  if (!valuesEqual(actual, a.equals)) {
    return { passed: false, detail: `${ws.name}!${a.cell} 实际值「${actual}」≠ 期望「${a.equals}」` };
  }
  return { passed: true, detail: `${ws.name}!${a.cell} = ${a.equals}` };
}

/** 单元格值归一化：公式取 result、富文本拼接、日期本地时间格式化；未识别形态回退原始 JSON 串 */
export function normalizeCellValue(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date) return formatLocalDate(v);
  if (typeof v === 'object') {
    if ('formula' in v && 'result' in (v as { result?: ExcelJS.CellValue })) {
      return normalizeCellValue((v as { result: ExcelJS.CellValue }).result);
    }
    if ('richText' in v) {
      return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('').trim();
    }
    if ('text' in v) {
      return String((v as { text: unknown }).text ?? '').trim();
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/** 本地时间格式化：无时分秒 → YYYY-MM-DD；有时 → YYYY-MM-DD HH:mm:ss */
function formatLocalDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  return hasTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

/** 比较规则：双方都是可解析数字 → 数值等值（"110" == "110.0"）；否则 trim 后全等 */
export function valuesEqual(actual: string, expected: string): boolean {
  const a = actual.trim();
  const b = expected.trim();
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a === b;
}

function resolvePath(p: string, baseDir?: string): string {
  if (path.isAbsolute(p) || !baseDir) return p;
  return path.join(baseDir, p);
}
