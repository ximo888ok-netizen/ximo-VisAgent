// 安装 Git 钩子：pnpm hooks:install
//
// 说明：本脚本会执行 `git config core.hooksPath .githooks`。这会修改你本机的
// git 配置，因此刻意不随 postinstall 自动运行 —— 需要开发者显式选择接入。
// 未安装钩子不影响 CI/verify，只是少了一道提交前的本地拦截。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOKS_DIR = path.join(ROOT, '.githooks');

if (!fs.existsSync(HOOKS_DIR)) {
  console.error('未找到 .githooks 目录');
  process.exit(1);
}
for (const hook of fs.readdirSync(HOOKS_DIR)) {
  fs.chmodSync(path.join(HOOKS_DIR, hook), 0o755);
}

const res = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'inherit' });
if (res.status !== 0) {
  console.error('设置 core.hooksPath 失败');
  process.exit(1);
}
console.log('已启用 .githooks：pre-commit 会跑 lint + budget + typecheck + test。');
console.log('紧急绕过（须在提交说明里写明原因）：git commit --no-verify');
