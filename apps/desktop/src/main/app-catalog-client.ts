/**
 * app-catalog-client.ts — 应用目录服务客户端（A-M1）
 *
 * 三块职责（规划 §3.4 / §2.5 / §6 图标缓存风险行）：
 * 1. 专属 C# 侧车进程：懒拉起 / 复用，NDJSON JSON-RPC，15s 超时，空闲自动回收；
 *    一切失败回空表 / 无图标（前端字母兜底，选择器永不为空壳）。
 * 2. 内存目录缓存：5min TTL + refresh 手动失效；并发 listApps 合流只发一次枚举。
 * 3. 图标文件缓存 `icon-cache/`：键 = sha1(normalize(exePath))_{mtime}_{exeBytes}_{iconPx}px.png；
 *    写前清同 exe 旧文件；LRU 500 个 / 50MB 按 atime 淘汰；启动空闲期一次性清扫孤儿。
 *
 * 分层口诀：低频枚举/图标走侧车（本文件）；高频 pid→exe 走主进程 koffi（A-M3 另文件）。
 * 本模块不 import electron（可纯 Node 单测），路径注入见 AppCatalogOptions。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppEntry, AppIconPayload } from '../shared/schemas/longtask';

/** 侧车 listApps 行（C# AppCatalogActions 输出契约） */
interface SidecarAppRow {
  id: string;
  name: string;
  exePath: string;
  source: 'registry' | 'startmenu';
  mtime: number;
  size: number;
}

type SidecarReply = Record<string, unknown>;
type RequestFn = (method: string, payload: Record<string, unknown>) => Promise<SidecarReply>;

export interface AppCatalogOptions {
  /** 侧车 exe；缺省按仓库相对路径向上探测（打包态由 ipc-registry 注入 resourcesPath 路径） */
  exePath?: string;
  /** 图标文件缓存目录（生产 = userData/icon-cache；缺省落 tmp，仅为测试/异常兜底） */
  iconCacheDir?: string;
  /** 单测注入的假侧车通道；给出则完全绕过进程拉起 */
  requestFn?: RequestFn;
  ttlMs?: number;
  timeoutMs?: number;
  /** 侧车空闲回收（省电；下次请求自动重拉） */
  idleKillMs?: number;
  maxIconFiles?: number;
  maxIconBytes?: number;
  /** 孤儿清扫阈值：atime 老于此值的缓存文件视为孤儿 */
  orphanAgeMs?: number;
  now?: () => number;
}

const SIDECAR_REL = path.join('native', 'uia-sidecar-cs', 'bin', 'uia-sidecar.exe');
const ICONS_PER_BATCH = 25;
const ICON_CONCURRENCY = 2;
/** 统一取图尺寸：64px 兼顾 24px 显示 @2x DPI；侧车从 .ico 大层降采样，缓存键含此段 */
const DEFAULT_ICON_SIZE = 64;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_KILL_MS = 120_000;
const DEFAULT_ORPHAN_AGE_MS = 14 * 24 * 3600_000;
const SWEEP_DELAY_MS = 30_000;

/** 与 C# JsonExtract.NormalizePath 逐字一致：sha1 键两侧可对账 */
function normalizeExePath(p: string): string {
  return p.trim().toLowerCase().replace(/\//g, '\\');
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

function resolveDefaultSidecarExe(): string {
  const env = process.env.UIA_SIDECAR_EXE;
  if (env && existsSync(env)) return env;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, SIDECAR_REL);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return SIDECAR_REL;
}

function asRow(v: unknown): SidecarAppRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.exePath !== 'string' || !o.exePath) return null;
  if (typeof o.name !== 'string' || !o.name) return null;
  if (typeof o.id !== 'string' || !o.id) return null;
  const source = o.source === 'startmenu' ? 'startmenu' : 'registry';
  return {
    id: o.id,
    name: o.name,
    exePath: o.exePath,
    source,
    mtime: typeof o.mtime === 'number' ? o.mtime : 0,
    size: typeof o.size === 'number' ? o.size : 0,
  };
}

