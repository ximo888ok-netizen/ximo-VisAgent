// 针对 Electron ABI 重编译原生模块（无需 @electron/rebuild）
// 用法: node scripts/rebuild-electron.js
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// M14 修复：APPDATA 未定义时回退；ELECTRON_VERSION 可从 package.json 读取
const ELECTRON_VERSION = process.env.ELECTRON_VERSION || '44.0.0';
const TARGETS = ['better-sqlite3'];

// 从 node_modules/.pnpm 查找模块真实路径（取版本最高）
function findInPnpm(root, pkg) {
  const walk = (dir, depth) => {
    if (depth > 5) return null;
    const pnpmDir = path.join(dir, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      try {
        const entries = fs.readdirSync(pnpmDir);
        let best = null;
        let bestVer = null;
        for (const e of entries) {
          if (!e.startsWith(pkg + '@')) continue;
          const modPath = path.join(pnpmDir, e, 'node_modules', pkg);
          if (fs.existsSync(modPath)) {
            const ver = e.slice(pkg.length + 1);
            if (!bestVer || ver.localeCompare(bestVer) > 0) {
              best = modPath;
              bestVer = ver;
            }
          }
        }
        if (best) return best;
      } catch { /* ignore */ }
    }
    const plain = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(path.join(plain, 'package.json'))) return plain;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    return walk(parent, depth + 1);
  };
  return walk(path.resolve(__dirname, '..'), 0);
}

let failed = 0;
for (const pkg of TARGETS) {
  const mod = findInPnpm(path.join('apps', 'desktop'), pkg) ?? findInPnpm('', pkg);
  if (!mod) {
    console.error(`[rebuild] 找不到 ${pkg}`);
    failed++;
    continue;
  }
  console.log(`[rebuild] ${pkg} @ ${mod}`);
  // 优先用全局 node-gyp（>=12 识别 VS2022/VS18），规避 electron-builder 内置 9.x
  const globalNodeGyp = path.join(process.env.APPDATA, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const gypJs = require('node:fs').existsSync(globalNodeGyp) ? globalNodeGyp : null;
  const cmd = gypJs ? 'node' : 'npx';
  const gypArgs = gypJs
    ? [gypJs, 'rebuild', `--target=${ELECTRON_VERSION}`, '--arch=x64', '--dist-url=https://electronjs.org/headers', '--runtime=electron']
    : ['node-gyp', 'rebuild', `--target=${ELECTRON_VERSION}`, '--arch=x64', '--dist-url=https://electronjs.org/headers', '--runtime=electron'];
  // M14 修复：shell: false 避免路径中空格被拆分；cmd + gypArgs 已是数组形式
  const r = spawnSync(cmd, gypArgs, { cwd: mod, encoding: 'utf8', shell: false, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[rebuild] ${pkg} 编译失败`);
    failed++;
  } else {
    console.log(`[rebuild] ${pkg} → electron ABI ${ELECTRON_VERSION} 编译成功`);
  }
}
process.exit(failed === 0 ? 0 : 1);