// 布局稳定元素的坐标表缓存（ground once, reuse table）——借鉴 agent-vision-toolkit。
// 背景：UIA 未命中的应用（Electron/网页）每次点击同一工具栏按钮/侧栏项都要重跑一遍
// 视觉 grounding 降级链（SoM → 自由 bbox → zoom → OCR），token 与延迟浪费大。
// 策略：一次定位成功后把截图像素坐标记入表；后续定位先查表——窗口签名一致且整帧
// 指纹（宿主分块 pHash）距离在阈内（布局没动）才复用；窗口切换/scroll/任务终态/步数 TTL 失效。
// 保守铁律：宁可 miss 也不给错坐标——窗口签名或帧指纹缺失一律判 miss。
// 安全语义：缓存只替代「定位」这一步；点击后校验、点击守卫、审批分级 L0-L3 一律照旧，
// 缓存结果与普通定位结果走完全相同的执行链（wrapper 只短路 ui_locate 内部的降级链）。
import type { ToolExecutor, ToolResult } from '../tools/registry';

export type GroundSource = 'uia' | 'grounding';

/** 截图像素框（= 物理像素，与 grounding.ts / UIA 控件矩形同坐标系） */
export interface GroundBox { x: number; y: number; w: number; h: number }
export interface GroundPoint { x: number; y: number }

/** 查表/记表时的帧上下文：由主循环每步 beginStep 登记 */
export interface GroundCacheCtx {
  /** 前台窗口签名（标题|类名）；缺失 = 无法判定布局语境 → 一律 miss */
  windowSignature?: string;
  /** 整帧指纹（宿主分块 pHash 二进制串）；缺失 → 一律 miss */
  frameHash?: string;
  step: number;
}

export interface GroundCacheEntry {
  box: GroundBox;
  center: GroundPoint;
  windowSignature: string;
  frameHash: string;
  step: number;
  source: GroundSource;
}

export interface GroundCacheHit {
  box: GroundBox;
  center: GroundPoint;
  source: GroundSource;
  stepsAgo: number;
}

export interface GroundCacheStats {
  lookups: number;
  hits: number;
  misses: number;
  records: number;
  invalidations: number;
  entries: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_STEPS = 20;
/** 帧指纹允许的最大汉明距离：与 loop-helpers 画面变化阈值同口径（≤ 视为布局没动） */
const DEFAULT_MAX_HASH_DISTANCE = 6;

/** 归一化定位目标文本：trim + 小写 + 折叠空白（'Save  Button ' 与 'save button' 同键） */
export function normalizeLocateTarget(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 前台窗口签名：标题|类名，任一变化即视为环境切换 */
export function windowSignatureOf(foreground?: { title: string; className?: string }): string | undefined {
  return foreground ? `${foreground.title}|${foreground.className ?? ''}` : undefined;
}

/** 帧指纹距离：完全相等记 0；同为二进制串按汉明距离；其余不可比 → null（按 miss 处理） */
export function hashDistance(a: string, b: string): number | null {
  if (a === b) return 0;
  if (a.length === b.length && /^[01]+$/.test(a)) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }
  return null;
}

function isFiniteBox(b: GroundBox): boolean {
  return [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v));
}

export class GroundCache {
  private entries = new Map<string, GroundCacheEntry>();
  private frame: GroundCacheCtx | null = null;
  /** 最近一次已知的窗口签名（感知帧缺失时不更新，避免抖动误清表） */
  private lastWindow: string | undefined;
  private counters = { lookups: 0, hits: 0, misses: 0, records: 0, invalidations: 0 };

  constructor(
    private maxEntries = DEFAULT_MAX_ENTRIES,
    private ttlSteps = DEFAULT_TTL_STEPS,
    private maxHashDistance = DEFAULT_MAX_HASH_DISTANCE,
  ) {}

  /** 每步感知后登记帧上下文；窗口签名变化 → 整表失效（旧坐标必废） */
  beginStep(ctx: GroundCacheCtx): void {
    if (ctx.windowSignature && this.lastWindow && ctx.windowSignature !== this.lastWindow) {
      this.invalidateAll('window-changed');
    }
    if (ctx.windowSignature) this.lastWindow = ctx.windowSignature;
    this.frame = ctx;
  }

  /** 动作登记：scroll 会移动布局，已录坐标全部失效（点击类不失效：帧距离判定兜底） */
  onAction(name: string): void {
    if (name === 'mouse_scroll') this.invalidateAll('scroll');
  }

