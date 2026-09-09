// 生成 scripts/budget.json 的当前基线（只在引入新豁免时手工运行）
// 用法：node scripts/gen-budget.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTS = new Set(['.ts', '.tsx']);
const SKIP = new Set(['node_modules', 'dist', 'out', 'release', 'coverage', '.turbo']);

function codeLines(text) {
  let n = 0;
  let block = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (block) {
      if (line.endsWith('*/')) block = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.endsWith('*/')) block = true;
      continue;
    }
    if (line.startsWith('//')) continue;
    n++;
  }
  return n;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const roots = [
  path.join(ROOT, 'apps', 'desktop', 'src'),
  ...fs.readdirSync(path.join(ROOT, 'packages'))
    .map((d) => path.join(ROOT, 'packages', d, 'src'))
    .filter((d) => fs.existsSync(d)),
];

const baseline = {};
for (const file of roots.flatMap((r) => walk(r, []))) {
  const text = fs.readFileSync(file, 'utf8');
  const escapes = text.split('as unknown as').length - 1;
  if (escapes === 0) continue;
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  baseline[rel] = { lines: codeLines(text), escapes };
}

const sorted = Object.fromEntries(Object.entries(baseline).sort((a, b) => a[0].localeCompare(b[0])));
fs.writeFileSync(path.join(ROOT, 'scripts', 'budget.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf8');
console.log(`已写入 ${Object.keys(sorted).length} 条豁免基线`);
console.log(JSON.stringify(sorted, null, 2));
