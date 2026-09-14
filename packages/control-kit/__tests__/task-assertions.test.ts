// L1 断言求值器单测：fs/Excel 直读 + 相对路径解析 + 失败详情可读
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { evaluateTaskAssertion, registerAssertion } from '../src/task-assertions';

const dir = mkdtempSync(path.join(tmpdir(), 'task-assert-'));

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

async function makeExcel(name: string, cell: string, value: ExcelJS.CellValue): Promise<string> {
  const fp = path.join(dir, name);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getCell(cell).value = value;
  await wb.xlsx.writeFile(fp);
  return fp;
}

describe('evaluateTaskAssertion', () => {
  it('file_exists：存在通过 / 不存在给出路径详情', async () => {
    const fp = path.join(dir, 'ok.txt');
    writeFileSync(fp, 'hi', 'utf8');
    expect((await evaluateTaskAssertion({ kind: 'file_exists', path: fp })).passed).toBe(true);
    const miss = await evaluateTaskAssertion({ kind: 'file_exists', path: path.join(dir, 'nope.txt') });
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain('不存在');
  });

  it('file_contains：包含通过 / 不含时给出实际内容摘要', async () => {
    const fp = path.join(dir, 'c.txt');
    writeFileSync(fp, '计算结果：8192', 'utf8');
    expect((await evaluateTaskAssertion({ kind: 'file_contains', path: fp, text: '8192' })).passed).toBe(true);
    const miss = await evaluateTaskAssertion({ kind: 'file_contains', path: fp, text: '4096' });
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain('4096');
    expect(miss.detail).toContain('8192');
  });

  it('excel_cell：值相等通过（数字/字符串统一字符串化比较）', async () => {
    const fp = await makeExcel('n.xlsx', 'C1', 110);
    expect((await evaluateTaskAssertion({ kind: 'excel_cell', path: fp, cell: 'C1', equals: '110' })).passed).toBe(true);
    const miss = await evaluateTaskAssertion({ kind: 'excel_cell', path: fp, cell: 'C1', equals: '220' });
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain('110');
    expect(miss.detail).toContain('220');
  });

  it('相对路径按 baseDir 解析；求值器永不抛错（出错转为断言失败详情）', async () => {
    writeFileSync(path.join(dir, 'rel.txt'), 'x', 'utf8');
    expect((await evaluateTaskAssertion({ kind: 'file_exists', path: 'rel.txt' }, dir)).passed).toBe(true);
    // 目录当文件读 → 读文件抛错 → 转为失败而非异常
    const err = await evaluateTaskAssertion({ kind: 'file_contains', path: '', text: 'x' }, dir);
    expect(err.passed).toBe(false);
    expect(err.detail).toBeTruthy();
  });
});

// A-M5/Q9：注册表分发——宿主注入的求值器与内置求值器同表；未注册 kind（如未注入 UIA 时的窗口断言）给可读失败
describe('registerAssertion（断言注册表分发）', () => {
  it('注入自定义求值器后按 kind 分发；求值器抛错仍转为失败结果', async () => {
    registerAssertion('ui_element_exists', async (a) => {
      if (a.kind !== 'ui_element_exists') return { passed: false, detail: 'mismatch' };
      if (a.text === 'boom') throw new Error('sidecar down');
      return { passed: true, detail: `注入求值器命中 ${a.text}` };
    });
    const hit = await evaluateTaskAssertion({ kind: 'ui_element_exists', text: '确定' });
    expect(hit).toEqual({ passed: true, detail: '注入求值器命中 确定' });
    const err = await evaluateTaskAssertion({ kind: 'ui_element_exists', text: 'boom' });
    expect(err.passed).toBe(false);
    expect(err.detail).toContain('sidecar down');
  });

  it('未注册类型（window_title_contains 未注入时）返回「未知断言类型」而非抛错', async () => {
    const res = await evaluateTaskAssertion({ kind: 'window_title_contains', text: '金蝶' });
    expect(res.passed).toBe(false);
    expect(res.detail).toContain('未知断言类型');
  });

  it('内置三型仍走默认求值器（注册表化不改变既有行为）', async () => {
    const fp = path.join(dir, 'builtin.txt');
    writeFileSync(fp, 'v', 'utf8');
    expect((await evaluateTaskAssertion({ kind: 'file_exists', path: fp })).passed).toBe(true);
    expect((await evaluateTaskAssertion({ kind: 'file_contains', path: fp, text: 'zzz' })).passed).toBe(false);
    expect((await evaluateTaskAssertion({ kind: 'excel_cell', path: fp, cell: 'A1', equals: '1' })).passed).toBe(false);
  });
});
