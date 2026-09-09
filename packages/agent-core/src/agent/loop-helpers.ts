// loop 辅助：感知文本 / 模型输出解析 / 步骤压缩 / 工具定义 / 图片块
import { imageDetailFor, readImageSize } from '@ximo-visagent/llm-providers';
import type { ContentPart, ILLMClient, ToolDef } from '@ximo-visagent/llm-providers';
import type { ToolSchema } from '@ximo-visagent/shared-types';
import { OPTIONAL_TOOL_SCHEMAS, TOOL_SCHEMA_MAP, TOOL_SCHEMAS } from '../tools/schema';

export interface PerceptionSnap {
  screenshot?: Buffer;
  /** 感知帧指纹（宿主位图分块哈希；缺省回退整图字节哈希） */
  signature?: string;
  foreground?: { title: string; className: string };
  domain?: string;
  /** 结构化环境上下文（每步注入，让模型知道自己在什么环境里） */
  envContext?: EnvContext;
}

/** 画面变化判定：宿主分块指纹（64bit 二进制串）按汉明距离，整图字节哈希按严格不等。
 *  阈值滤掉光标闪烁/时钟跳秒这类单点噪声——"画面没变"只有可信了才敢当停滞信号用。 */
const SCREEN_CHANGE_MIN_BITS = 6;

export function isScreenChanged(prev: string, next: string): boolean {
  if (prev.length === next.length && /^[01]+$/.test(prev)) {
    let d = 0;
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) d++;
    return d > SCREEN_CHANGE_MIN_BITS;
  }
  return prev !== next;
}

/** 环境上下文：每步感知时附带的结构化系统信息，让模型对环境有基本认知 */
export interface EnvContext {
  /** 屏幕分辨率，如 "1920x1080" */
  screen?: string;
  /** DPI 缩放百分比，如 125 */
  dpiScale?: number;
  /** 操作系统版本，如 "Windows 10" / "Windows 11" */
  os?: string;
  /** 当前可见窗口列表（标题，最多 6 个，按 z-order 前到后） */
  windows?: string[];
}

export function buildPerceptionText(snap: PerceptionSnap, tasks: string[], step: number, screenChanged: boolean, noChangeCount = 0, recentActions?: { thought: string; actionName: string | null; resultSummary: string }[], maxSteps?: number, stateLines?: string[]): string {
  const lines: string[] = [];
  lines.push(`[步 #${step}${maxSteps ? `/${maxSteps}` : ''}]`);
  lines.push(`目标: ${tasks.join(' | ') || '(无)'}`);
  // 步数预算感知：开放式目标（"看一下…"）模型容易一直跑不收尾，从 1/4 处开始持续提醒对照目标
  if (maxSteps && step >= Math.ceil(maxSteps / 4) && step < Math.ceil(maxSteps / 2)) {
    lines.push('提醒：目标中的问题若已能回答，立即 task_done 收尾，不要「再看看/再确认」。');
  } else if (maxSteps && step >= Math.ceil(maxSteps / 2)) {
    lines.push(`⚠ 已执行 ${step}/${maxSteps} 步：只有目标未达成且有明确下一步才继续，否则立即 task_done，finalAnswer 直接回答目标问题。`);
  }
  if (snap.foreground) lines.push(`窗口: ${snap.foreground.title}`);

  // 环境上下文：屏幕分辨率、DPI、可见窗口列表（每步注入，让模型有环境感知）
  if (snap.envContext) {
    const envParts: string[] = [];
    if (snap.envContext.screen) envParts.push(`屏幕${snap.envContext.screen}`);
    if (snap.envContext.dpiScale && snap.envContext.dpiScale !== 100) envParts.push(`缩放${snap.envContext.dpiScale}%`);
    if (snap.envContext.os) envParts.push(snap.envContext.os);
    if (envParts.length > 0) lines.push(`环境: ${envParts.join(' / ')}`);
    // 可见窗口列表（让模型知道有哪些窗口可以 Alt+Tab 切换）
    if (snap.envContext.windows && snap.envContext.windows.length > 0) {
      lines.push(`可见窗口: ${snap.envContext.windows.join(' | ')}`);
    }
  }

  // 关键状态追踪：注入结构化关键状态（窗口/文件/剪贴板等），让模型不丢线索
  if (stateLines && stateLines.length > 0) {
    lines.push(`关键状态: ${stateLines.join('; ')}`);
  }

  // 近期动作历史：让模型看到"我刚做了什么、效果如何"，自己判断是否在钻牛尖
  if (recentActions && recentActions.length > 0) {
    const historyLines = recentActions
      .slice(-3)
      .map((a) => `${a.actionName ?? '思考'} → ${a.resultSummary || a.thought.slice(0, 60)}`);
    lines.push(`刚做过: ${historyLines.join('; ')}`);
  }

  if (snap.screenshot) {
    // 坐标系锚定：明确告知截图尺寸，弱模型目测坐标时不再按内部缩放空间报数
    const dims = readImageSize(snap.screenshot);
    const anchor = dims ? `（截图 ${dims.width}x${dims.height}，坐标在此坐标系内）` : '';
    if (noChangeCount >= 3) {
      lines.push(`注意：画面已连续 ${noChangeCount} 步没变。${anchor}`);
    } else if (noChangeCount > 1) {
      lines.push(`画面没变（${noChangeCount}步）。${anchor}`);
    } else {
      lines.push(`看截图给坐标，精确到±5px 以内${anchor}。`);
    }
  } else {
    lines.push('(无截图)');
  }
  return lines.join('\n');
}

