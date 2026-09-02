// UIA sidecar 客户端：spawn C# 进程 + JSON-RPC over stdio
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ElementRectResult, UiTreeOptions, UiTreeResult } from '@desktop-agi/shared-types';

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

export class UiaClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buf = '';
  private startedAt = 0;
  private stdout: NodeJS.ReadableStream | null = null;
  private stdin: NodeJS.WritableStream | null = null;

  constructor(private opts: UiaClientOptions = {}) {}

  private exePath(): string {
    return this.opts.executable ?? process.env.UIA_SIDECAR_EXE ?? resolveSidecarPath();
  }

  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    const exe = this.exePath();
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.stdout = this.proc.stdout;
    this.stdin = this.proc.stdin;
    this.startedAt = Date.now();
    this.stdout?.setEncoding('utf8');
    this.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(new Error(`sidecar error: ${err.message}`));
      this.pending.clear();
    });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`sidecar exited: ${code}`));
      this.pending.clear();
    });
    await this.request('health', {});
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  get healthy(): boolean {
    return !!this.proc && this.proc.exitCode === null;
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

  private request(method: string, payload: Record<string, unknown>): Promise<string> {
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, ...payload });
    this.stdin?.write(line + '\n');
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          reject(new Error(`sidecar timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async getUiTree(options: UiTreeOptions = {}): Promise<UiTreeResult> {
    const raw = await this.request('getUiTree', { params: options });
    return JSON.parse(raw) as UiTreeResult;
  }

  async elementRect(elementId: number): Promise<ElementRectResult> {
    const raw = await this.request('elementRect', { elementId });
    return JSON.parse(raw) as ElementRectResult;
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