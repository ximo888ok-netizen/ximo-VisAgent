/**
 * tool-script.ts — 自定义工具脚本的生成与校验（纯函数，无 electron 依赖）
 *
 * 自定义工具以「函数体」脚本运行：由 CustomToolRuntime 用 AsyncFunction 编译，
 * 作用域内只有 args / invoke / log，因此 require、fs、process 从一开始就不存在
 * （而不是靠约定不用）。staticSandboxCheck 是第二道防线（S7）。
 */
import { TOOL_SCHEMA_MAP } from '@ximo-visagent/agent-core';
import type { OperationLevel } from '@ximo-visagent/shared-types';

/** 固化的一个原子步骤 */
export interface SynthesizedStep {
  tool: string;
  args: Record<string, unknown>;
}

/** 生成脚本体：顺序调用 invoke，任一步失败立即返回并带上失败上下文 */
export function buildScriptBody(name: string, steps: SynthesizedStep[]): string {
  const lines: string[] = [
    `// 自定义工具 ${name}`,
    '// 作用域内仅有 args / invoke / log 三个标识符，模块加载能力不在其中。',
    'const results = [];',
  ];
  for (const [i, step] of steps.entries()) {
    lines.push(
      `const r${i} = await invoke(${JSON.stringify(step.tool)}, Object.assign(${JSON.stringify(step.args)}, args || {}));`,
      `results.push(${JSON.stringify(step.tool)} + ' → ' + r${i}.summary);`,
      `if (!r${i}.ok) return { ok: false, summary: '第 ${i + 1} 步 ${step.tool} 失败: ' + r${i}.summary };`,
    );
  }
  lines.push(`return { ok: true, summary: ${JSON.stringify(name + ' 完成: ')} + results.join(' | ') };`);
  return lines.join('\n') + '\n';
}

/** 脚本内出现的原子调用（用于推导安全等级：继承组成步骤的最高档） */
export function atomsInScript(script: string): string[] {
  return [...script.matchAll(/invoke\(\s*["']([\w.]+)["']/g)]
    .map((m) => m[1])
    .filter((t): t is string => Boolean(t));
}

export function deriveLevel(atoms: string[]): OperationLevel {
  let max: OperationLevel = 0;
  for (const atom of atoms) {
    const level = TOOL_SCHEMA_MAP[atom]?.level;
    if (level !== undefined && level > max) max = level;
  }
  return max;
}

// ---------- 沙箱静态检查（S7 第二道防线，宪法门 tool_register 执行器使用） ----------

export interface SandboxCheck {
  ok: boolean;
  blockedApis: string[];
}

const BLOCKED_PATTERNS: Array<[string, RegExp]> = [
  ['fs 破坏性删除', /\bfs\s*\.\s*(rm|rmSync|unlink|unlinkSync|rmdir)\b/],
  ['rmdir', /\brmdirSync\b/],
  ['child_process', /\bchild_process\b/],
  ['子进程', /\b(execSync|spawn|spawnSync|fork)\s*\(/],
  ['外部网络', /\b(https?\.request|net\.connect|WebSocket|fetch)\s*\(|\baxios\b/],
];

/** 静态扫描脚本，拒绝破坏性/外发 API */
export function staticSandboxCheck(script: string): SandboxCheck {
  const blocked: string[] = [];
  for (const [name, re] of BLOCKED_PATTERNS) {
    if (re.test(script)) blocked.push(name);
  }
  return { ok: blocked.length === 0, blockedApis: blocked };
}

/** 声明式契约（对应 custom_tools.schemaJson） */
export interface ToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** 以下两项由宪法门执行器在批准时写入（安全等级继承组成步骤的最高档） */
  level?: OperationLevel;
  atoms?: string[];
}
