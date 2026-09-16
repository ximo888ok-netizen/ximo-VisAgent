// E2E 任务清单查看器：node scripts/e2e-list.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { E2E_TASKS } = await import(pathToFileURL(path.join(root, 'e2e', 'tasks.mjs')).href);

console.log('=== ximo-VisAgent E2E 基准任务（验收口径）===\n');
for (const t of E2E_TASKS) {
  const track = t.track === 'real-gui' ? '真实GUI赛道' : '工具直写赛道（历史基线）';
  console.log(`[${t.id}] ${t.name}（${track}，需 ${t.keyTag}）`);
  console.log(`  目标: ${t.goal}`);
  console.log(`  预期: ${t.expect}`);
  if (t.mustHitTools?.length) console.log(`  必过动作: ${t.mustHitTools.join(' → ')}`);
  if (t.forbidTools?.length) console.log(`  禁止捷径: ${t.forbidTools.join('、')}`);
  const budget = `≤${t.maxSteps ?? '∞'} 步 / ≤${Math.round((t.timeoutMs ?? 480000) / 60000)} 分钟`;
  console.log(`  预算: ${budget}，断言 ${t.assertions?.length ?? 0} 条`);
  if (t.expectedFailure) console.log(`  ⚠ 预期失败（度量缺陷）: ${t.defectRef}`);
  console.log('');
}
console.log('执行方式：pnpm build:desktop && pnpm e2e [A|B|D|E|F|G|H|I|J|K|L|all]');
console.log('（需已在应用设置配置模型 API；F-L 为真实鼠标键盘赛道，禁止 file_write/excel_write_cell 等直写捷径，命中即判负）');