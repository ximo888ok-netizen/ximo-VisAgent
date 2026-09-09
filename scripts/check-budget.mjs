// 存量债务预算：只能变小，不能变大。
//
// 为什么需要它：ESLint 的 max-lines 是新代码的硬墙，但仓库里已有若干历史巨模块
// （内核 loop、组合根 index、审计存储等）。一次性重构它们会让 PR 失去可读性，
// 放任不管则债务继续累积。预算把「当前值」钉成上限：任何让文件变胖的改动都会被拦下，
// 而重构瘦身后请同步调小 scripts/budget.json（数字只允许下降）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'scripts', 'budget.json');

/** 计入门禁的源码范围 */
const SCAN_ROOTS = ['apps/desktop/src', 'packages'];
const EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', 'coverage', '.turbo']);

/** 行人的口径与 ESLint max-lines 一致：不计空行与整行注释 */
function countCodeLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  let count = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.endsWith('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.endsWith('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//')) continue;
    count++;
  }
  return count;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const files = SCAN_ROOTS.flatMap((r) => walk(path.join(ROOT, r), []));

const violations = [];
const stale = new Set(Object.keys(baseline));

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const codeLines = countCodeLines(file);
  const escapes = (fs.readFileSync(file, 'utf8').match(/as unknown as/g) ?? []).length;
  stale.delete(rel);

  const allowed = baseline[rel] ?? { lines: Number.POSITIVE_INFINITY, escapes: Number.POSITIVE_INFINITY };
  if (codeLines > allowed.lines) {
    violations.push(`${rel}: 代码行 ${codeLines} > 预算 ${allowed.lines}（请拆分，或说明理由后调小预算）`);
  }
  if (escapes > allowed.escapes) {
    violations.push(`${rel}: as unknown as 出现 ${escapes} 次 > 预算 ${allowed.escapes}（禁止用双重断言掩盖类型错配）`);
  }
}

// 预算里残留的已删除文件也要报出来，避免清单腐烂
for (const gone of stale) violations.push(`budget.json 含已不存在的条目：${gone}（请删除）`);

if (violations.length > 0) {
  console.error('预算检查未通过：\n  ' + violations.join('\n  '));
  process.exit(1);
}

const tracked = Object.keys(baseline).length;
console.log(`预算检查通过（${tracked} 个受控条目，新文件由 ESLint max-lines 硬约束）`);
