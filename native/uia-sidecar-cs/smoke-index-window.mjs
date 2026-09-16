// smoke-index-window.mjs — 真机冒烟（Windows 桌面会话内运行）：直调侧车新动作
//   ① indexWindow(pid=notepad) / indexWindow(pid=explorer) → 元素数、patterns 覆盖率、耗时
//   ② indexWindow(hwnd=…) 单窗口模式
//   ③ resolveRefs：按已索引 runtimeId 重解析 + 伪造 id 必须 ok:false（"缓存不能骗人"）
//   ④ 自我污染防线：同一进程 pid 进 excludePids 后，其窗口必须从 getUiTree 消失（灵动岛同机制）
// 用法: node native/uia-sidecar-cs/smoke-index-window.mjs   （失败退出码 1）
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, 'bin', 'uia-sidecar.exe');

// ---------- 极简 NDJSON JSON-RPC 客户端（冒烟专用，不进产品代码） ----------
const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
proc.stdout.setEncoding('utf8');
let buf = '';
let nextId = 1;
const pending = new Map();
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim().replace(/^\uFEFF/, '');
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
function rpc(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  const line = JSON.stringify({ id, method, ...params });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); } });
    proc.stdin.write(line + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fails.push(name);
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

/** 统计一份 indexWindow 结果的元素数 / invoke 覆盖率 / patterns 覆盖 */
function stats(res) {
  const els = (res.windows ?? []).flatMap((w) => w.elements ?? []);
  const n = els.length;
  const pct = (c) => (n ? `${((c / n) * 100).toFixed(0)}%` : '0%');
  const count = (f) => els.filter(f).length;
  return {
    n,
    truncated: res.truncated,
    sidecarMs: res.ms,
    sig: String(res.signature ?? '').slice(0, 12),
    invoke: count((e) => e.patterns?.invoke),
    toggle: count((e) => e.patterns?.toggle),
    value: count((e) => typeof e.patterns?.value === 'string' && e.patterns.value.length > 0),
    selectionItem: count((e) => e.patterns?.selectionItem),
    scroll: count((e) => e.patterns?.scroll),
    hasRect: count((e) => e.rect),
    pctInvoke: pct(count((e) => e.patterns?.invoke)),
  };
}
function printStats(label, s, wallMs) {
  console.log(`  ${label}: 元素=${s.n} truncated=${s.truncated} 侧车耗时=${s.sidecarMs}ms 端到端=${wallMs}ms signature=${s.sig}…`);
  console.log(`    patterns 覆盖: invoke=${s.invoke}(${s.pctInvoke}) toggle=${s.toggle} value=${s.value} selectionItem=${s.selectionItem} scroll=${s.scroll} 有矩形=${s.hasRect}`);
}

// ---------- 启动 ----------
const health = await rpc('health', {});
if (!health?.ok) { console.error('sidecar 不健康', health); process.exit(1); }
console.log('sidecar 在线\n');

// ---------- ① notepad（pid 模式） ----------
console.log('① indexWindow(pid) — 记事本');
const tmpFile = path.join(os.tmpdir(), `uia-smoke-${Date.now()}.txt`);
fs.writeFileSync(tmpFile, 'hello uia index smoke\n');
const notepad = spawn('notepad.exe', [tmpFile], { stdio: 'ignore', detached: false });
let noteIdx = null;
let wall = 0;
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  const r = await rpc('indexWindow', { pid: notepad.pid, excludePids: [] });
  wall = Date.now() - t0;
  if (r?.ok && (r.windows?.length ?? 0) > 0) { noteIdx = r; break; }
  await sleep(400);
}
if (!noteIdx) { console.error('记事本窗口未出现，冒烟中止'); notepad.kill(); process.exit(1); }
printStats('pid 模式', stats(noteIdx), wall);
check('记事本至少 1 窗口', (noteIdx.windows?.length ?? 0) >= 1, `windows=${noteIdx.windows.length}`);
check('记事本元素数 > 10', stats(noteIdx).n > 10, String(stats(noteIdx).n));
check('存在 invoke=true 元素', stats(noteIdx).invoke > 0, `invoke=${stats(noteIdx).invoke}`);
if (wall > 300) console.log(`  [note] 首次调用 ${wall}ms = UIA 冷连接成本（每提供方一次），性能红线在 ③ 热路径断言`);
check('目标 pid 正确', noteIdx.windows.every((w) => w.pid === notepad.pid));
check('元素含 path 可读路径', (noteIdx.windows[0].elements.find((e) => e.path?.includes('/')) ?? null) !== null);
const noteHwnd = noteIdx.windows[0].hwnd;