/** 思考最小化：thought 进历史前截断（长篇思考对后续步骤毫无价值，只烧 prompt token）。
 *  超长 thought 视为过度思考信号，一次性返回纠正指令由 loop 注入。 */
export function clampThought(thought: string | null | undefined): { text: string; overthink: boolean } {
  const t = (thought ?? '').trim();
  if (!t) return { text: '', overthink: false };
  if (t.length <= 40) return { text: t, overthink: false };
  return { text: `${t.slice(0, 40)}…`, overthink: t.length > 200 };
}

/** 字符串 → 32bit 数（思考档软阈值带的种子：同 taskId 稳定） */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

export interface ParsedOutput {
  thought: string;
  /** 批动作直操：actions 数组（复合动作一批执行；单动作时长度 1） */
  actions: { name: string; args: Record<string, unknown> }[];
  done: boolean;
  finalAnswer?: string;
}

/** 兼容三种协议：function calling toolCalls（多个全收）/ 内联 JSON（含 actions[]）/ 纯文本结束 */
export function parseModelOutput(content: string | null, toolCalls: { name: string; args: string }[]): ParsedOutput {
  // 协议 1: 原生 tool_calls —— 全收成批（task_done/chat_reply 优先并短路）
  if (toolCalls && toolCalls.length > 0) {
    const terminal = toolCalls.find((t) => t.name === 'task_done' || t.name === 'chat_reply');
    if (terminal) {
      let args: Record<string, unknown>;
      try { args = JSON.parse(terminal.args); } catch { args = { text: terminal.args }; }
      if (terminal.name === 'task_done') {
        return { thought: content ?? '', actions: [], done: true, finalAnswer: (args.finalAnswer as string) ?? (content ?? '任务已完成') };
      }
      return { thought: content ?? '', actions: [{ name: 'chat_reply', args }], done: false };
    }
    const actions = toolCalls.map((tc) => {
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.args); } catch { args = { text: tc.args }; }
      return { name: tc.name, args };
    });
    return { thought: content ?? '', actions, done: false };
  }
  // 协议 2: {"thought": "...", "action" | "actions": [...], "done": bool, "finalAnswer": "..."}
  const text = content?.trim() ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { thought?: string; action?: { name?: string; args?: Record<string, unknown> }; actions?: { name?: string; args?: Record<string, unknown> }[]; done?: boolean; finalAnswer?: string };
      const thought = obj.thought ?? '';
      const done = !!obj.done;
      if (obj.actions && obj.actions.length > 0) {
        const actions = obj.actions
          .filter((a): a is { name: string; args?: Record<string, unknown> } => typeof a?.name === 'string' && a.name.length > 0)
          .map((a) => ({ name: a.name, args: a.args ?? {} }));
        if (actions.length > 0) return { thought, actions, done: false };
      }
      if (obj.action && obj.action.name) {
        return { thought, actions: [{ name: obj.action.name, args: obj.action.args ?? {} }], done: false, finalAnswer: obj.finalAnswer };
      }
      return { thought, actions: [], done, finalAnswer: obj.finalAnswer ?? thought };
    } catch { /* 非 JSON，按文本处理 */ }
  }
  // 协议 3: 纯文本结束 —— 全词匹配（P1-5 修复：「还没完成」不再误判为完成）
  if (/^\s*(任务完成|任务已完成|已完成|done|全部完成)[\s,.!。！]?\s*$/i.test(text) && text.length < 200) {
    return { thought: text, actions: [], done: true, finalAnswer: text };
  }
  return { thought: text, actions: [], done: false };
}

/** 截图 → LLM 图片块：一律 base64 内联（原图 + 供应商适配的 detail 档位）。
 *  Files API 已移除：Qwen/GLM/Kimi 的 OpenAI 兼容端点不支持 /files，
 *  DeepSeek 的 Files API 在某些网关下也存在降采样风险，统一内联最可靠。 */