  /** 查表：窗口签名一致 且 整帧指纹距离 ≤ 阈值 且 TTL 内才命中；任一不满足 → miss */
  lookup(target: string, ctx?: GroundCacheCtx): GroundCacheHit | null {
    this.counters.lookups++;
    const cur = ctx ?? this.frame;
    const key = normalizeLocateTarget(target);
    const miss = (why: string): null => {
      this.counters.misses++;
      console.log(`[ground-cache] miss(${why}) "${target}" 命中${this.counters.hits}/查${this.counters.lookups}`);
      return null;
    };
    if (!key || !cur) return miss('no-frame-ctx');
    if (!cur.windowSignature || !cur.frameHash) return miss('missing-signature');
    const e = this.entries.get(key);
    if (!e) return miss('no-entry');
    if (e.windowSignature !== cur.windowSignature) {
      this.entries.delete(key);
      return miss('window-changed');
    }
    const d = hashDistance(cur.frameHash, e.frameHash);
    if (d === null || d > this.maxHashDistance) {
      this.entries.delete(key);
      return miss(`frame-moved(${d ?? 'incomparable'})`);
    }
    if (cur.step - e.step > this.ttlSteps) {
      this.entries.delete(key);
      return miss('ttl');
    }
    this.entries.delete(key);
    this.entries.set(key, e); // LRU touch：命中即最近使用
    this.counters.hits++;
    const hit: GroundCacheHit = { box: e.box, center: e.center, source: e.source, stepsAgo: cur.step - e.step };
    console.log(`[ground-cache] hit "${target}" → (${hit.center.x},${hit.center.y}) 源${hit.source} ${hit.stepsAgo}步前 帧距${d ?? 0}`);
    return hit;
  }

  /** 记表：当前帧上下文不完整（缺窗口签名/帧指纹）则保守跳过，不记不可信条目 */
  record(target: string, box: GroundBox, source: GroundSource, ctx?: GroundCacheCtx): boolean {
    const cur = ctx ?? this.frame;
    const key = normalizeLocateTarget(target);
    if (!key || !cur?.windowSignature || !cur.frameHash || !isFiniteBox(box)) return false;
    const entry: GroundCacheEntry = {
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
      center: { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) },
      windowSignature: cur.windowSignature,
      frameHash: cur.frameHash,
      step: cur.step,
      source,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.counters.records++;
    console.log(`[ground-cache] record "${target}" → (${entry.center.x},${entry.center.y}) 源${source} 表内${this.entries.size}条`);
    return true;
  }

  /** 整表失效（任务终态/窗口变化/scroll）；计数器保留，便于跨任务量总命中率 */
  invalidateAll(reason: string): void {
    if (this.entries.size > 0) this.counters.invalidations++;
    this.entries.clear();
    console.log(`[ground-cache] invalidateAll(${reason})`);
  }

  stats(): GroundCacheStats {
    return { ...this.counters, entries: this.entries.size };
  }

  /** 命中/未命中计数一行（进 step 事件 resultSummary 做观测，不新增 IPC 通道） */
  statsLine(): string {
    const s = this.counters;
    return `坐标缓存 命中${s.hits}/查${s.lookups} miss${s.misses} 记${s.records} 表${this.entries.size}条`;
  }
}

/** ui_locate 结果里提取首个候选框（坐标在截图像素系）；结构不符则不记 */
function extractFirstBox(res: ToolResult): GroundBox | null {
  const raw = res.data?.matches;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const m = raw[0];
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  const box: GroundBox = { x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h) };
  return isFiniteBox(box) ? box : null;
}

/** 定位来源判定：UIA 直查与 SoM（坐标取自 UIA 候选矩形）算 uia；自由 grounding/zoom/OCR 算 grounding */
function sourceFromSummary(summary: string): GroundSource {
  return summary.startsWith('找到') || summary.startsWith('SoM 视觉选择') ? 'uia' : 'grounding';
}

/**
 * 执行器包装：在 grounding 降级链前查表、成功后记表（UIA 命中同样进表，复用价值最高）。
 * 只短路 ui_locate 的「定位」一步；click:true（找到即点）与其余动作原样透传，
 * 点击守卫/点击后校验/审批分级全部沿用真实执行链，缓存不构成旁路。
 */
export function wrapExecutorWithGroundCache(executor: ToolExecutor, cache: GroundCache): ToolExecutor {
  return {
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const query = name === 'ui_locate' ? String(args.query ?? '').trim() : '';
      if (!query || args.click === true) return executor.execute(name, args);
      const hit = cache.lookup(query);
      if (hit) {
        return {
          ok: true,
          summary: `[坐标缓存] 复用定位 "${query}" 中心(${hit.center.x},${hit.center.y}) 尺寸 ${hit.box.w}x${hit.box.h}（源 ${hit.source}，${hit.stepsAgo} 步前帧稳定）。请直接 mouse_click 中心坐标（双击 times=2）｜${cache.statsLine()}`,
          data: { matches: [{ name: query, ...hit.box }] },
        };
      }
      const res = await executor.execute(name, args);
      if (res.ok) {
        const box = extractFirstBox(res);
        if (box) cache.record(query, box, sourceFromSummary(res.summary));
      }
      return res;
    },
  };
}
