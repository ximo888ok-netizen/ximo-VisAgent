// diag-last-tasks.mjs — 只读诊断：最近任务的终态 + 步骤/错误事件，判断"不动"卡在哪一环。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath = process.argv[2] || path.join(base, 'ximo-VisAgent', 'audit.db');
if (!fs.existsSync(dbPath)) { console.error('no db', dbPath); process.exit(2); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const tasks = db.prepare('SELECT taskId,goal,status,failureKind,steps,tokens,createdAt,finishedAt FROM tasks ORDER BY createdAt DESC LIMIT 6').all();
const dec = (s) => { try { return typeof s === 'string' ? s : String(s); } catch { return ''; } };
for (const t of tasks) {
  const age = t.createdAt ? Math.round((Date.now() - Number(t.createdAt)) / 60000) : '?';
  console.log(`\n=== task ${String(t.taskId).slice(0,8)}  ${age}min前  status=${t.status} failure=${t.failureKind ?? '-'} steps=${t.steps ?? '?'} tokens=${t.tokens ?? '?'} ===`);
  console.log(`goal: ${dec(t.goal).slice(0, 70)}`);
  const ev = db.prepare("SELECT kind,seq,detail FROM audit WHERE taskId=? AND kind IN ('step','error','status') ORDER BY seq LIMIT 14").all(t.taskId);
  if (!ev.length) { console.log('  (无任何 step/error/status 事件 —— 任务可能根本没进主循环)'); continue; }
  for (const e of ev) {
    let d = dec(e.detail);
    try { const o = JSON.parse(d); d = o.actionName ? `${o.actionName}(${JSON.stringify(o.args ?? {}).slice(0,40)}) → ${dec(o.resultSummary).slice(0,40)} ok=${o.ok}` : (o.message ?? o.status ?? d.slice(0,60)); } catch {}
    console.log(`  #${e.seq} ${e.kind}: ${d.slice(0, 90)}`);
  }
}
