// agent-metrics.mjs — L8 回归门：从真实 audit.db 计算 Agent 电脑操作指标（非单测绿灯口径）。
// 用法：
//   node scripts/agent-metrics.mjs                 # 打印指标报告（含真 GUI 完成率/步数/坐标抖动/键盘占比）
//   node scripts/agent-metrics.mjs --gate          # 低于阈值则退出码 1（供回归门使用）
//   node scripts/agent-metrics.mjs --db=<path>      # 指定 audit.db（默认 %APPDATA%/ximo-VisAgent/audit.db）
// 口径（对齐 AGENTS §5「生产级不拿 mock 当真」与本仓教训「单测绿≠会用」）：
//   - 真 GUI 完成率 = COMPLETED / (COMPLETED + FAILED)，**排除** EMERGENCY_STOPPED/CANCELLED（用户手停不是能力失败）；
//   - 坐标抖动率 = 落在更早点击 ±60px 内的目测点击占比（越低越好，A2/A1/B1 直接压它）；
//   - 原地重复率 = 与紧邻一步完全同坐标的点击占比；键盘动作占比、UIA 动作占比；
//   - chat_reply 闲聊步不计入动作分布（不是"操作电脑"）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const gate = args.includes('--gate');
const asJson = args.includes('--json');

function defaultDb() {
  const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'ximo-VisAgent', 'audit.db');
}
const dbArg = args.find((a) => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.slice(5) : defaultDb();
if (!fs.existsSync(dbPath)) {
  console.error(`[metrics] 未找到 audit.db：${dbPath}（跑过真实任务后再来，或用 --db= 指定）`);
  process.exit(2);
}

// 阈值（可被 scripts/metrics-thresholds.json 覆盖；--gate 才据此判定）
const THRESHOLDS_PATH = path.join(process.cwd(), 'scripts', 'metrics-thresholds.json');
const thresholds = { minCompletionRate: 0.20, maxCoordJitterPct: 60, minKeyboardPct: 5, ...(fs.existsSync(THRESHOLDS_PATH) ? JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8')) : {}) };

const db = new DatabaseSync(dbPath, { readOnly: true });
const tasks = db.prepare("SELECT taskId, status, steps FROM tasks WHERE status IN ('COMPLETED','FAILED','EMERGENCY_STOPPED','CANCELLED')").all();
const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
const failedN = tasks.filter((t) => t.status === 'FAILED').length;
const stopped = tasks.filter((t) => t.status === 'EMERGENCY_STOPPED').length;
const cancelled = tasks.filter((t) => t.status === 'CANCELLED').length;
const terminal = completed + failedN;
const completionRate = terminal > 0 ? completed / terminal : 0;
const stepsArr = tasks.map((t) => t.steps).filter((n) => typeof n === 'number');
const avgSteps = stepsArr.length ? Math.round((stepsArr.reduce((a, b) => a + b, 0) / stepsArr.length) * 10) / 10 : 0;

// 逐步动作签名（仅统计有真实动作的终态任务：COMPLETED/FAILED/EMERGENCY_STOPPED）
function decode(s) { try { return typeof s === 'string' ? s : String(s); } catch { return ''; } }
const actionTasks = tasks.filter((t) => t.status !== 'CANCELLED').map((t) => t.taskId);
let mc = 0; let repeats = 0; let near = 0; let kb = 0; let uia = 0; let actions = 0; let chat = 0;
const clickPts = [];
const sel = db.prepare('SELECT detail FROM audit WHERE taskId = ? AND kind = \'step\' ORDER BY seq');
for (const tid of actionTasks) {
  clickPts.length = 0;
  let prevClick = null;
  for (const row of sel.all(tid)) {
    let o;
    try { o = JSON.parse(decode(row.detail)); } catch { continue; }
    const a = o.actionName;
    if (!a) continue;
    if (a === 'chat_reply') { chat++; continue; }
    actions++;
    if (a === 'keyboard_type' || a === 'keyboard_press') kb++;
    if (a === 'ui_click' || a === 'ui_locate' || a === 'ui_index') uia++;
    if (a === 'mouse_click') {
      const x = Number(o.args?.x), y = Number(o.args?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        mc++;
        if (prevClick && prevClick[0] === x && prevClick[1] === y) repeats++;
        if (clickPts.some(([px, py]) => Math.hypot(px - x, py - y) < 60)) near++;
        clickPts.push([x, y]);
        prevClick = [x, y];
      } else prevClick = null;
    }
  }
}
const coordJitterPct = mc > 0 ? Math.round((near / mc) * 100) : 0;
const repeatPct = mc > 0 ? Math.round((repeats / mc) * 100) : 0;
const keyboardPct = actions > 0 ? Math.round((kb / actions) * 100) : 0;
const uiaPct = actions > 0 ? Math.round((uia / actions) * 100) : 0;

const metrics = {
  tasks: { total: tasks.length, completed, failed: failedN, emergencyStopped: stopped, cancelled },
  completionRate: Math.round(completionRate * 1000) / 10,
  avgSteps,
  guiActions: actions,
  clicks: mc,
  coordJitterPct, repeatPct, keyboardPct, uiaPct,
  thresholds,
};

if (asJson) console.log(JSON.stringify(metrics));
else {
  console.log('\n[metrics] ===== ximo-VisAgent 真实电脑操作指标（audit.db）=====');
  console.log(`  任务：终态 ${tasks.length}（完成 ${completed} / 失败 ${failedN} / 急停 ${stopped} / 取消 ${cancelled}）`);
  console.log(`  真 GUI 完成率(完成/(完成+失败)，剔用户手停)：${metrics.completionRate}%   平均步数：${avgSteps}`);
  console.log(`  目测点击 ${mc} 次中：坐标抖动(±60px重瞄) ${coordJitterPct}%、原地重复 ${repeatPct}%`);
  console.log(`  动作 ${actions} 中：键盘 ${keyboardPct}%、UIA(ref/locate) ${uiaPct}%`);
  console.log(`  阈值：完成率≥${Math.round(thresholds.minCompletionRate * 100)}% 抖动≤${thresholds.maxCoordJitterPct}% 键盘≥${thresholds.minKeyboardPct}%`);
}

if (!gate) process.exit(0);
const breaches = [];
if (completionRate < thresholds.minCompletionRate) breaches.push(`完成率 ${metrics.completionRate}% < ${Math.round(thresholds.minCompletionRate * 100)}%`);
if (coordJitterPct > thresholds.maxCoordJitterPct) breaches.push(`坐标抖动 ${coordJitterPct}% > ${thresholds.maxCoordJitterPct}%`);
if (keyboardPct < thresholds.minKeyboardPct) breaches.push(`键盘占比 ${keyboardPct}% < ${thresholds.minKeyboardPct}%`);
if (breaches.length) {
  console.error('\n[metrics] ✕ 回归门未过：\n  - ' + breaches.join('\n  - '));
  process.exit(1);
}
console.log('\n[metrics] ✓ 回归门通过');
process.exit(0);
