// diag-task-events.mjs — 只读：某任务全部事件 + 相邻时间间隔，定位 RUNNING 后为何无动作。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath = process.env.APPDATA ? path.join(base, 'ximo-VisAgent', 'audit.db') : path.join(base, 'ximo-VisAgent', 'audit.db');
const db = new DatabaseSync(process.argv[2] || path.join(base, 'ximo-VisAgent', 'audit.db'), { readOnly: true });
const tid = process.argv[3];
const like = tid ? tid : null;
const rows = like
  ? db.prepare('SELECT taskId FROM tasks WHERE taskId LIKE ? ORDER BY createdAt DESC LIMIT 1').all(like + '%')
  : db.prepare('SELECT taskId FROM tasks ORDER BY createdAt DESC LIMIT 1').all();
const taskId = rows[0]?.taskId;
if (!taskId) { console.error('no task'); process.exit(2); }
console.log('task =', taskId);
const t = db.prepare('SELECT status,steps,tokens,createdAt,finishedAt,failureKind FROM tasks WHERE taskId=?').get(taskId);
console.log('meta:', JSON.stringify(t));
const cols = db.prepare('PRAGMA table_info(audit)').all().map((c) => c.name);
console.log('audit cols:', cols.join(','));
const ev = db.prepare('SELECT seq,kind,timestamp,detail FROM audit WHERE taskId=? ORDER BY seq').all(taskId);
let prev = null;
for (const e of ev) {
  const gap = prev && e.timestamp ? Math.round((e.timestamp - prev) / 1000) : '';
  prev = e.timestamp;
  let d = typeof e.detail === 'string' ? e.detail : String(e.detail ?? '');
  console.log(`#${e.seq} +${gap}s ${e.kind}: ${d.slice(0, 120)}`);
}
console.log('total events:', ev.length);
