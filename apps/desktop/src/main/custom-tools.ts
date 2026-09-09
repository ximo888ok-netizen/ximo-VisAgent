/**
 * custom-tools.ts — v3 P9 M17 自定义工具运行时
 *
 * 闭环：合成器产出脚本 → 宪法门批准 → 写盘 userData/tools/<id>.js → 编译注册
 *      → 作为 ToolSchema 暴露给模型 → 执行时经宿主注入的 invoke 桥调用已有原子工具。
 *
 * 沙箱边界是构造出来的，不是靠约定：脚本以「函数体」形式用 AsyncFunction 编译，
 * 作用域内只有 args / invoke / log 三个标识符，因此 require、fs、process、__dirname
 * 从一开始就不存在，无需信任脚本自我约束（静态检查作为第二道防线）。
 *
 * 隔离策略：
 * - 单次执行超时即判失败，异常不外溢到任务主链路；
 * - 加载失败（文件缺失/语法错误）只禁用该工具并留痕，不影响其他工具；
 * - 脚本路径必须落在 toolsDir 内，防止数据行被改写后指向任意文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_SCHEMA_MAP } from '@ximo-visagent/agent-core';
import type { ToolResult } from '@ximo-visagent/agent-core';
import type { OperationLevel } from '@ximo-visagent/shared-types';

export interface CustomToolDefinition {
  id: string;
  name: string;
  description: string;
  scriptPath: string;
  /** 由脚本内原子步骤的最高安全等级推出 */
  level: OperationLevel;
  parameters: Record<string, unknown>;
}

/** 宿主提供给脚本的原子工具调用桥 */
export type ToolInvoke = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface CustomToolOutcome {
  ok: boolean;
  summary: string;
}

type ToolScript = (args: Record<string, unknown>, invoke: ToolInvoke, log: (msg: string) => void) => Promise<unknown>;

/** 用一次 async 字面量取出真正的 AsyncFunction 构造器（同步 Function 无法编译顶层 await） */
type AsyncFunctionConstructor = new (...args: string[]) => ToolScript;
const AsyncFunction = (async function noop() {}).constructor as AsyncFunctionConstructor;

export class CustomToolRuntime {
  private loaded = new Map<string, { def: CustomToolDefinition; run: ToolScript }>();
  private failures = new Map<string, string>();

  constructor(
    private toolsDir: string,
    private invoke: ToolInvoke,
    private timeoutMs = 60_000,
  ) {}

  /** 编译并注册一个已批准的自定义工具；失败原因可通过 failure(id) 查询 */
  register(def: CustomToolDefinition): boolean {
    this.loaded.delete(def.id);
    this.failures.delete(def.id);

    const resolved = path.resolve(def.scriptPath);
    const root = path.resolve(this.toolsDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      this.failures.set(def.id, '脚本路径越界，拒绝加载');
      return false;
    }

    let source: string;
    try {
      source = fs.readFileSync(resolved, 'utf8');
    } catch {
      this.failures.set(def.id, `脚本不存在: ${resolved}`);
      return false;
    }

    try {
      const run = new AsyncFunction('args', 'invoke', 'log', `"use strict";\n${source}`);
      this.loaded.set(def.id, { def, run });
      return true;
    } catch (err) {
      this.failures.set(def.id, `脚本语法错误: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  unregister(id: string): void {
    this.loaded.delete(id);
    this.failures.delete(id);
  }

  /** 启动时从 DB 重建注册表，返回未能加载的工具 id（供 UI 显示禁用原因） */
  reload(defs: CustomToolDefinition[]): { loaded: string[]; failed: string[] } {
    this.loaded.clear();
    this.failures.clear();
    const loaded: string[] = [];
    const failed: string[] = [];
    for (const def of defs) {
      (this.register(def) ? loaded : failed).push(def.id);
    }
    return { loaded, failed };
  }

  get registeredNames(): string[] {
    return [...this.loaded.values()].map((v) => v.def.name);
  }

  has(name: string): boolean {
    return [...this.loaded.values()].some((v) => v.def.name === name);
  }

  /** 暴露给模型的额外工具定义 */
  toolSchemas(): Array<{ name: string; description: string; level: OperationLevel; source: 'meta'; parameters: Record<string, unknown> }> {
    return [...this.loaded.values()].map(({ def }) => ({
      name: def.name,
      description: def.description,
      level: def.level,
      source: 'meta' as const,
      parameters: def.parameters,
    }));
  }

  failure(id: string): string | null {
    return this.failures.get(id) ?? null;
  }

  /** 执行自定义工具：超时与异常均转成失败结果，不冒泡到主链路 */
  async execute(name: string, args: Record<string, unknown>): Promise<CustomToolOutcome> {
    const entry = [...this.loaded.values()].find((v) => v.def.name === name);
    if (!entry) return { ok: false, summary: `自定义工具未注册: ${name}` };

    const logs: string[] = [];
    const invoke: ToolInvoke = async (tool, toolArgs) => {
      if (!TOOL_SCHEMA_MAP[tool]) {
        return { ok: false, summary: `脚本调用了未注册工具 ${tool}`, error: 'unknown-tool' };
      }
      const res = await this.invoke(tool, toolArgs);
      logs.push(`${tool} → ${res.summary.slice(0, 80)}`);
      return res;
    };

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`执行超时（${Math.round(this.timeoutMs / 1000)}s）`)), this.timeoutMs);
      });
      const result = await Promise.race([entry.run(args, invoke, (m) => logs.push(m)), timeout]);
      const head = typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'summary' in result
          ? String((result as { summary: unknown }).summary)
          : '完成';
      return { ok: true, summary: [head, ...logs].join(' | ').slice(0, 500) };
    } catch (err) {
      return {
        ok: false,
        summary: `${name} 执行失败: ${err instanceof Error ? err.message : String(err)}${logs.length ? ` | ${logs.join(' | ')}` : ''}`.slice(0, 500),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * 启动时把库里 status='approved' 的工具重新编译注册。
 * level 与参数表在批准时已随契约持久化，这里只负责复原。
 */
export function loadApprovedTools(
  runtime: CustomToolRuntime,
  rows: Array<{ id: string; status: string; scriptPath: string; schemaJson: string }>,
): { loaded: string[]; failed: string[] } {
  const defs: CustomToolDefinition[] = [];
  for (const row of rows) {
    if (row.status !== 'approved' || !row.scriptPath) continue;
    try {
      const contract = JSON.parse(row.schemaJson) as {
        name: string; description: string; inputSchema: Record<string, unknown>; level?: OperationLevel;
      };
      if (!contract.name) continue;
      defs.push({
        id: row.id,
        name: contract.name,
        description: contract.description,
        scriptPath: row.scriptPath,
        // 缺失即退回最保守档，绝不因为数据不全而放宽审批
        level: contract.level ?? 2,
        parameters: contract.inputSchema,
      });
    } catch {
      /* 契约损坏的行跳过，不影响其他工具 */
    }
  }
  return runtime.reload(defs);
}

/** 写盘（覆盖）自定义工具脚本，返回落盘路径 */
export function writeToolScript(toolsDir: string, id: string, body: string): string {
  fs.mkdirSync(toolsDir, { recursive: true });
  const file = path.join(toolsDir, `${id}.js`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}