// ---------- ② explorer（pid 模式，真实大型树 + 多窗口枚举） ----------
console.log('\n② indexWindow(pid) — 资源管理器（Shell_TrayWnd/桌面/任意文件夹窗口）');
const explorerPid = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process explorer | Select-Object -First 1).Id'], { encoding: 'utf8' }).trim());
const t1 = Date.now();
const expIdx = await rpc('indexWindow', { pid: explorerPid, maxNodes: 800, excludePids: [] });
const wallExp = Date.now() - t1;
if (!expIdx?.ok) { console.error('explorer 索引失败', expIdx); }
else {
  printStats('pid 模式', stats(expIdx), wallExp);
  check('explorer 顶层窗口枚举 ≥ 1', (expIdx.windows?.length ?? 0) >= 1, `windows=${expIdx.windows.length}`);
  check('explorer 元素数 > 20', stats(expIdx).n > 20, String(stats(expIdx).n));
  check('explorer invoke 覆盖 > 0', stats(expIdx).invoke > 0, `invoke=${stats(expIdx).invoke}`);
  const t1b = Date.now();
  const expWarm = await rpc('indexWindow', { pid: explorerPid, maxNodes: 800, excludePids: [] });
  const wallExpWarm = Date.now() - t1b;
  printStats('pid 模式（热）', stats(expWarm), wallExpWarm);
  const winCount = expWarm.windows.length;
  check(`explorer 多窗口整体热路径 < 2000ms（${winCount} 窗口/次调用）`, wallExpWarm < 2000,
    `${wallExpWarm}ms ≈ ${Math.round(wallExpWarm / winCount)}ms/窗口（300ms 目标针对单窗口，见 ③）`);
}

// ---------- ③ hwnd 单窗口模式 ----------
console.log('\n③ indexWindow(hwnd) — 记事本单窗口');
const t2 = Date.now();
const byHwnd = await rpc('indexWindow', { hwnd: noteHwnd, excludePids: [] });
const wallHwnd = Date.now() - t2;
printStats('hwnd 模式', stats(byHwnd), wallHwnd);
check('hwnd 模式 ok', byHwnd?.ok === true);
check('热路径单次 indexWindow < 300ms', wallHwnd < 300, `${wallHwnd}ms`);
check('hwnd 模式仅 1 窗口', (byHwnd.windows?.length ?? 0) === 1);
check('hwnd 相等', byHwnd.windows?.[0]?.hwnd === noteHwnd);

// ---------- ④ resolveRefs ----------
console.log('\n④ resolveRefs — 执行前重解析');
const noteEls = noteIdx.windows[0].elements.filter((e) => e.rect).slice(0, 3);
const items = [
  ...noteEls.map((e) => ({ hwnd: noteHwnd, runtimeId: e.runtimeId })),
  { hwnd: noteHwnd, runtimeId: '999999999,999999999' }, // 伪造 → 必须 ok:false
  { runtimeId: noteEls[0]?.runtimeId },                  // 无 hwnd（走索引时记录的来源窗口/缓存路径）
];
const t3 = Date.now();
const rr = await rpc('resolveRefs', { items });
const wallRr = Date.now() - t3;
check('resolveRefs 帧 ok', rr?.ok === true, JSON.stringify(rr?.error ?? ''));
check('resolveRefs 快速返回（无全桌面扫描）', wallRr < 5000, `${wallRr}ms`);
const got = rr?.resolved ?? [];
for (let i = 0; i < noteEls.length; i++) {
  check(`项 ${i} 重解析成功且矩形一致`,
    got[i]?.ok === true && Math.round(got[i]?.rect?.x ?? -1) === Math.round(noteEls[i].rect.x),
    `rect=${JSON.stringify(got[i]?.rect)}`);
}
check('伪造 runtimeId → ok:false', got[noteEls.length]?.ok === false);
check('无 hwnd 项也能解析', got[noteEls.length + 1]?.ok === true);

// ---------- ⑤ 自我污染防线（excludePids 端到端证明） ----------
console.log('\n⑤ 自我污染防线 — excludePids 生效性（与灵动岛排除同机制）');
const uniq = path.basename(tmpFile, '.txt');
const tree1 = await rpc('getUiTree', { params: { maxDepth: 4, maxNodes: 1500 } });
const t1s = JSON.stringify(tree1.tree ?? {});
check(`未排除时树含记事本窗口(${uniq})`, t1s.includes(uniq));
const tree2 = await rpc('getUiTree', { params: { maxDepth: 4, maxNodes: 1500, excludePids: [notepad.pid] } });
const t2s = JSON.stringify(tree2.tree ?? {});
check('排除后记事本窗口从树消失', !t2s.includes(uniq));
check('排除不影响其余节点', (tree2.total ?? 0) > 10, `total=${tree2.total}`);
const idx = await rpc('indexWindow', { pid: notepad.pid, excludePids: [notepad.pid] });
check('indexWindow 排除目标 pid 时拒绝索引', idx?.ok === false, `error=${idx?.error}`);

// ---------- 收尾 ----------
notepad.stdin?.end?.();
execFileSync('cmd', ['/c', 'taskkill', '/PID', String(notepad.pid), '/F'], { stdio: 'ignore' });
try { fs.unlinkSync(tmpFile); } catch { /* 临时文件删不掉不影响结论 */ }
proc.stdin.end();
await sleep(200);
proc.kill();

console.log(`\n=== 冒烟结果: ${fails.length === 0 ? '全部 PASS' : `FAIL x${fails.length}: ${fails.join(', ')}`} ===`);
process.exit(fails.length === 0 ? 0 : 1);
