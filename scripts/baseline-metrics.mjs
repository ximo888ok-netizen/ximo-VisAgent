// baseline-metrics.mjs — 从真实审计库 audit.db 统计任务完成率基线（只读，不写任何东西）。
// 背景：TEST_REPORT.md 全绿 ≠ 真实可用。tasks 表记录的是用户/自测跑出来的终态：
// COMPLETED / EMERGENCY_STOPPED（人工急停）/ FAILED / CANCELLED / RUNNING。
// 本脚本量化「改前基线」：状态占比、步数/token 画像、失败原因、同坐标重复点击、
// 审批分布、以及「模型未输出工具调用」错误计数。
// 运行：node scripts/baseline-metrics.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPDATA = process.env.APPDATA;
if (!APPDATA) {
  console.log('[baseline] 未找到环境变量 APPDATA（当前平台可能非 Windows），无法定位 audit.db。');
  process.exit(0);
}
const dbPath = path.join(APPDATA, 'ximo-VisAgent', 'audit.db');
if (!fs.existsSync(dbPath)) {
  console.log(`[baseline] 未找到审计库：${dbPath}`);
  console.log('[baseline] 请先在应用里真实跑过若干任务（本脚本只读、不建库）。');
  process.exit(0);
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  console.log(`[baseline] 以只读方式打开失败：${dbPath}`);
  console.log(`[baseline] 原因：${err instanceof Error ? err.message : String(err)}（若应用正在写入可稍后重试）`);
  process.exit(0);
}

const row = (sql, ...params) => db.prepare(sql).all(...params);

const num = (v) => (typeof v === 'number' && Number.isFinite(v));

function parseDetail(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function pct(c, total) {
  return total === 0 ? '' : `（${((c / total) * 100).toFixed(1)}%）`;
}

const fmt = (v, digits = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(digits));

console.log('===== ximo-VisAgent 真实任务基线（audit.db 只读统计）=====');
console.log(`库路径: ${dbPath}\n`);

// ---------- 1. 任务总数与各状态占比 ----------
const statusRows = row('select status, count(*) c from tasks group by status order by c desc');
const total = statusRows.reduce((s, r) => s + r.c, 0);
console.log(`【任务总数】${total}`);
for (const r of statusRows) console.log(`  ${r.status}: ${r.c} ${pct(r.c, total)}`);

// ---------- 2. 平均/中位步数（仅记录到步数的任务） ----------
const stepVals = row('select steps from tasks where steps is not null').map((r) => r.steps).filter(num);
console.log(`\n【步数画像】样本 ${stepVals.length} 个任务`);
console.log(`  平均步数: ${stepVals.length ? fmt(stepVals.reduce((s, v) => s + v, 0) / stepVals.length) : '-'}，中位步数: ${stepVals.length ? fmt(median(stepVals)) : '-'}`);

// ---------- 3. 按状态的平均步数与 token ----------
const perStatus = row(`
  select status,
         count(*) c,
         avg(steps) avgSteps,
         avg(tokens) avgTokens
  from tasks group by status order by c desc
`);
console.log('\n【按状态】平均步数 / 平均 token');
for (const r of perStatus) {
  console.log(`  ${r.status.padEnd(18)} n=${String(r.c).padStart(3)}  步数 ${fmt(r.avgSteps)}  token ${fmt(r.avgTokens, 0)}`);
}

// ---------- 4. 失败原因分布 ----------
const failKinds = row(`
  select coalesce(failureKind, '(空)') k, count(*) c
  from tasks where status in ('FAILED', 'EMERGENCY_STOPPED', 'CANCELLED')
  group by failureKind order by c desc
`);
console.log(`\n【失败/中止原因分布】（tasks.failureKind，共 ${failKinds.reduce((s, r) => s + r.c, 0)} 条）`);
for (const r of failKinds) console.log(`  ${r.k}: ${r.c}`);

const errMessages = row("select detail from audit where kind = 'error'");
const errCounts = new Map();
for (const e of errMessages) {
  const d = parseDetail(e.detail);
  const msg = d && typeof d.message === 'string' ? d.message : '(无法解析)';
  errCounts.set(msg, (errCounts.get(msg) ?? 0) + 1);
}
console.log(`【审计 error 消息分布】（audit kind=error，共 ${errMessages.length} 条）`);
for (const [msg, c] of [...errCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${msg}: ${c}`);

// ---------- 5. 同一任务内同坐标重复点击 top10 ----------
// 卡死信号：模型对着同一坐标反复点（EfficiencyGuard 停滞闸的前兆），是急停的主要来源之一。
const goals = new Map(row('select taskId, goal from tasks').map((t) => [t.taskId, t.goal]));
const clickKey = new Map();
const stepRows = row("select taskId, detail from audit where kind = 'step'");
for (const s of stepRows) {
  const d = parseDetail(s.detail);
  if (!d || d.actionName !== 'mouse_click') continue;
  const args = d.args;
  if (!args || !num(args.x) || !num(args.y)) continue;
  const key = `${s.taskId}@@${args.x},${args.y}`;
  clickKey.set(key, (clickKey.get(key) ?? 0) + 1);
}
const repeats = [...clickKey.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('\n【同任务同坐标重复点击 Top10】(mouse_click x,y 相同且 ≥2 次)');
if (repeats.length === 0) console.log('  （无重复点击记录）');
for (const [key, c] of repeats) {
  const [taskId, xy] = key.split('@@');
  const goal = String(goals.get(taskId) ?? '(任务已不在表)').replace(/\s+/g, ' ').slice(0, 40);
  console.log(`  ${c} 次 @(${xy})  [${taskId.slice(0, 8)}] ${goal}`);
}

// ---------- 6. 审批 approve/edit/reject 分布 ----------
const approvalResult = row("select detail from audit where kind = 'approval_result'");
const approvalDecided = row("select detail from audit where kind = 'approval_decided'");
const decideCounts = new Map();
for (const a of approvalResult) {
  const d = parseDetail(a.detail);
  const dec = d && typeof d.decision === 'string' ? d.decision : '(未知)';
  decideCounts.set(dec, (decideCounts.get(dec) ?? 0) + 1);
}
console.log('\n【审批决策分布】');
console.log(`  approval_result 记录 ${approvalResult.length} 条，approval_decided 记录 ${approvalDecided.length} 条`);
for (const [dec, c] of [...decideCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${dec}: ${c}`);
const decidedEdits = approvalDecided.filter((a) => {
  const d = parseDetail(a.detail);
  return d && d.decision && typeof d.decision.action === 'string' ? d.decision.action !== 'approve' : false;
}).length;
if (approvalDecided.length > 0) console.log(`  approval_decided 中非 approve（edit/reject 等）: ${decidedEdits} / ${approvalDecided.length}`);

// ---------- 7. 「模型未输出工具调用」错误计数 ----------
const noToolCall = row("select count(*) c from audit where kind = 'error' and detail like '%模型未输出工具调用%'")[0].c;
console.log(`\n【「模型未输出工具调用」错误】${noToolCall} 次`);
console.log('\n===== 基线统计结束 =====');
process.exit(0);
