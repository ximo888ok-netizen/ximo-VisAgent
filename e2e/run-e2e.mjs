// E2E 自动回归：主进程直调编排器提交任务，脚本按 taskId 精确归集终态与断言。
// 用法：
//   node e2e/run-e2e.mjs --list            # 只列任务清单（无需构建产物、无需模型密钥）
//   node e2e/run-e2e.mjs [A|B|D|E|F|G|H|I|J|K|L|all] [--deny-approvals]
//
// 说明：
// - 任务在真实桌面上执行（会真的操作鼠标键盘），L2/L3 审批默认自动放行并计入报告；
//   加 --deny-approvals 可改为拒绝，用于验证「拒绝后任务不越权」。
// - 需要模型 API 已在应用设置中配置好；未配置时任务会以 LLM/配置错误失败，报告如实反映。
// - GUI 赛道（tasks.mjs 中 track='real-gui'）的 forbidTools/maxSteps/expectedFailure 判定都在本脚本实现：
//   主进程 runner（apps 侧）不支持执行期工具白名单，也不改它，所以「捷径」是事后按 toolsHit 判负、
//   「步数上限」是事后按 done 事件里的 steps 判负——都是判负而非拦截，goal 里的明文禁止是第一层约束。
// - fixtures/outputs：跑前重建输入文件、删除上次结果，保证断言不被历史残留满足。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E_TASKS } from './tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_MAIN = path.join(ROOT, 'apps', 'desktop', 'out', 'main', 'index.js');
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEFAULT_TIMEOUT_MS = 8 * 60_000;

const args = process.argv.slice(2);
const denyApprovals = args.includes('--deny-approvals');

if (args.includes('--list')) {
  for (const t of E2E_TASKS) {
    const track = t.track === 'real-gui' ? '真实GUI' : '工具直写';
    console.log(`[${t.id}] ${t.name}（${track}，需 ${t.keyTag}）`);
    console.log(`  目标: ${t.goal}`);
    console.log(`  预期: ${t.expect}`);
    if (t.mustHitTools?.length) console.log(`  必过动作: ${t.mustHitTools.join(' → ')}`);
    if (t.forbidTools?.length) console.log(`  禁止捷径: ${t.forbidTools.join('、')}（事后按 toolsHit 判负）`);
    console.log(`  预算: ≤${t.maxSteps ?? '不限'} 步 / ≤${Math.round((t.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)} 分钟 / 断言 ${t.assertions?.length ?? 0} 条`);
    if (t.expectedFailure) console.log(`  ⚠ 预期失败（${t.defectRef}）`);
    console.log('');
  }
  process.exit(0);
}

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

// ---------- 跑前清场与输入准备 ----------
const requireFromKit = createRequire(path.join(ROOT, 'packages', 'control-kit', 'index.ts'));

function makeSumWorkbook(file) {
  // exceljs 是 control-kit 的既有依赖，经其解析路径引入，不新增依赖。
  const ExcelJS = requireFromKit('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (let i = 1; i <= 10; i++) {
    ws.getCell(`A${i}`).value = i;
    ws.getCell(`B${i}`).value = i;
  }
  return wb.xlsx.writeFile(file);
}

async function prepareFixtures() {
  for (const t of selected) {
    for (const out of t.outputs ?? []) fs.rmSync(out, { force: true });
    for (const fx of t.fixtures ?? []) {
      fs.mkdirSync(path.dirname(fx.file), { recursive: true });
      if (fx.kind === 'text') fs.writeFileSync(fx.file, fx.content, 'utf8');
      else if (fx.kind === 'xlsx-sum10') await makeSumWorkbook(fx.file);
    }
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-visagent-e2e-'));
const planFile = path.join(workDir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  tasks: selected.map((t) => ({
    id: t.id,
    goal: t.goal,
    expectStatus: t.expectStatus ?? 'COMPLETED',
    mustHitTools: t.mustHitTools ?? [],
    assertions: t.assertions,
    timeoutMs: t.timeoutMs,
  })),
}), 'utf8');

const byId = new Map(selected.map((t) => [t.id, t]));
const results = new Map();
let approvals = 0;
let child = null;
let disturber = null;