export async function buildImagePart(model: ILLMClient, screenshot: Buffer): Promise<ContentPart> {
  const provider = model.config.provider;
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}`, detail: imageDetailFor(provider) } };
}

/** 动作重复签名：识别「同一工具对几乎同一目标」的机械重复（24px 栅格归并坐标抖动）。
 *  只收真正作用于界面的动作（点击/按键），观察类与元动作不参与。 */
export function actionSignature(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (name === 'mouse_click' || name === 'mouse_hold') {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return `${name}@${Math.round(x / 24)}_${Math.round(y / 24)}`;
  }
  if (name === 'ui_click') {
    const id = Number(args.elementId);
    return Number.isFinite(id) ? `ui_click#${id}` : null;
  }
  if (name === 'keyboard_press') return `press:${String(args.combo ?? '').toLowerCase()}`;
  // ui_locate / open_app 重复也纳入检测：同一个关键词搜两次以上就是钻牛尖
  if (name === 'ui_locate') {
    const q = String(args.query ?? '').trim().toLowerCase();
    return q ? `ui_locate:${q}` : null;
  }
  if (name === 'open_app') {
    const p = String(args.nameOrPath ?? '').trim().toLowerCase();
    return p ? `open_app:${p}` : null;
  }
  return null;
}

/** 编辑距离（Levenshtein），用于工具名纠正建议 */function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * 未知工具名 → 返回编辑距离 ≤2 的最接近候选（拼错也能自救）。
 * 背景：模型输出过不存在的 mouse_dick，执行器只回「未知工具」而无候选，
 * 导致模型凭记忆重复拼错、任务空转 12 步且鼠标始终未移动。
 */
export function suggestToolName(name: string): string | null {
  const best = Object.keys(TOOL_SCHEMA_MAP)
    .map((c) => ({ c, d: levenshtein(name, c) }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 2 ? best.c : null;
}

export async function summarizeSteps(
  llm: ILLMClient,
  steps: { thought: string; actionName: string | null; actionArgs: Record<string, unknown> | null; resultSummary: string }[],
): Promise<string> {
  const content = steps.map((s) => `- ${s.thought} | ${s.actionName ? `${s.actionName}(${JSON.stringify(s.actionArgs)}) → ${s.resultSummary}` : s.resultSummary}`).join('\n');
  try {
    const res = await llm.chat([
      { role: 'system', content: '将以下步骤历史压缩为 3-5 条要点(中文,每点一行),保留关键事实(路径/值/已完成的动作):' },
      { role: 'user', content },
    ]);
    return res.content ?? '(空)';
  } catch {
    return '[压缩失败]';
  }
}

export function buildToolDefs(activeOptional: ReadonlySet<string>, extra?: ToolSchema[]): ToolDef[] {
  const toDef = (t: ToolSchema): ToolDef => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  });
  // 常驻工具 + 已加载的可选工具；extra（custom_*）同为按需，仅激活的进列表
  const seen = new Set<string>(TOOL_SCHEMAS.map((t) => t.name));
  const defs = TOOL_SCHEMAS.map(toDef);
  for (const name of activeOptional) {
    const schema = OPTIONAL_TOOL_SCHEMAS.find((t) => t.name === name) ?? extra?.find((t) => t.name === name);
    if (schema && !seen.has(schema.name)) {
      seen.add(schema.name);
      defs.push(toDef(schema));
    }
  }
  return defs;
}

/** 可选工具目录行（系统提示用）：name(首句描述)，Agent 据此决定 request_tools 加载什么 */
export function optionalCatalogLines(optional: { name: string; description: string }[]): string[] {
  return optional.map((t) => `- ${t.name}: ${t.description.split('。')[0]!.slice(0, 60)}`);
}

/** 可选目录 = 内置可选 + 宿主自定义（custom_*） */
export function buildOptionalCatalog(extra?: ToolSchema[]): ToolSchema[] {
  return [...OPTIONAL_TOOL_SCHEMAS, ...(extra ?? [])];
}

/** request_tools 元动作处置（自 loop.ts 拆出）：校验目录、更新激活集，产出步骤与记忆记录 */
export function applyRequestTools(
  args: Record<string, unknown>,
  catalog: ToolSchema[],
  active: Set<string>,
): { summary: string; ok: boolean; invalidHint?: string } {
  const requested = Array.isArray(args.names)
    ? args.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : [];
  const valid = requested.filter((n) => catalog.some((t) => t.name === n));
  for (const n of valid) active.add(n);
  const invalid = requested.filter((n) => !valid.includes(n));
  const summary = valid.length > 0 ? `已加载工具: ${valid.join(', ')}（下一步起可用）` : '未加载任何工具';
  const invalidHint = invalid.length > 0
    ? `未知工具名: ${invalid.join(', ')}。可选目录: ${catalog.map((t) => t.name).join(', ')}`
    : undefined;
  return { summary, ok: invalid.length === 0, invalidHint };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
