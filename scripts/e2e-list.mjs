// E2E 任务清单查看器：node scripts/e2e-list.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { E2E_TASKS } = await import(pathToFileURL(path.join(root, 'e2e', 'tasks.mjs')).href);

console.log('=== Desktop AGI E2E 基准任务（验收口径）===\n');
for (const t of E2E_TASKS) {
  console.log(`[${t.id}] ${t.name}（需 ${t.keyTag}）`);
  console.log(`  目标: ${t.goal}`);
  console.log(`  预期: ${t.expect}\n`);
}
console.log('执行方式：启动桌面应用 → 输入目标 → Agent 全链路执行 → 审计页回溯');