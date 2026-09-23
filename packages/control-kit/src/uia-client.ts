// UIA sidecar 客户端：spawn C# 进程 + JSON-RPC over stdio
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ElementRectResult, UiTreeOptions, UiTreeResult } from '@ximo-visagent/shared-types';
import { shouldRestart, nextBackoffMs } from './uia-restart-policy';

export interface UiaClientOptions {
  executable?: string; // 默认 native/uia-sidecar-cs/bin/uia-sidecar.exe
  startupTimeoutMs?: number;
}

/** sidecar 相对仓库根的路径 */
const SIDECAR_REL = path.join('native', 'uia-sidecar-cs', 'bin', 'uia-sidecar.exe');

/**
 * 从指定目录向上逐级查找仓库内的 sidecar。
 * dev（out/main）、单测（dist）等不同 __dirname 深度均可命中，不依赖固定层数。
 */
function findSidecarUpwards(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, SIDECAR_REL);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 打包后 exe 位于 resourcesPath/uia-sidecar.exe；开发模式向上找到仓库内路径 */
function resolveSidecarPath(): string {
  try {
    // electron 只在主进程运行时存在，顶部 import 会让本包在纯 Node 测试环境下直接崩
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) {
      const proc = process as typeof process & { resourcesPath?: string };
      return path.join(proc.resourcesPath ?? '', 'uia-sidecar.exe');
    }
  } catch {
    /* 非 electron 环境（单测）走默认 */
  }
  return findSidecarUpwards(__dirname) ?? SIDECAR_REL;
}

/** 自我污染防线共用的排除集合成：宿主进程 pid（Electron 主进程=灵动岛/aura 的窗口主人）恒在列表中并去重 */
export function withSelfPid(exclude?: number[]): number[] {
  return Array.from(new Set([process.pid, ...(exclude ?? [])]));
}

