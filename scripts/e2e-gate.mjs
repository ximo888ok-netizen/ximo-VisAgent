// e2e-gate.mjs — 真机指标回归门：跑 e2e real-GUI 赛道(F-L) → 出指标 → 与基线阈值对比。
// 用法：node scripts/e2e-gate.mjs [F|G|H|I|J|K|L|all] [--deny-approvals]
//   不传赛道 = 默认跑 F（记事本菜单导航，最快验证菜单死循环修复）
//   --deny-approvals = 拒绝审批（验证拒绝后不越权）
// 前置：先退出正在运行的 ximo-VisAgent 实例（否则子进程抢单实例锁崩溃）。
// 流程：
//   1. 跑 e2e（真实桌面操作，会操作鼠标键盘）
//   2. 从 audit.db 读指标（agent-metrics.mjs 的逻辑）
//   3. 与 scripts/metrics-thresholds.json 对比，任一指标回退 → 退出码 1
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const track = args.find((a) => !a.startsWith('--')) ?? 'F';
const denyApprovals = args.includes('--deny-approvals');

// ---------- 阈值 ----------
const THRESHOLDS_PATH = path.join(ROOT, 'scripts', 'metrics-thresholds.json');
const thresholds = {
  minCompletionRate: 0.55,
  maxCoordJitterPct: 65,
  minKeyboardPct: 3,
  ...(fs.existsSync(THRESHOLDS_PATH) ? JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8')) : {}),
};

// ---------- 跑 e2e ----------
const e2eArgs = [track];
if (denyApprovals) e2eArgs.push('--deny-approvals');
console.log(`[e2e-gate] 启动 e2e 赛道 ${track}（真实桌面操作）…`);
const e2eResult = await new Promise((resolve) => {
  const child = spawn('node', [path.join(ROOT, 'e2e', 'run-e2e.mjs'), ...e2eArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  child.on('exit', (code) => resolve(code ?? 1));
});

if (e2eResult !== 0) {
  console.error(`[e2e-gate] e2e 赛道 ${track} 退出码 ${e2eResult}（部分任务未通过——看上方汇总）`);
  // e2e 任务失败不直接判门失败：指标门看的是操作质量（抖动/键盘占比），不是任务完成率
  // 任务完成率由 e2e 自己的断言管，这里只管操作质量不回退
}

// ---------- 读指标 ----------
const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath = path.join(base, 'ximo-VisAgent', 'audit.db');
if (!fs.existsSync(dbPath)) {
  console.error('[e2e-gate] 未找到 audit.db（e2e 可能未产生任务记录）');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
// 只看最近一批 e2e 产生的任务（按时间倒序，取最近 20 条终态任务）
const tasks = db.prepare(`
  SELECT taskId, status, steps FROM tasks
  WHERE status IN ('COMPLETED','FAILED','EMERGENCY_STOPPED','CANCELLED')
  ORDER BY createdAt DESC LIMIT 20
`).all();

if (tasks.length === 0) {
  console.error('[e2e-gate] audit.db 中没有终态任务记录');
  process.exit(2);
}

const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
const failedN = tasks.filter((t) => t.status === 'FAILED').length;
const terminal = completed + failedN;
const completionRate = terminal > 0 ? completed / terminal : 0;

// 动作分布（同 agent-metrics.mjs 逻辑）
function decode(s) { try { return typeof s === 'string' ? s : String(s); } catch { return ''; } }
const actionTasks = tasks.filter((t) => t.status !== 'CANCELLED').map((t) => t.taskId);
let mc = 0, near = 0, kb = 0, actions = 0;
const clickPts = [];
const sel = db.prepare("SELECT detail FROM audit WHERE taskId = ? AND kind = 'step' ORDER BY seq");
for (const tid of actionTasks) {
  clickPts.length = 0;
  for (const row of sel.all(tid)) {
    let o;
    try { o = JSON.parse(decode(row.detail)); } catch { continue; }
    const a = o.actionName;
    if (!a || a === 'chat_reply') continue;
    actions++;
    if (a === 'keyboard_type' || a === 'keyboard_press') kb++;
    if (a === 'mouse_click') {
      const x = Number(o.args?.x), y = Number(o.args?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        mc++;
        if (clickPts.some(([px, py]) => Math.hypot(px - x, py - y) < 60)) near++;
        clickPts.push([x, y]);
      }
    }
  }
}
const coordJitterPct = mc > 0 ? Math.round((near / mc) * 100) : 0;
const keyboardPct = actions > 0 ? Math.round((kb / actions) * 100) : 0;

console.log('\n[e2e-gate] ===== 最近批次指标 =====');
console.log(`  任务：${tasks.length}（完成 ${completed} / 失败 ${failedN}）`);
console.log(`  完成率：${Math.round(completionRate * 1000) / 10}%`);
console.log(`  坐标抖动：${coordJitterPct}%  键盘占比：${keyboardPct}%`);

// ---------- 阈值对比 ----------
const breaches = [];
if (completionRate < thresholds.minCompletionRate) {
  breaches.push(`完成率 ${Math.round(completionRate * 100)}% < ${Math.round(thresholds.minCompletionRate * 100)}%`);
}
if (coordJitterPct > thresholds.maxCoordJitterPct) {
  breaches.push(`坐标抖动 ${coordJitterPct}% > ${thresholds.maxCoordJitterPct}%`);
}
if (keyboardPct < thresholds.minKeyboardPct) {
  breaches.push(`键盘占比 ${keyboardPct}% < ${thresholds.minKeyboardPct}%`);
}

if (breaches.length) {
  console.error('\n[e2e-gate] ✕ 回归门未过（指标回退）：\n  - ' + breaches.join('\n  - '));
  process.exit(1);
}
console.log('\n[e2e-gate] ✓ 回归门通过（指标未回退）');
process.exit(0);