function finishTask(obj) {
  const task = byId.get(obj.id);
  const failures = [...(obj.failures ?? [])];
  const toolsHit = obj.toolsHit ?? [];
  // 捷径判负：GUI 赛道声明的 forbidTools 一旦出现在轨迹里，即视为绕开真实 GUI，任务不成立。
  for (const bad of task?.forbidTools ?? []) {
    if (toolsHit.includes(bad)) failures.push(`走了禁止的捷径工具 ${bad}`);
  }
  const ok = failures.length === 0;
  results.set(obj.id, { ...obj, ok, failures });
  const head = ok ? '✓' : '✕';
  console.log(`[e2e] ${head} ${obj.id} ${obj.status}${ok ? '' : ` — ${failures.join('; ')}`}`);
}

function disturb() {
  // 干扰注入（任务 L）：弹计算器抢前台，考验看门狗/前台感知与恢复。结束后不代关，报告里提示。
  console.log('[e2e]   ⚡ 干扰注入：弹出计算器抢占前台（跑完请手动关闭）');
  disturber = spawn('cmd.exe', ['/c', 'start', '', 'calc'], { stdio: 'ignore', detached: true });
  disturber.unref();
}

function handleEvent(obj) {
  if (obj.e2e === 'error') {
    console.error('[e2e] 主进程报错：', obj.message);
    return;
  }
  if (obj.e2e === 'ready') {
    console.log(`[e2e] 应用就绪，提交 ${obj.tasks} 个任务（真实桌面操作）`);
    return;
  }
  if (obj.e2e === 'done') {
    // steps 只出现在 done 的 outcomes 里：maxSteps 在这里事后判负。
    for (const o of obj.outcomes ?? []) {
      const r = results.get(o.id);
      if (!r) continue;
      r.steps = o.steps;
      const max = byId.get(o.id)?.maxSteps;
      if (max && o.steps > max) {
        r.ok = false;
        r.failures.push(`步数 ${o.steps} 超过上限 ${max}`);
      }
    }
    return;
  }
  if (obj.kind === 'task_started') {
    console.log(`[e2e] → ${obj.id} 已提交：${String(obj.goal).slice(0, 60)}`);
    const t = byId.get(obj.id);
    if (t?.disturbAfterMs) setTimeout(() => disturb(), t.disturbAfterMs).unref();
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
    finishTask(obj);
    return;
  }
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

const perTaskMaxMs = Math.max(...selected.map((t) => t.timeoutMs ?? DEFAULT_TIMEOUT_MS));
const globalTimeoutMs = (perTaskMaxMs + 60_000) * selected.length;
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

await prepareFixtures();
const exitCode = await finished;
fs.rmSync(workDir, { recursive: true, force: true });

console.log('\n[e2e] ===== 结果汇总 =====');
let failed = exitCode === 3 ? 1 : 0;
let expectedMissed = 0;
for (const t of selected) {
  const r = results.get(t.id);
  const suffix = t.track === 'real-gui' ? '（GUI 赛道）' : '';
  if (!r) {
    if (t.expectedFailure) {
      console.log(`  ${t.id}: 未捕获终态 ✓ 预期失败 — ${t.name}${suffix}`);
      continue;
    }
    failed++;
    console.log(`  ${t.id}: 未捕获终态 ✕ — ${t.name}${suffix}`);
    continue;
  }
  if (t.expectedFailure) {
    if (r.ok) {
      expectedMissed++;
      console.log(`  ${t.id}: 意外通过 ⚠ — ${t.name}（缺陷 ${t.defectRef.split('：')[0]} 疑似已修复，请转正常任务）`);
    } else {
      console.log(`  ${t.id}: ${r.status} ✓ 预期失败（缺陷 ${t.defectRef.split('：')[0]}）：${r.failures.join('; ')}`);
    }
    continue;
  }
  if (!r.ok) failed++;
  console.log(`  ${t.id}: ${r.status} ${r.ok ? '✓' : '✕'}${r.steps ? ` ${r.steps}步` : ''} — ${t.name}${suffix}`);
}
console.log(`  审批介入：${approvals} 次${denyApprovals ? '（拒绝）' : '（自动放行）'}`);
const verdict = failed === 0 ? (expectedMissed > 0 ? `常规全过，但 ${expectedMissed} 个预期失败任务意外通过` : '全部通过') : `${failed} 项未通过`;
console.log(`\n[e2e] ${verdict}（应用退出码 ${exitCode}）`);
process.exit(failed === 0 && exitCode === 0 ? 0 : 1);
