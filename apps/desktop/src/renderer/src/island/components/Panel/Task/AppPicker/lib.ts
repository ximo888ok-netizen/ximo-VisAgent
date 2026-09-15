/**
 * lib.ts — AppPicker 纯函数核（搜索过滤 / chip 组装 / 单实例替换 / 发送 payload）
 *
 * 渲染层无组件测试基座，交互逻辑按里程碑要求抽成纯函数由 vitest 覆盖
 * （规划 §5 A-M2 测试策略；Playwright 项列为手测待办）。
 * 本文件不 import react / window，保持零副作用。
 */
import type { AppEntry, StartTaskRequest, TargetApp } from "@shared/island-contracts";
import {
  ANCHOR_LONG_TASK,
  LABEL_ALL,
  LABEL_RECOMMEND,
  LABEL_SEARCH,
  LIST_MIN_HEIGHT,
  LIST_VIEWPORT_HEIGHT,
  PINYIN_BOUNDARIES,
  POPOVER_TOP_GAP,
  RECOMMEND_LIMIT,
} from "./constants";

/** 应用行 + 预计算的拼音首字母串（列表装载时算一次，键入期零成本） */
export interface SearchableApp {
  entry: AppEntry;
  initials: string;
}

/** AppList 虚拟滚动的扁平渲染行（组头也是行，等行高） */
export type PickerRow =
  | { kind: "header"; label: string }
  | { kind: "app"; app: SearchableApp };

const CJK = /[\u4e00-\u9fff]/;
const PY_COLLATOR_LOCALE = "zh-Hans-CN-u-co-pinyin";

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function comparePinyin(a: string, b: string): number {
  try {
    return a.localeCompare(b, PY_COLLATOR_LOCALE);
  } catch {
    // 运行时无拼音排序数据 → 拼音检索退化（名称子串仍可用），绝不抛错
    return 0;
  }
}

/** 单字符首字母：汉字二分拼音边界表取声母；字母数字小写直用；其他字符忽略 */
export function charInitial(ch: string): string {
  if (!CJK.test(ch)) {
    return /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : "";
  }
  let lo = 0;
  let hi = PINYIN_BOUNDARIES.length - 1;
  let found: { letter: string; ch: string } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const boundary = PINYIN_BOUNDARIES[mid];
    if (boundary && comparePinyin(boundary.ch, ch) <= 0) {
      found = boundary;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ? found.letter : "";
}

export function pinyinInitials(name: string): string {
  let out = "";
  for (const ch of name) out += charInitial(ch);
  return out;
}

export function toSearchable(apps: AppEntry[]): SearchableApp[] {
  return apps.map((entry) => ({ entry, initials: pinyinInitials(entry.name) }));
}

/** 名称子串 ∪ 拼音首字母子串（规划 §4.1-4：本地过滤，≤100ms 无 IPC） */
export function matchApp(app: SearchableApp, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return app.entry.name.toLowerCase().includes(q) || app.initials.includes(q);
}

/**
 * 三分组扁平行：无查询 =「推荐」（apps:recent 头部；A-M3 看门狗通道落地后换真前台）
 * +「全部」（去重）；有查询 =「搜索结果」单组。空组不出组头。
 */
export function buildPickerRows(
  apps: SearchableApp[],
  recentIds: string[],
  query: string,
): PickerRow[] {
  const q = normalizeQuery(query);
  const asRow = (app: SearchableApp): PickerRow => ({ kind: "app", app });
  if (q) {
    const hits = apps.filter((app) => matchApp(app, q));
    return hits.length ? [{ kind: "header", label: LABEL_SEARCH }, ...hits.map(asRow)] : [];
  }
  const byId = new Map(apps.map((app) => [app.entry.id, app]));
  const recommend: SearchableApp[] = [];
  const seen = new Set<string>();
  for (const id of recentIds.slice(0, RECOMMEND_LIMIT)) {
    const app = byId.get(id);
    if (app && !seen.has(id)) {
      seen.add(id);
      recommend.push(app);
    }
  }
  const rest = apps.filter((app) => !seen.has(app.entry.id));
  const rows: PickerRow[] = [];
  if (recommend.length) {
    rows.push({ kind: "header", label: LABEL_RECOMMEND }, ...recommend.map(asRow));
  }
  if (rest.length) {
    rows.push({ kind: "header", label: LABEL_ALL }, ...rest.map(asRow));
  }
  return rows;
}

/** AppEntry → TargetApp（规划 §2.1：procFamily 缺省由 exePath basename 小写推出） */
export function toTargetApp(entry: AppEntry): TargetApp {
  const base = entry.exePath.split(/[\\/]/).pop() ?? entry.name;
  return {
    id: entry.id,
    name: entry.name,
    exePath: entry.exePath,
    iconRef: entry.iconRef,
    procFamily: [base.toLowerCase()],
  };
}

/** 单实例替换判定：已有异应用 chip → 替换（组件层 toast「已替换目标应用」） */
export function isChipReplacement(prev: TargetApp | null, next: TargetApp): boolean {
  return prev !== null && prev.id !== next.id;
}

/* ---------------------------------------------------------------------------
 * 发送 payload 组装。chip 已从「token 文本 + 镜像层」改为文本流中的原子节点
 * （序列化核见 ../composer-lib），goal 在序列化阶段即不含 chip 信息，此处只管 trim 与档位。
 * ------------------------------------------------------------------------- */

/**
 * 发送 payload 组装（规划 §4.1-6/7 红线）：无 chip 路径与现状逐字段一致 =
 * 仅 { goal }；带 chip 才附加 targetApp + 锚定档 longTask。
 * 应用语义由独立 targetApp 字段承载（launch/看门狗），goal 是输入区序列化出的纯文本。
 */
export function buildStartPayload(goal: string, targetApp: TargetApp | null): StartTaskRequest {
  const trimmed = goal.trim();
  return targetApp ? { goal: trimmed, targetApp, longTask: ANCHOR_LONG_TASK } : { goal: trimmed };
}

/**
 * 弹层几何（向上弹出）。可用空间 = 锚点顶 − 裁剪容器顶 − 留白；
 * 裁剪容器是最近的 overflow≠visible 祖先（面板滚动区 / 岛外壳），**不是视口顶部**——
 * 按视口算会把顶栏高度误当可用空间，弹层顶部（搜索框）就被裁到容器外。
 * 空间不足时先收缩列表（保底一行），弹层总高严格等于内容，绝不反向撑破容器。
 */
export function computePickerHeights(opts: {
  anchorTop: number;
  clipTop: number;
  headerH: number;
}): { listH: number; maxHeight: number } {
  const available = opts.anchorTop - opts.clipTop - POPOVER_TOP_GAP;
  const listH = Math.max(LIST_MIN_HEIGHT, Math.min(LIST_VIEWPORT_HEIGHT, available - opts.headerH));
  return { listH, maxHeight: opts.headerH + listH };
}
