/**
 * foreground-proc.ts — 前台窗口 → 进程判定（A-M3 看门狗的高频轻查层）
 *
 * 分层口诀（规划 Q3 定论）：看门狗 1s 级轮询要的是 <5ms 的本地 FFI，因此 pid→exe
 * 走主进程 koffi，**不走** C# 侧车（低频批量枚举/图标才走侧车，见 app-catalog-client.ts）。
 *
 * 绑定的入口全部无句柄残留（OpenProcess / CreateToolhelp32Snapshot 的句柄在每个分支都 CloseHandle）：
 *   user32   GetForegroundWindow / GetWindowThreadProcessId / GetClassNameW / GetAncestor
 *   kernel32 OpenProcess + QueryFullProcessImageNameW + CloseHandle（pid → exe 全路径）
 *   kernel32 CreateToolhelp32Snapshot + Process32{First,Next}W（全量 pid→basename + 父链）
 *
 * 判定细则（规划 §6「看门狗误停」风险行）：
 *   · 目标进程族任一窗口在前台即算「未离开」——族 = procFamily basename 小写集合；
 *   · 同进程族算 ✓：Toolhelp 父链向上走 ≤ PROC_FAMILY_DEPTH 跳（子进程/内嵌宿主天然命中）；
 *   · 标准文件对话框 #32770 属目标进程天然豁免 ✓（同 pid 时族判定已覆盖；被别的进程托管时用
 *     GA_ROOTOWNER 回溯属主窗口 pid 再判一次）；
 *   · 真跨进程离开（切去微信/浏览器）不在这里表态，交给 anchor-watchdog 状态机 → PAUSED。
 *
 * 非 Windows / FFI 不可用时查询返回 null / 空表，由调用方（host）按「样本不可用」跳过本轮，
 * 绝不当成「已离开」。绑定懒初始化并记忆失败，避免 import 期炸主进程。
 */
import koffi from 'koffi';

/**
 * PROCESSENTRY32W 布局常量。⚠ 与 SDK 头文件字面推算（560 / parent@28 / exe@40）不同：
 * 真机 Win11 x64 实测 dwSize 必须 = 568，否则 Process32FirstW 直接 FALSE（GetLastError=24
 * ERROR_BAD_LENGTH）→ 快照恒空 → 看门狗会误判「已离开」。字段偏移同样按真机回读校正
 * （pid / parentPid / szExeFile 三处已用 Win32_Process 的 ParentProcessId 交叉核对）。
 */
const PE_SIZE = 568;
const PE_OFF_PID = 8;
const PE_OFF_PARENT = 32;
const PE_OFF_EXE = 44;
const PE_EXE_CHARS = 260;

const TH32CS_SNAPPROCESS = 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GA_ROOTOWNER = 3;
/** 通用控件对话框（含文件对话框）的窗口类 —— 天然豁免 */
const DIALOG_CLASS = '#32770';
/** 进程族父链回溯深度（含自身） */
const PROC_FAMILY_DEPTH = 3;
/** 单次采样内共享快照的时间窗（一个 tick 只扫一次全量表） */
const SNAPSHOT_TTL_MS = 250;
/** 快照条目上限（防御异常系统把主进程拖死） */
const SNAPSHOT_MAX_ENTRIES = 4096;

export interface ForegroundProc {
  hwnd: number;
  pid: number;
  /** exe 全路径（读不到名字时为空串） */
  exePath: string;
  /** exe 基名小写，进程族匹配用 */
  basename: string;
  /** 前台窗口类名（#32770 豁免判定用） */
  className: string;
}

export interface ProcSnapshotEntry {
  pid: number;
  parentPid: number;
  basename: string;
}

/** 一次采样结论：前台是否属于目标进程族 + 进程族是否仍存活 */
export interface ForegroundSample {
  foregroundInFamily: boolean;
  familyAlive: boolean;
}

/** 看门狗宿主注入的探针（单测替身化） */
export interface ForegroundProbe {
  sample(): ForegroundSample;
}