class AppCatalogService {
  private opts: Required<Omit<AppCatalogOptions, 'exePath' | 'requestFn'>> & Pick<AppCatalogOptions, 'exePath' | 'requestFn'>;
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: SidecarReply) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buf = '';
  private stdinOf: NodeJS.WritableStream | null = null;
  private cache: { apps: AppEntry[]; at: number } | null = null;
  private listInflight: Promise<AppEntry[]> | null = null;
  private idleKillTimer: ReturnType<typeof setTimeout> | null = null;
  private iconQueue: Array<() => void> = [];
  private iconActive = 0;
  private sweepScheduled = false;

  constructor(opts: AppCatalogOptions = {}) {
    this.opts = {
      exePath: opts.exePath,
      requestFn: opts.requestFn,
      iconCacheDir: opts.iconCacheDir ?? path.join(os.tmpdir(), 'ximo-visagent-icon-cache'),
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idleKillMs: opts.idleKillMs ?? DEFAULT_IDLE_KILL_MS,
      maxIconFiles: opts.maxIconFiles ?? 500,
      maxIconBytes: opts.maxIconBytes ?? 50 * 1024 * 1024,
      orphanAgeMs: opts.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS,
      now: opts.now ?? Date.now,
    };
  }

  // ---- 内存目录缓存 + 侧车通道 -------------------------------------------

  /** 已安装应用枚举。失败回空表（或旧缓存），永不抛出。 */
  async listApps(refresh = false): Promise<AppEntry[]> {
    const now = this.opts.now();
    if (!refresh && this.cache && now - this.cache.at < this.opts.ttlMs) return this.cache.apps;
    if (this.listInflight) return this.listInflight;
    this.listInflight = this.fetchApps()
      .then((apps) => {
        this.cache = { apps, at: this.opts.now() };
        return apps;
      })
      .catch((err: unknown) => {
        console.warn('[app-catalog] listApps 失败，回退', this.cache ? '旧缓存' : '空表：', err instanceof Error ? err.message : err);
        return this.cache ? this.cache.apps : [];
      })
      .finally(() => { this.listInflight = null; });
    return this.listInflight;
  }

  private async fetchApps(): Promise<AppEntry[]> {
    const res = await this.request('listApps', {});
    const rows = Array.isArray(res.apps) ? res.apps : [];
    return rows.map(asRow).filter((r): r is SidecarAppRow => r !== null)
      .map((r) => this.toEntry(r));
  }

  private toEntry(r: SidecarAppRow): AppEntry {
    return {
      id: r.id || sha1Hex(normalizeExePath(r.exePath)),
      name: r.name,
      exePath: r.exePath,
      // 侧车已报 mtime+size，iconRef 按缓存同名规则预判（含默认取图尺寸段）；mtime 变化只多一次缓存未命中
      iconRef: r.mtime > 0 ? `${sha1Hex(normalizeExePath(r.exePath))}_${Math.floor(r.mtime)}_${r.size}_${DEFAULT_ICON_SIZE}px.png` : '',
      source: r.source,
    };
  }

  // ---- 图标：文件缓存优先，未命中透传侧车（并发 ≤2） ----------------------

  async getIcons(exePaths: readonly string[], size = DEFAULT_ICON_SIZE): Promise<AppIconPayload[]> {
    const results = new Map<string, AppIconPayload>();
    const misses: string[] = [];
    for (const p of exePaths) {
      if (results.has(p)) continue;
      const hit = await this.readIconFile(p, size);
      if (hit) results.set(p, { exePath: p, pngBase64: hit });
      else misses.push(p);
    }
    const chunks: string[][] = [];
    for (let i = 0; i < misses.length; i += ICONS_PER_BATCH) chunks.push(misses.slice(i, i + ICONS_PER_BATCH));
    await Promise.all(chunks.map((chunk) => this.withSlot(async () => {
      let res: SidecarReply = {};
      try {
        res = await this.request('getAppIcons', { exePaths: chunk, size });
      } catch (err) {
        console.warn('[app-catalog] 图标批量失败（字母兜底）：', err instanceof Error ? err.message : err);
      }
      const icons = Array.isArray(res.icons) ? res.icons : [];
      for (const raw of icons) {
        const row = asIconRow(raw);
        if (!row) continue;
        const png = row.pngBase64 && isBase64(row.pngBase64) ? row.pngBase64 : null;
        if (png) await this.writeIconFile(row.exePath, png, size);
        results.set(row.exePath, png ? { exePath: row.exePath, pngBase64: png } : { exePath: row.exePath, error: 'extract failed' });
      }
      // 侧车漏答的路径显式回错误项（渲染层字母兜底，不留悬空请求）
      for (const p of chunk) if (!results.has(p)) results.set(p, { exePath: p, error: 'no reply' });
    })));
    return exePaths.map((p) => results.get(p) ?? { exePath: p, error: 'failed' });
  }

  /** 图标缓存文件名：键含 exe mtime+字节大小+请求图标尺寸（升级/换尺寸即失效，风险行 §6）；exe 不存在回空 */
  private async iconFileName(exePath: string, iconSize: number): Promise<string | null> {
    try {
      const st = await stat(exePath);
      return `${sha1Hex(normalizeExePath(exePath))}_${Math.floor(st.mtimeMs)}_${st.size}_${iconSize}px.png`;
    } catch {
      return null;
    }
  }

  private async readIconFile(exePath: string, iconSize: number): Promise<string | null> {
    const name = await this.iconFileName(exePath, iconSize);
    if (!name) return null;
    try {
      const png = (await readFile(path.join(this.opts.iconCacheDir, name))).toString('base64');
      const now = new Date();
      await utimes(path.join(this.opts.iconCacheDir, name), now, now).catch(() => undefined);
      return png;
    } catch {
      return null;
    }
  }

  private async writeIconFile(exePath: string, pngBase64: string, iconSize: number): Promise<void> {
    const name = await this.iconFileName(exePath, iconSize);
    if (!name) return;
    const dir = this.opts.iconCacheDir;
    const target = path.join(dir, name);
    try {
      await mkdir(dir, { recursive: true });
      // 写前清同 exe 旧键文件（mtime 升级换代，旧 PNG 永不再命中）
      const prefix = name.slice(0, name.indexOf('_') + 1);
      const stale = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f !== name);
      for (const f of stale) await rm(path.join(dir, f), { force: true }).catch(() => undefined);
      await writeFile(target, Buffer.from(pngBase64, 'base64'));
      await this.pruneIconCache();
    } catch (err) {
      console.warn('[app-catalog] 图标缓存写入失败', err instanceof Error ? err.message : err);
    }
  }

  /** LRU 淘汰：超 500 个或超 50MB 按 atime 从旧到新删 */
  private async pruneIconCache(): Promise<void> {
    const dir = this.opts.iconCacheDir;
    try {
      const files = await readdir(dir);
      const stats: Array<{ name: string; atimeMs: number; size: number }> = [];
      for (const f of files) {
        if (!f.endsWith('.png')) continue;
        const st = await stat(path.join(dir, f)).catch(() => null);
        if (st) stats.push({ name: f, atimeMs: st.atimeMs, size: st.size });
      }
      let totalBytes = stats.reduce((s, f) => s + f.size, 0);
      if (stats.length <= this.opts.maxIconFiles && totalBytes <= this.opts.maxIconBytes) return;
      stats.sort((a, b) => a.atimeMs - b.atimeMs);
      // 按 atime 从旧到新淘汰，直到数量与字节数双双回到上限内
      while (stats.length > this.opts.maxIconFiles || totalBytes > this.opts.maxIconBytes) {
        const victim = stats.shift();
        if (!victim) break;
        await rm(path.join(dir, victim.name), { force: true }).catch(() => undefined);
        totalBytes -= victim.size;
      }
    } catch (err) {
      console.warn('[app-catalog] 图标缓存淘汰失败', err instanceof Error ? err.message : err);
    }
  }

  /** 启动空闲清扫（一次性，规划 §6 风险行）：atime 老于 orphanAgeMs 的缓存文件视为孤儿 */
  scheduleOrphanSweep(): void {
    if (this.sweepScheduled) return;
    this.sweepScheduled = true;
    const timer = setTimeout(() => {
      void (async () => {
        const dir = this.opts.iconCacheDir;
        const cutoff = this.opts.now() - this.opts.orphanAgeMs;
        try {
          for (const f of await readdir(dir)) {
            const st = await stat(path.join(dir, f)).catch(() => null);
            if (st && st.atimeMs < cutoff) await rm(path.join(dir, f), { force: true }).catch(() => undefined);
          }
        } catch { /* 目录尚不存在 = 无孤儿可扫 */ }
      })();
    }, SWEEP_DELAY_MS);
    // 清扫定时器不许吊死事件循环（退出/测试态自动放行）
    timer.unref?.();
  }

  // ---- 侧车进程：懒拉起 / 复用 / 空闲回收 --------------------------------

  private request(method: string, payload: Record<string, unknown>): Promise<SidecarReply> {
    if (this.opts.requestFn) return this.opts.requestFn(method, payload);
    return this.requestViaSidecar(method, payload);
  }

  private async requestViaSidecar(method: string, payload: Record<string, unknown>): Promise<SidecarReply> {
    this.ensureProc();
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, ...payload });
    const stdin = this.stdinOf;
    if (!stdin || !this.proc || this.proc.exitCode !== null) throw new Error(`sidecar not available (${method})`);
    try {
      stdin.write(line + '\n');
    } catch (err) {
      throw new Error(`sidecar write failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const { timeoutMs } = this.opts;
    return new Promise<SidecarReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`sidecar timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); this.armIdleKill(); resolve(v); },
        reject: (e) => { clearTimeout(timer); this.armIdleKill(); reject(e); },
      });
    });
  }

  private ensureProc(): void {
    if (this.proc && this.proc.exitCode === null) {
      if (this.idleKillTimer) { clearTimeout(this.idleKillTimer); this.idleKillTimer = null; }
      return;
    }
    this.pending.clear();
    this.buf = '';
    const exe = this.opts.exePath ?? resolveDefaultSidecarExe();
    const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.proc = proc;
    this.stdinOf = proc.stdin;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    proc.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(new Error(`sidecar error: ${err.message}`));
      this.pending.clear();
      this.proc = null;
      this.stdinOf = null;
    });
    proc.on('exit', () => {
      for (const [, p] of this.pending) p.reject(new Error('sidecar exited'));
      this.pending.clear();
      this.proc = null;
      this.stdinOf = null;
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: SidecarReply };
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (p) {
          this.pending.delete(msg.id as number);
          const result = msg.result ?? {};
          if (result.ok === false) p.reject(new Error(String(result.error ?? 'sidecar error')));
          else p.resolve(result);
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }

  private armIdleKill(): void {
    if (this.idleKillTimer) clearTimeout(this.idleKillTimer);
    this.idleKillTimer = setTimeout(() => this.stopSidecar(), this.opts.idleKillMs);
    this.idleKillTimer.unref?.();
  }

  private stopSidecar(): void {
    if (this.idleKillTimer) { clearTimeout(this.idleKillTimer); this.idleKillTimer = null; }
    this.proc?.kill();
    this.proc = null;
    this.stdinOf = null;
  }

  /** 显式停机（app 退出链调用） */
  stop(): void {
    this.stopSidecar();
    for (const [, p] of this.pending) p.reject(new Error('catalog stopped'));
    this.pending.clear();
  }

  // ---- 并发 2 限流槽位 ---------------------------------------------------

  private withSlot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.iconActive++;
        fn().then(resolve, reject).finally(() => {
          this.iconActive--;
          const next = this.iconQueue.shift();
          if (next) next();
        });
      };
      if (this.iconActive < ICON_CONCURRENCY) run();
      else this.iconQueue.push(run);
    });
  }
}

function isBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/=\s]+$/.test(s);
}

function asIconRow(v: unknown): { exePath: string; pngBase64?: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.exePath !== 'string' || !o.exePath) return null;
  return { exePath: o.exePath, pngBase64: typeof o.pngBase64 === 'string' ? o.pngBase64 : undefined };
}

let _global: AppCatalogService | null = null;

/** 进程级单例（ipc-registry 装配；重复调用返回既有实例并告警配置漂移） */
export function getAppCatalogService(opts?: AppCatalogOptions): AppCatalogService {
  if (!_global) {
    _global = new AppCatalogService(opts);
    _global.scheduleOrphanSweep();
  }
  return _global;
}

export function stopAppCatalogService(): void {
  _global?.stop();
  _global = null;
}

export type { AppCatalogService };
