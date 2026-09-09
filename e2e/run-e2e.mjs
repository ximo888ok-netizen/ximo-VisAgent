// E2E 自动回归：主进程直调编排器提交任务，脚本按 taskId 精确归集终态与断言。
// 用法：node e2e/run-e2e.mjs [A|B|C|D|E|all] [--deny-approvals]
//
// 说明：
// - 任务在真实桌面上执行（会真的操作鼠标键盘），L2/L3 审批默认自动放行并计入报告；
//   加 --deny-approvals 可改为拒绝，用于验证「拒绝后任务不越权」。
// - 需要模型 API 已在应用设置中配置好；未配置时任务会以 LLM/配置错误失败，报告如实反映。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_TASKS } from './tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_MAIN = path.join(ROOT, 'apps', 'desktop', 'out', 'main', 'index.js');
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const args = process.argv.slice(2);
const denyApprovals = args.includes('--deny-approvals');
const only = args.find((a) => !a.startsWith('--')) ?? 'all';
const selected = only === 'all'
  ? E2E_TASKS
  : E2E_TASKS.filter((t) => t.id.toUpperCase() === String(only).toUpperCase());

if (selected.length === 0) {
  console.error(`[e2e] 没有 id 为 ${only} 的任务，可选：${E2E_TASKS.map((t) => t.id).join('/')}`);
  process.exit(2);
}
for (const [label, file] of [['out/main/index.js（先 pnpm build:desktop）', OUT_MAIN], ['electron.exe（先 pnpm install）', ELECTRON_BIN]]) {
  if (!fs.existsSync(file)) {
    console.error(`[e2e] 未找到 ${label}`);
    process.exit(2);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-visagent-e2e-'));
const planFile = path.join(workDir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({
  defaultTimeoutMs: 8 * 60_000,
  tasks: selected.map((t) => ({
    id: t.id,
    goal: t.goal,
    expectStatus: t.expectStatus ?? 'COMPLETED',
    mustHitTools: t.mustHitTools ?? [],
    timeoutMs: t.timeoutMs,
  })),
}), 'utf8');

const results = new Map();
let approvals = 0;
let child = null;

function handleEvent(obj) {
  if (obj.e2e === 'error') {
    console.error('[e2e] 主进程报错：', obj.message);
    return;
  }
  if (obj.e2e === 'ready') {
    console.log(`[e2e] 应用就绪，提交 ${obj.tasks} 个任务（真实桌面操作）`);
    return;
  }
  if (obj.e2e !== 'event') return;

  if (obj.kind === 'task_started') {
    console.log(`[e2e] → ${obj.id} 已提交：${String(obj.goal).slice(0, 60)}`);
    return;
  }
  if (obj.kind === 'approval_requested') {
    approvals++;
    const action = denyApprovals ? 'reject' : 'approve';
    console.log(`[e2e]   审批 ${obj.tool}（${obj.reason}）→ ${action === 'approve' ? '自动放行' : '脚本拒绝'}`);
    child?.stdin.write(`${JSON.stringify({ e2e: 'approval', approvalId: obj.approvalId, action })}\n`);
    return;
  }
  if (obj.kind === 'task_finished') {
    const ok = (obj.failures ?? []).length === 0;
    results.set(obj.id, { ...obj, ok });
    console.log(`[e2e] ${ok ? '✓' : '✕'} ${obj.id} ${obj.status}${ok ? '' : ` — ${obj.failures.join('; ')}`}`);
    return;
  }
  if (obj.e2e === 'done' || obj.kind === undefined) return;
}

function stdoutPump(stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        /* 非 JSON 行（Electron/Chromium 日志）忽略 */
      }
    }
  });
}

const globalTimeoutMs = (8 * 60_000 + 60_000) * selected.length;
console.log(`[e2e] 启动应用（总超时 ${Math.round(globalTimeoutMs / 60000)} 分钟）…`);
child = spawn(ELECTRON_BIN, [OUT_MAIN, '--e2e', `--e2e-plan=${planFile}`], {
  cwd: path.join(ROOT, 'apps', 'desktop'),
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
stdoutPump(child.stdout);
child.stderr.on('data', (d) => process.stderr.write(String(d)));

const finished = new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? 1));
  const timer = setTimeout(() => {
    console.error('[e2e] 全局超时，终止应用');
    child.kill();
    resolve(3);
  }, globalTimeoutMs);
  timer.unref();
});

const exitCode = await finished;
fs.rmSync(workDir, { recursive: true, force: true });

console.log('\n[e2e] ===== 结果汇总 =====');
let failed = exitCode === 3 ? 1 : 0;
for (const t of selected) {
  const r = results.get(t.id);
  if (!r) {
    failed++;
    console.log(`  ${t.id}: 未捕获终态 ✕ — ${t.name}`);
    continue;
  }
  if (!r.ok) failed++;
  console.log(`  ${t.id}: ${r.status} ${r.ok ? '✓' : '✕'} — ${t.name}`);
}
console.log(`  审批介入：${approvals} 次${denyApprovals ? '（拒绝）' : '（自动放行）'}`);
console.log(`\n[e2e] ${failed === 0 ? '全部通过' : `${failed} 项未通过`}（应用退出码 ${exitCode}）`);
process.exit(failed === 0 && exitCode === 0 ? 0 : 1);
