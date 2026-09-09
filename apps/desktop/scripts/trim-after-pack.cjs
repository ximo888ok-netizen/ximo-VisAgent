/**
 * trim-after-pack.cjs — electron-builder afterPack 钩子：裁剪安装产物
 *
 * 删的是三类运行时用不到的文件（删错一个都会让应用起不来，所以按白名单删而不是黑名单）：
 * 1. better-sqlite3 的 node-gyp 编译中间产物（.iobj/.ipdb/.lib/obj/deps 源码），
 *    运行时只有 bindings 定位 build/Release/better_sqlite3.node 这一个文件；
 * 2. koffi 的非 win32_x64 平台二进制（17 个目录，Linux/macOS/BSD 的 .node 在 Windows 上是死重）；
 * 3. 兜底删除 tailwindcss/lightningcss 原生模块（已在 devDependencies，正常不会进包；
 *    若依赖图变化再次混入，这里兜底，宁可装失败也不带废件）。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function trimAfterPack(context) {
  const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(unpacked)) return;

  // 1. better-sqlite3：Release 下只保留 better_sqlite3.node；deps/（sqlite3 源码）整个删
  const releaseDir = path.join(unpacked, 'better-sqlite3', 'build', 'Release');
  if (fs.existsSync(releaseDir)) {
    for (const name of fs.readdirSync(releaseDir)) {
      if (name !== 'better_sqlite3.node') {
        fs.rmSync(path.join(releaseDir, name), { recursive: true, force: true });
      }
    }
    console.log('[afterPack] better-sqlite3 中间产物已清理');
  }
  const depsDir = path.join(unpacked, 'better-sqlite3', 'deps');
  if (fs.existsSync(depsDir)) fs.rmSync(depsDir, { recursive: true, force: true });

  // 2. koffi：只留 win32_x64
  const koffiBuild = path.join(unpacked, 'koffi', 'build', 'koffi');
  if (fs.existsSync(koffiBuild)) {
    for (const name of fs.readdirSync(koffiBuild)) {
      if (name !== 'win32_x64') {
        fs.rmSync(path.join(koffiBuild, name), { recursive: true, force: true });
      }
    }
    console.log('[afterPack] koffi 非 win32_x64 平台二进制已清理');
  }

  // 3. 兜底：构建期专用原生模块（CSS 编译产物已在 out/renderer，运行时零引用）
  for (const pkg of ['lightningcss-win32-x64-msvc', 'lightningcss-win32-x64-msvc.node', '@tailwindcss']) {
    const p = path.join(unpacked, pkg);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[afterPack] 兜底删除 ${pkg}`);
    }
  }
};
