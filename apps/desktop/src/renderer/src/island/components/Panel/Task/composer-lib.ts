/**
 * composer-lib.ts — contenteditable 输入区纯函数核（序列化 / chip 结构识别 / 粘贴清洗 / 单实例）
 *
 * chip 新范式：不再是「token 文本 + 镜像覆盖层」，而是文本流里的真实原子行内节点
 * （contenteditable=false 的 span，一次退格整体删除）。goal 序列化时 chip 贡献 0 字符，
 * 与旧 token 占位方案（随镜像层一并删除）的剥离输出逐字段一致（零回归红线）。
 *
 * 渲染层无组件测试基座 + node 环境无 jsdom：本文件不触碰任何全局 DOM API，
 * 只依赖结构化最小接口 EditableNodeLike（composer-dom 负责把真实 DOM 节点适配成该形状，
 * 单测用纯对象打桩即可钉死全部关键行为）。
 */
import type { TargetApp } from "@shared/island-contracts";

/** 目标文本硬上限（沿袭 textarea maxLength=2000） */
export const MAX_GOAL_LENGTH = 2000;

/** chip 原子节点标记属性（类名样式见 island.css .island-app-chip） */
export const CHIP_ATTR = "data-island-app-chip";
/** chip 上承载的 targetApp JSON（序列化时经 decodeChipApp 还原，payload 契约不变） */
export const CHIP_APP_ATTR = "data-island-app";
/** chip 内 × 删除按钮标记（点击整体删除 chip 并解绑） */
export const CHIP_REMOVE_ATTR = "data-island-app-chip-remove";
/** 失效态（主进程 existsSync 预检失败）危险描边类 */
export const CHIP_INVALID_CLASS = "island-app-chip--invalid";

const NODE_TEXT = 3;
const NODE_ELEMENT = 1;
/** contenteditable=true 回退形态可能产生的块级元素（plaintext-only 正常只有文本 + BR） */
const BLOCK_NAMES = new Set(["DIV", "P"]);

/** 序列化所需的最小节点形状（composer-dom 由真实 DOM 适配；测试用 plain object） */
export interface EditableNodeLike {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<EditableNodeLike>;
  readonly getAttribute?: (name: string) => string | null;
}

export interface ComposerSnapshot {
  goal: string;
  app: TargetApp | null;
}

/* ---- chip 数据编解码 ---- */

export function encodeChipApp(app: TargetApp): string {
  return JSON.stringify(app);
}

/** 宽松解码：任一必填字段缺失/类型不符即视为无 chip（宁丢绑定不造脏 payload） */
export function decodeChipApp(raw: string | null | undefined): TargetApp | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string" || typeof rec.exePath !== "string") {
    return null;
  }
  const fam = rec.procFamily;
  if (!Array.isArray(fam) || fam.some((p) => typeof p !== "string")) return null;
  return {
    id: rec.id,
    name: rec.name,
    exePath: rec.exePath,
    iconRef: typeof rec.iconRef === "string" ? rec.iconRef : "",
    procFamily: fam as string[],
  };
}

/** 直接子节点里的 chip 列表（chip 恒为输入区第一层子节点，不嵌套） */
export function findChipNodes(children: ArrayLike<EditableNodeLike>): EditableNodeLike[] {
  const chips: EditableNodeLike[] = [];
  for (let i = 0; i < children.length; i++) {
    const n = children[i];
    if (n && n.getAttribute?.(CHIP_ATTR) != null) chips.push(n);
  }
  return chips;
}

/** 单实例裁决：至多保留首枚 chip，其承载的 app 即绑定目标 */
export function pickChipApp(chips: readonly EditableNodeLike[]): TargetApp | null {
  const first = chips[0];
  return first ? decodeChipApp(first.getAttribute?.(CHIP_APP_ATTR)) : null;
}

/* ---- 序列化 ---- */

/**
 * 遍历输入区子节点 → { goal, app }：
 * - 文本节点原样拼接；chip 原子节点贡献 0 字符并还原 app（首枚生效）；
 * - BR → 换行（块尾/文档尾的占位 BR 丢弃，避免空行幻影）；
 * - DIV/P 块级（contenteditable=true 回退形态）行间补换行。
 */
export function serializeEditable(root: ArrayLike<EditableNodeLike>): ComposerSnapshot {
  let goal = "";
  let app: TargetApp | null = null;
  let sawContent = false;
  const visit = (nodes: ArrayLike<EditableNodeLike>, inBlock: boolean): void => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      if (n.nodeType === NODE_TEXT) {
        goal += n.textContent ?? "";
        sawContent = true;
        continue;
      }
      if (n.nodeType !== NODE_ELEMENT) continue; // 注释等一律忽略（粘贴已强制纯文本，正常不会出现）
      if (n.getAttribute?.(CHIP_ATTR) != null) {
        if (app === null) app = decodeChipApp(n.getAttribute?.(CHIP_APP_ATTR));
        sawContent = true;
        continue;
      }
      const isBlock = BLOCK_NAMES.has(n.nodeName.toUpperCase());
      const last = i === nodes.length - 1;
      if (n.nodeName.toUpperCase() === "BR") {
        if (!last) goal += "\n"; // 块尾/文档尾 BR 是编辑器空行占位，丢弃
        continue;
      }
      if (!inBlock && isBlock && sawContent && !goal.endsWith("\n")) goal += "\n";
      visit(n.childNodes, isBlock);
    }
  };
  visit(root, false);
  return { goal, app };
}

/* ---- 输入治理 ---- */

/**
 * 粘贴/文本清洗：CRLF→LF、剥除 HTML 标签形态残留、去控制字符（保留换行）、按预算截断。
 * 真正的 HTML 防线是「只取 text/plain + createTextNode 插入」，此处兜底文本卫生。
 */
export function cleanPastedText(raw: string, budget: number): string {
  if (budget <= 0) return "";
  const noTags = raw.replace(/\r\n?/g, "\n").replace(/<[^>]*>/g, "");
  let out = "";
  for (const ch of noTags) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || (code >= 32 && code !== 127)) {
      if (out.length >= budget) break;
      out += ch;
    }
  }
  return out;
}

/** 超长截断（composition 期间绝不回写 DOM，唯一允许超限的入口是 IME 连打；提交前在此收口） */
export function clampGoal(goal: string, max: number = MAX_GOAL_LENGTH): string {
  return goal.length > max ? goal.slice(0, max) : goal;
}

/** 预算 = 上限 − 现文本长（负数归零） */
export function pasteBudget(currentLength: number, max: number = MAX_GOAL_LENGTH): number {
  return Math.max(0, max - currentLength);
}