interface Bindings {
  foregroundWindow: () => bigint;
  windowThreadPid: (hwnd: number, out: Buffer) => number;
  classNameW: (hwnd: number, out: Buffer, maxCount: number) => number;
  ancestor: (hwnd: number, gaFlags: number) => bigint;
  openProcess: (access: number, inherit: boolean, pid: number) => bigint;
  queryImageName: (handle: bigint, flags: number, name: Buffer, size: Buffer) => boolean;
  closeHandle: (handle: bigint) => boolean;
  createSnapshot: (flags: number, pid: number) => bigint;
  processFirst: (snapshot: bigint, entry: Buffer) => boolean;
  processNext: (snapshot: bigint, entry: Buffer) => boolean;
}

let bound: Bindings | null = null;
let bindFailed = false;

function bindings(): Bindings | null {
  if (bound) return bound;
  if (bindFailed) return null;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    bound = {
      foregroundWindow: user32.func('int64 GetForegroundWindow()'),
      windowThreadPid: user32.func('uint32 GetWindowThreadProcessId(int64 hwnd, _Out_ uint32* pid)'),
      classNameW: user32.func('int32 GetClassNameW(int64 hwnd, _Out_ char* out, int32 maxCount)'),
      ancestor: user32.func('int64 GetAncestor(int64 hwnd, uint32 gaFlags)'),
      openProcess: kernel32.func('int64 OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      queryImageName: kernel32.func(
        'bool QueryFullProcessImageNameW(int64 hProcess, uint32 flags, _Out_ char* name, _Inout_ uint32* size)',
      ),
      closeHandle: kernel32.func('bool CloseHandle(int64 h)'),
      createSnapshot: kernel32.func('int64 CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
      processFirst: kernel32.func('bool Process32FirstW(int64 snap, void* entry)'),
      processNext: kernel32.func('bool Process32NextW(int64 snap, void* entry)'),
    };
  } catch (err) {
    bindFailed = true;
    console.warn('[foreground-proc] FFI 绑定失败，前台查询降级为不可用:', err instanceof Error ? err.message : err);
  }
  return bound;
}

function basenameOf(exePath: string): string {
  return (exePath.split(/[\\/]/).filter(Boolean).pop() ?? '').toLowerCase();
}

function readWString(buf: Buffer, byteOffset: number, maxChars: number): string {
  const slice = buf.subarray(byteOffset, byteOffset + maxChars * 2).toString('utf16le');
  const nul = slice.indexOf('\0');
  return (nul >= 0 ? slice.slice(0, nul) : slice).trim();
}

/** 目标应用 → 进程族 basename 小写集合（procFamily 缺省时由 exePath basename 推出） */
export function familyBasenamesOf(app: { exePath?: string; procFamily?: string[] }): string[] {
  const fromFamily = (app.procFamily ?? []).map((b) => String(b ?? '').trim().toLowerCase()).filter(Boolean);
  const fromPath = basenameOf(app.exePath ?? '');
  return [...new Set(fromPath ? [...fromFamily, fromPath] : fromFamily)];
}

function windowClassName(b: Bindings, hwnd: number): string {
  if (!hwnd) return '';
  const buf = Buffer.alloc(PE_EXE_CHARS * 2);
  const n = b.classNameW(hwnd, buf, PE_EXE_CHARS);
  return n > 0 ? buf.subarray(0, n * 2).toString('utf16le').replace(/\0+$/, '') : '';
}

function windowPid(b: Bindings, hwnd: number): number {
  if (!hwnd) return 0;
  const out = Buffer.alloc(4);
  return b.windowThreadPid(hwnd, out) ? out.readUInt32LE(0) : 0;
}