export class UiaClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buf = '';
  private startedAt = 0;
  private stdout: NodeJS.ReadableStream | null = null;
  private stdin: NodeJS.WritableStream | null = null;
  private restarting = false;
  private restartCount = 0;
  /** M07 修复：主动停止标志位，替代 restartCount=99 */
  private stopped = false;
  /** 重启预算耗尽后只发一次 degraded 事件（复位发生在健康响应处） */
  private degradedFired = false;

  constructor(private opts: UiaClientOptions = {}) {
    super();
  }

  private exePath(): string {
    return this.opts.executable ?? process.env.UIA_SIDECAR_EXE ?? resolveSidecarPath();
  }

  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    // M07 修复：start 时重置 stopped 标志位
    this.stopped = false;
    const exe = this.exePath();
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.stdout = this.proc.stdout;
    this.stdin = this.proc.stdin;
    this.startedAt = Date.now();
    this.stdout?.setEncoding('utf8');
    this.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(new Error(`sidecar error: ${err.message}`));
      this.pending.clear();
    });
    // BUG-08 修复：stdin/stdout error 事件监听，防止死管道未捕获异常
    this.stdin?.on?.('error', (err: Error) => {
      console.error('[uia] stdin error:', err.message);
      for (const [, p] of this.pending) p.reject(new Error(`sidecar stdin closed: ${err.message}`));
      this.pending.clear();
    });
    this.stdout?.on('error', (err: Error) => {
      console.error('[uia] stdout error:', err.message);
    });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`sidecar exited: ${code}`));
      this.pending.clear();
      this.buf = '';
      // F4 守护：异常退出自动重启（指数退避，最多 5 次，健康后清零预算）
      // M07 修复：用 stopped 标志位判断是否应阻止重启
      if (code !== 0 && !this.restarting && !this.stopped) {
        if (shouldRestart(this.restartCount)) {
          this.restarting = true;
          this.restartCount++;
          const backoff = nextBackoffMs(this.restartCount);
          console.warn(`[uia] sidecar exited (${code}), ${backoff}ms 后自动重启 (第 ${this.restartCount} 次)`);
          setTimeout(() => {
            this.restarting = false;
            this.start().catch((err) => console.error('[uia] 自动重启失败', err));
          }, backoff);
        } else if (!this.degradedFired) {
          // 重启预算耗尽：一次性降级事件，让调用方感知「UIA 不可用，降级视觉定位」
          this.degradedFired = true;
          console.error('[uia] sidecar 重启预算耗尽，UIA 不可用（降级视觉定位）');
          this.emit('degraded');
        }
      }
    });
    await this.request('health', {});
    // 健康响应 = sidecar 活着：复位重启预算（历史 bug：只增不减，累计 5 次后永久失联）
    this.restartCount = 0;
    this.degradedFired = false;
  }

  stop(): void {
    // M07 修复：用独立标志位阻止重启，不复位 restartCount
    // 这样下次 start() 时 restartCount 仍为 0，崩溃后能正常自动重启
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  get healthy(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** UIA 已降级（重启预算耗尽）：调用方应短路 UIA，直接走视觉定位降级 */
  get degraded(): boolean {
    return this.degradedFired;
  }

  /** UIA 当前是否可用（健康且未降级）。供拦截器等调用方在拦截前判断是否有替代方案。 */
  get available(): boolean {
    return this.healthy && !this.degradedFired;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        const id = msg.id ?? 0;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          // result 可能是嵌套对象（C# 端直接内嵌）或字符串
          p.resolve(typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? ''));
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }

  /**
   * 底层 JSON-RPC：发送一行 NDJSON、等 id 对应的 result（30s 超时）。
   * 公开是给 uia-index.ts 这类类型化封装复用超时/重启预算；
   * 业务代码优先用封装方法（getUiTree/indexWindow/…），别裸拼报文。
   */
  request(method: string, payload: Record<string, unknown>): Promise<string> {
    // BUG-08 修复：向死管道写入前检查健康状态
    if (!this.healthy) {
      return Promise.reject(new Error(`sidecar not healthy (method: ${method})`));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, ...payload });
    try {
      this.stdin?.write(line + '\n');
    } catch (err) {
      return Promise.reject(new Error(`sidecar write failed: ${(err as Error).message}`));
    }
    return new Promise<string>((resolve, reject) => {
      // M08 修复：超时后清理 setTimeout，防止成功 resolve 后定时器仍挂起
      // P0 修复：超时后触发健康检查——sidecar 可能假死（进程在但 RPC 不响应），
      // 主动 kill 让 exit handler 重建，避免后续所有 RPC 都死等 30s。
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          reject(new Error(`sidecar timeout: ${method}`));
        }
        // 假死检测：超时意味着进程可能 hung，kill 触发 exit→重启链
        if (this.proc && this.proc.exitCode === null) {
          console.warn(`[uia] RPC 超时 (${method})，主动 kill sidecar 触发重建`);
          this.proc.kill('SIGKILL');
        }
      }, 30_000);
      this.pending.set(id, {
        resolve: (v: string) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async getUiTree(options: UiTreeOptions = {}): Promise<UiTreeResult> {
    // 交付3（调用方半边）：本客户端跑在 Electron 主进程里，灵动岛/aura 同属该 pid，
    // 一旦进树模型就会去点我们自己的界面——宿主 pid 必进排除集（侧车内部再恒排除自身 pid）。
    const raw = await this.request('getUiTree', {
      params: { ...options, excludePids: withSelfPid(options.excludePids) },
    });
    return JSON.parse(raw) as UiTreeResult;
  }

  async elementRect(elementId: number): Promise<ElementRectResult> {
    const raw = await this.request('elementRect', { elementId });
    return JSON.parse(raw) as ElementRectResult;
  }

  /** UIA ScrollItemPattern.ScrollIntoView()：把元素滚入视口，回报滚动后的物理像素矩形 */
  async scrollIntoView(elementId: number): Promise<{ ok: boolean; x?: number; y?: number; w?: number; h?: number; error?: string }> {
    const raw = await this.request('scrollIntoView', { elementId });
    return JSON.parse(raw) as { ok: boolean; x?: number; y?: number; w?: number; h?: number; error?: string };
  }

  async focusedElement(): Promise<Record<string, unknown>> {
    const raw = await this.request('focusedElement', {});
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

let _global: UiaClient | null = null;

export function getUiaClient(): UiaClient {
  if (!_global) _global = new UiaClient();
  return _global;
}