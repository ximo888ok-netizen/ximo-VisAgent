/**
 * dev-clean.mjs — 清理上次 dev 会话残留的本项目 electron 进程
 *
 * 背景：Windows 终端 Ctrl+C 不会终结 electron-vite 派生的 electron 进程树，
 * 残留实例会占住 dev 端口、全局热键与 GPU 磁盘缓存，导致下一次 dev 出现
 * 端口漂移、热键注册失败、双岛叠加（且单实例锁会被孤儿进程持住）。
 *
 * 判定规则：仅终止可执行文件位于本仓库目录内的 electron.exe
 * （pnpm 实际安装路径在 node_modules/.pnpm 下，同样位于仓库内）。
 * 其他应用与其他项目的进程绝不触碰；打包产物是独立 exe 名，也不会被误杀。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

// macOS/Linux 信号传播正常，无残留问题
if (process.platform !== 'win32') {
  process.exit(0);
}

function psQuote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

const rootPrefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
const script = [
  `$root = ${psQuote(rootPrefix)}`,
  `$targets = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {`,
  `  $p = $null; try { $p = $_.Path } catch {}`,
  `  $p -and $p.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)`,
  `}`,
  `$n = 0`,
  `if ($targets) { $n = @($targets).Count; $targets | Stop-Process -Force -ErrorAction SilentlyContinue }`,
  `Write-Output $n`,
].join('\n');

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const killed = Number.parseInt(out.trim(), 10) || 0;
  if (killed > 0) {
    console.log(`[dev-clean] 已清理上次 dev 残留的 electron 进程 x${killed}`);
  }
} catch {
  // 查询/清理失败不阻断 dev 启动
  process.exit(0);
}