/** pid → exe 全路径（PROCESS_QUERY_LIMITED_INFORMATION 足够读名；失败回 null，句柄必关） */
export function getProcExePath(pid: number): string | null {
  const b = bindings();
  if (!b || !pid) return null;
  const handle = b.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return null;
  try {
    const name = Buffer.alloc(PE_EXE_CHARS * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(PE_EXE_CHARS, 0);
    if (!b.queryImageName(handle, 0, name, size)) return null;
    const chars = size.readUInt32LE(0);
    if (chars <= 0) return null;
    return name.subarray(0, chars * 2).toString('utf16le').replace(/\0+$/, '') || null;
  } finally {
    b.closeHandle(handle);
  }
}

let cachedSnapshot: { at: number; entries: ProcSnapshotEntry[] } | null = null;

/** 全量进程快照（pid / basename / 父 pid），SNAPSHOT_TTL_MS 内复用同一次扫描 */
function snapshotProcs(b: Bindings): ProcSnapshotEntry[] {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.at < SNAPSHOT_TTL_MS) return cachedSnapshot.entries;
  const entries: ProcSnapshotEntry[] = [];
  const snap = b.createSnapshot(TH32CS_SNAPPROCESS, 0);
  if (snap && snap !== -1n) {
    try {
      const entry = Buffer.alloc(PE_SIZE);
      entry.writeUInt32LE(PE_SIZE, 0);
      let more = b.processFirst(snap, entry);
      while (more && entries.length < SNAPSHOT_MAX_ENTRIES) {
        const v = new DataView(entry.buffer, entry.byteOffset, PE_SIZE);
        entries.push({
          pid: v.getUint32(PE_OFF_PID, true),
          parentPid: v.getUint32(PE_OFF_PARENT, true),
          basename: readWString(entry, PE_OFF_EXE, PE_EXE_CHARS).toLowerCase(),
        });
        entry.writeUInt32LE(PE_SIZE, 0);
        more = b.processNext(snap, entry);
      }
    } finally {
      b.closeHandle(snap);
    }
  }
  cachedSnapshot = { at: now, entries };
  return entries;
}

/** 基名命中的存活 pid 列表（多窗口 / 多进程族命中用；非 Windows 回空表） */
export function listProcIdsByBasename(basename: string): number[] {
  const b = bindings();
  const key = basename.trim().toLowerCase();
  if (!b || !key) return [];
  return snapshotProcs(b).filter((e) => e.basename === key).map((e) => e.pid);
}

/** pid 是否属于进程族：自身或 ≤PROC_FAMILY_DEPTH 跳父链上任一环命中族基名 */
function pidInFamily(b: Bindings, pid: number, family: Set<string>): boolean {
  if (!pid || family.size === 0) return false;
  const byPid = new Map<number, ProcSnapshotEntry>();
  for (const e of snapshotProcs(b)) byPid.set(e.pid, e);
  let cur = byPid.get(pid);
  for (let depth = 0; depth < PROC_FAMILY_DEPTH && cur; depth++) {
    if (family.has(cur.basename)) return true;
    cur = byPid.get(cur.parentPid);
  }
  return false;
}

/** 一次采样：族存活 + 前台归属（含 #32770 属主回溯豁免） */
function sampleFamily(b: Bindings, family: Set<string>): ForegroundSample {
  // 快照为空 = 查询不可用（非「目标已退出」）：抛错让宿主跳过本轮，绝不误判离开/退出
  if (snapshotProcs(b).length === 0) throw new Error('foreground-proc: 进程快照为空');
  const familyAlive = [...family].some((name) => listProcIdsByBasename(name).length > 0);
  const hwnd = Number(b.foregroundWindow());
  if (!hwnd) return { foregroundInFamily: false, familyAlive };
  if (pidInFamily(b, windowPid(b, hwnd), family)) return { foregroundInFamily: true, familyAlive };
  if (windowClassName(b, hwnd) === DIALOG_CLASS) {
    const owner = Number(b.ancestor(hwnd, GA_ROOTOWNER));
    if (owner && owner !== hwnd && pidInFamily(b, windowPid(b, owner), family)) {
      return { foregroundInFamily: true, familyAlive };
    }
  }
  return { foregroundInFamily: false, familyAlive };
}

/** 前台窗口所属进程（含类名）；取不到窗口返回 null */
export function getForegroundProc(): ForegroundProc | null {
  const b = bindings();
  if (!b) return null;
  const hwnd = Number(b.foregroundWindow());
  if (!hwnd) return null;
  const pid = windowPid(b, hwnd);
  const exePath = getProcExePath(pid) ?? '';
  return { hwnd, pid, exePath, basename: basenameOf(exePath), className: windowClassName(b, hwnd) };
}

/** 构造看门狗探针（每 tick 一次采样）；FFI 不可用时抛错由 host 按样本缺失跳过 */
export function createForegroundProbe(family: string[]): ForegroundProbe {
  const set = new Set(family.filter(Boolean));
  return {
    sample(): ForegroundSample {
      const b = bindings();
      if (!b) throw new Error('foreground-proc: FFI 不可用');
      return sampleFamily(b, set);
    },
  };
}
