// 使用 .NET Framework 4.8 自带 csc.exe 编译 UIA sidecar（无 .NET SDK 依赖）
// 输出: bin/uia-sidecar.exe
// M12 修复：非 Windows / 无 .NET 4.8 机器不阻塞 pnpm install
const fs = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync } = fs;

// M12 修复：非 Windows 环境跳过编译，不阻塞安装
if (process.platform !== 'win32') {
  console.log('[sidecar] 非 Windows 平台，跳过编译');
  process.exit(0);
}

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
if (!existsSync(csc)) {
  // M12 修复：找不到 csc 时只警告不阻塞
  console.warn(`[sidecar] csc.exe 未找到，跳过编译（${csc}）`);
  process.exit(0);
}

// GAC 程序集全路径解析
const gac = 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL';
function findGacAssembly(name) {
  const dir = join(gac, name);
  if (!existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dll = join(dir, e.name, `${name}.dll`);
    if (existsSync(dll)) return dll;
  }
  return null;
}

const refs = [
  'UIAutomationClient',
  'UIAutomationTypes',
  'WindowsBase',
].map(findGacAssembly);

const missing = refs.filter((r) => !r);
if (missing.length) {
  // M12 修复：GAC 缺失也只警告不阻塞
  console.warn(`[sidecar] 缺少 GAC 程序集: ${missing.join(', ')}`);
  process.exit(0);
}

const outDir = join(__dirname, 'bin');
mkdirSync(outDir, { recursive: true });

const out = join(outDir, 'uia-sidecar.exe');
const sources = fs.readdirSync(join(__dirname, 'src')).filter((f) => f.endsWith('.cs')).map((f) => join(__dirname, 'src', f));

const args = [
  '/nologo',
  '/optimize+',
  '/langversion:5',
  '/target:exe',
  `/out:${out}`,
  ...refs.map((r) => `/reference:${r}`),
  ...sources,
];

const r = spawnSync(csc, args, { encoding: 'utf8', stdio: 'pipe' });
if (r.status !== 0) {
  console.error('[sidecar] compile failed:', r.stdout, r.stderr);
  process.exit(1);
}
console.log(`[sidecar] compiled -> ${out} (${fs.statSync(out).size} bytes)`);