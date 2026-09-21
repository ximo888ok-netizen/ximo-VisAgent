// 布局稳定元素的坐标表缓存（ground once, reuse table）——借鉴 agent-vision-toolkit。
// 背景：UIA 未命中的应用（Electron/网页）每次点击同一工具栏按钮/侧栏项都要重跑一遍
// 视觉 grounding 降级链（SoM → 自由 bbox → zoom → OCR），token 与延迟浪费大。
// 复用判据（全部满足才命中，缺一不可）：
//  1) 廉价前置闸：窗口签名一致 + 整帧指纹距离 ≤6 + TTL ≤8 步；
//  2) 局部外观复核（核心）：整帧 pHash 对下拉弹出/列表刷新/覆盖对话框等局部变化不敏感，
//     记表时额外存 box 区域裁剪指纹 cropHash，查表时必须用当前屏幕同一区域重算指纹比对
//     （距离 ≤4 才放行）——「要复用就必须再看一眼那块地方」；
//  3) 纯视觉框（source=grounding）还需上一次该目标点击校验成功（clickOk）；
//  4) UIA 框（source=uia）由 wrapper 保证「UIA 可用时永远先实时查询」，缓存只兜底。
// 自愈：用缓存坐标执行的点击若 click-verify 判 changed=false → 立即失效该条目；
// 同任务内连续 2 次 → 停用缓存（后续一律走完整降级链），失效计数进 stats/statsLine。
// 保守铁律：宁可 miss 也不给错坐标——缺窗口签名/整帧指纹/区域指纹回调、区域指纹取不到
// 或 box 越界，一律 miss / 不记表。区域指纹由宿主注入回调（agent-core 禁止 import
// desktop/perception，保持依赖方向）。
// 安全语义：缓存只替代「定位」这一步；点击后校验、点击守卫、审批分级 L0-L3 一律照旧，
// 缓存结果与普通定位结果走完全相同的执行链（wrapper 只短路 ui_locate 内部的降级链）。
import type { ToolExecutor, ToolResult } from '../tools/registry';
import { fmtCoordAgent } from './coord-format';

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

/**
 * 宿主注入的区域指纹回调：对当前屏幕的 box 区域（截图像素坐标）计算 pHash 二进制串。
 * 返回 null = 截图失败 / 区域越出屏幕边界 / 宿主不支持 → 调用方一律按 miss / 不记表处理。
 * 由 desktop 组装根（host-capabilities 的 captureNative + pHash64）实现并注入。
 */
export type RegionFingerprint = (box: GroundBox) => Promise<string | null>;

export interface GroundCacheEntry {
  box: GroundBox;
  center: GroundPoint;
  windowSignature: string;
  frameHash: string;
  /** 记表时 box 区域（归一化后）的裁剪指纹：局部外观复核判据 */
  cropHash: string;
  step: number;
  source: GroundSource;
  /** 上一次该目标点击校验是否成功（changed=true）；纯视觉框复用的前置条件 */
  clickOk: boolean;
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
  /** 自愈失效次数（缓存坐标点击校验判无效导致条目被剔除的次数） */
  clickFailures: number;
  /** 本任务是否已被自愈停用 */
  disabled: boolean;
}

const DEFAULT_MAX_ENTRIES = 64;
/** TTL 从 20 步收紧到 8 步：缓存界面容易变化，宁可少复用也不给陈旧坐标 */
const DEFAULT_TTL_STEPS = 8;
/** 整帧指纹前置闸：与 loop-helpers 画面变化阈值同口径（≤ 视为全局没动）；只是廉价粗筛，
 *  对局部变化不敏感，命中还须过 cropHash 局部复核 */
const DEFAULT_MAX_HASH_DISTANCE = 6;
/** 局部外观复核阈：同一区域前后 pHash 汉明距离 ≤4 才允许复用。取比整帧 6 更紧，
 *  因为裁剪区域小、同尺寸重采样的指纹对目标区域的改动远比整帧敏感 */
const DEFAULT_MAX_CROP_HASH_DISTANCE = 4;
/** 最小采样边长：过小的框（如 <8px 的小图标）pHash 全是噪声，外扩到 16px 再取指纹 */
const MIN_CROP_EDGE_PX = 16;
/** 同一任务内连续 2 次「缓存坐标 + 点击校验无效」→ 停用缓存，后续全走完整降级链 */
const MAX_CONSECUTIVE_CLICK_FAILURES = 2;

export interface GroundCacheOptions {
  maxEntries?: number;
  ttlSteps?: number;
  /** 整帧指纹阈（前置闸） */
  maxHashDistance?: number;
  /** 局部外观复核阈 */
  maxCropHashDistance?: number;
  /** 区域指纹回调；缺省 = 无法局部复核 → 查表/记表一律保守 miss */
  regionFingerprint?: RegionFingerprint;
}

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

/** 区域归一化：边长小于 MIN_CROP_EDGE_PX 的 box 以中心外扩到最小采样边长，避免小区域指纹噪声 */
export function normalizeCropBox(b: GroundBox): GroundBox {
  const w = Math.max(MIN_CROP_EDGE_PX, Math.round(b.w));
  const h = Math.max(MIN_CROP_EDGE_PX, Math.round(b.h));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

function isFiniteBox(b: GroundBox): boolean {
  return [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v));
}

/** 负坐标 = 越出屏幕左上边界（右下越界由宿主回调整图尺寸判定后返回 null） */
function isOffscreenTopLeft(b: GroundBox): boolean {
  return b.x < 0 || b.y < 0;
}

export class GroundCache {
  private entries = new Map<string, GroundCacheEntry>();
  private frame: GroundCacheCtx | null = null;
  /** 最近一次已知的窗口签名（感知帧缺失时不更新，避免抖动误清表） */
  private lastWindow: string | undefined;
  private counters = { lookups: 0, hits: 0, misses: 0, records: 0, invalidations: 0, clickFailures: 0 };
  /** 自愈停用（任务级）：连续点击校验失败达阈后本任务不再查表/记表 */
  private disabled = false;
  private clickFailStreak = 0;
  /** 待点击校验的目标：ui_locate 命中缓存或新记表时登记，下一次点击结果结算（自愈闭环） */
  private pending: { key: string; fromCache: boolean } | null = null;
  private maxEntries: number;
  private ttlSteps: number;
  private maxHashDistance: number;
  private maxCropHashDistance: number;
  private regionFingerprint?: RegionFingerprint;

  constructor(opts: GroundCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlSteps = opts.ttlSteps ?? DEFAULT_TTL_STEPS;
    this.maxHashDistance = opts.maxHashDistance ?? DEFAULT_MAX_HASH_DISTANCE;
    this.maxCropHashDistance = opts.maxCropHashDistance ?? DEFAULT_MAX_CROP_HASH_DISTANCE;
    this.regionFingerprint = opts.regionFingerprint;
  }

  /** 任务启动：清除上一任务的自愈停用与连败计数 */
  beginTask(): void {
    this.disabled = false;
    this.clickFailStreak = 0;
    this.pending = null;
  }

  /** 每步感知后登记帧上下文；窗口签名变化 → 整表失效（旧坐标必废） */
  beginStep(ctx: GroundCacheCtx): void {
    if (ctx.windowSignature && this.lastWindow && ctx.windowSignature !== this.lastWindow) {
      this.invalidateAll('window-changed');
    }
    if (ctx.windowSignature) this.lastWindow = ctx.windowSignature;
    this.frame = ctx;
  }

  /** 动作登记：scroll 会移动布局，已录坐标全部失效（点击类不失效：局部复核兜底） */
  onAction(name: string): void {
    if (name === 'mouse_scroll') this.invalidateAll('scroll');
  }

  /**
   * 查表：窗口签名一致 + 整帧指纹 ≤ 前置阈 + TTL 内 + 局部外观复核（cropHash 距离 ≤ 局部阈）
   * 全部通过才命中；grounding 源还要求上次点击校验成功。任一不满足 → miss 并保守剔除。
   */
  async lookup(target: string, ctx?: GroundCacheCtx): Promise<GroundCacheHit | null> {
    this.counters.lookups++;
    const cur = ctx ?? this.frame;
    const key = normalizeLocateTarget(target);
    const drop = (): void => { this.entries.delete(key); };
    const miss = (why: string): null => {
      this.counters.misses++;
      console.log(`[ground-cache] miss(${why}) "${target}" 命中${this.counters.hits}/查${this.counters.lookups}`);
      return null;
    };
    if (this.disabled) return miss('disabled');
    if (!key || !cur) return miss('no-frame-ctx');
    if (!cur.windowSignature || !cur.frameHash) return miss('missing-signature');
    const e = this.entries.get(key);
    if (!e) return miss('no-entry');
    if (e.windowSignature !== cur.windowSignature) {
      drop();
      return miss('window-changed');
    }
    const d = hashDistance(cur.frameHash, e.frameHash);
    if (d === null || d > this.maxHashDistance) {
      drop();
      return miss(`frame-moved(${d ?? 'incomparable'})`);
    }
    if (cur.step - e.step > this.ttlSteps) {
      drop();
      return miss('ttl');
    }
    if (e.source === 'grounding' && !e.clickOk) {
      return miss('unverified-click'); // 纯视觉估的框：未经实时点击验证过不给复用（不剔除，验证后可用）
    }
    // 局部外观复核（核心闸）：整帧没动 ≠ 那块地方没动，必须重看当前屏幕同一区域
    if (!this.regionFingerprint) { drop(); return miss('no-region-fp'); }
    if (isOffscreenTopLeft(e.box)) { drop(); return miss('box-oob'); }
    const cropNow = await this.regionFingerprint(normalizeCropBox(e.box));
    const cd = cropNow === null ? null : hashDistance(cropNow, e.cropHash);
    if (cd === null || cd > this.maxCropHashDistance) {
      drop();
      return miss(`region-moved(${cd ?? 'incomparable'})`);
    }
    this.entries.delete(key);
    this.entries.set(key, e); // LRU touch：命中即最近使用
    this.counters.hits++;
    this.pending = { key, fromCache: true };
    const hit: GroundCacheHit = { box: e.box, center: e.center, source: e.source, stepsAgo: cur.step - e.step };
    console.log(`[ground-cache] hit "${target}" → (${hit.center.x},${hit.center.y}) 源${hit.source} ${hit.stepsAgo}步前 整帧距${d ?? 0} 局部距${cd ?? 0}`);
    return hit;
  }

  /**
   * 记表：当前帧上下文不完整（缺窗口签名/整帧指纹）或拿不到局部指纹（无回调/越界/截图失败）
   * 则保守跳过——记了也永远过不了复核，不如不记。成功后登记为「待点击校验」目标。
   */
  async record(target: string, box: GroundBox, source: GroundSource, ctx?: GroundCacheCtx): Promise<boolean> {
    if (this.disabled) return false;
    const cur = ctx ?? this.frame;
    const key = normalizeLocateTarget(target);
    if (!key || !cur?.windowSignature || !cur.frameHash || !isFiniteBox(box) || isOffscreenTopLeft(box)) return false;
    if (!this.regionFingerprint) return false;
    const cropHash = await this.regionFingerprint(normalizeCropBox(box));
    if (!cropHash) return false;
    const entry: GroundCacheEntry = {
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
      center: { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) },
      windowSignature: cur.windowSignature,
      frameHash: cur.frameHash,
      cropHash,
      step: cur.step,
      source,
      clickOk: false,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.counters.records++;
    this.pending = { key, fromCache: false };
    console.log(`[ground-cache] record "${target}" → (${entry.center.x},${entry.center.y}) 源${source} 表内${this.entries.size}条`);
    return true;
  }

  /**
   * 点击后校验结果结算（自愈闭环，由 wrapper 在每次点击后调用）：
   * changed=true → 清零连败并把该目标标记为「点击验证过」（纯视觉框可复用）；
   * changed=false → 剔除该条目；若该次点击用的是缓存坐标，连败 +1，
   * 连续达 MAX_CONSECUTIVE_CLICK_FAILURES 次 → 本任务停用缓存；
   * null（无校验数据）→ 仅清挂账，不奖惩。
   */
  settlePendingClick(changed: boolean | null): void {
    const p = this.pending;
    this.pending = null;
    if (!p || changed === null || this.disabled) return;
    if (changed) {
      this.clickFailStreak = 0;
      const e = this.entries.get(p.key);
      if (e) e.clickOk = true;
      return;
    }
    this.entries.delete(p.key);
    if (!p.fromCache) return; // 新定位的点击无效：坐标来自实时链路，只剔条目不计自愈连败
    this.counters.clickFailures++;
    this.clickFailStreak++;
    if (this.clickFailStreak >= MAX_CONSECUTIVE_CLICK_FAILURES) {
      this.disabled = true;
      console.log('[ground-cache] 停用：连续 2 次缓存坐标点击校验无效，本任务改走完整降级链');
    } else {
      console.log(`[ground-cache] 自愈：缓存点击无效，剔除 "${p.key}"（连败 ${this.clickFailStreak}）`);
    }
  }

  /** 整表失效（任务终态/窗口变化/scroll）；计数器保留，便于跨任务量总命中率 */
  invalidateAll(reason: string): void {
    if (this.entries.size > 0) this.counters.invalidations++;
    this.entries.clear();
    this.pending = null;
    console.log(`[ground-cache] invalidateAll(${reason})`);
  }

  stats(): GroundCacheStats {
    return { ...this.counters, entries: this.entries.size, disabled: this.disabled };
  }

  /** 命中/未命中/自愈计数一行（进 step 事件 resultSummary 做观测，不新增 IPC 通道） */
  statsLine(): string {
    const s = this.counters;
    return `坐标缓存 命中${s.hits}/查${s.lookups} miss${s.misses} 记${s.records} 表${this.entries.size}条 自愈失效${s.clickFailures}${this.disabled ? ' 已停用' : ''}`;
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

/** control-kit click-verify 结构化结果：data.clickVerify.changed；缺失 = 无法判定（null，不奖惩） */
function clickVerifyChanged(res: ToolResult): boolean | null {
  const cv = res.data?.clickVerify;
  if (typeof cv !== 'object' || cv === null) return null;
  const changed = (cv as Record<string, unknown>).changed;
  return typeof changed === 'boolean' ? changed : null;
}

function cachedHitResult(query: string, hit: GroundCacheHit, cache: GroundCache): ToolResult {
  return {
    ok: true,
    summary: `[坐标缓存] 复用定位 "${query}" 中心${fmtCoordAgent(hit.center.x, hit.center.y)} 尺寸 ${hit.box.w}x${hit.box.h}（源 ${hit.source}，${hit.stepsAgo} 步前帧稳定）。请直接 mouse_click 中心坐标（双击 times=2）｜${cache.statsLine()}`,
    data: { matches: [{ name: query, ...hit.box }] },
  };
}

/**
 * 执行器包装：在 grounding 降级链前查表、成功后记表；点击后结算自愈。
 * 只短路 ui_locate 的「定位」一步；点击守卫/点击后校验/审批分级全部沿用真实执行链。
 * 保守策略：source==='uia' 的命中永远先跑实时链（UIA 可解析时必给新鲜 rect），
 * 缓存只在整条实时链失败（UIA 完全不可用）时兜底；source==='grounding' 的命中
 * （UIA 本就指望不上的场景）在局部外观复核 + 点击验证通过后直接短路省掉降级链。
 */
export function wrapExecutorWithGroundCache(executor: ToolExecutor, cache: GroundCache): ToolExecutor {
  return {
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const isClick = name === 'mouse_click' || (name === 'ui_locate' && args.click === true);
      if (isClick) {
        const r = await executor.execute(name, args);
        cache.settlePendingClick(clickVerifyChanged(r));
        return r;
      }
      const query = name === 'ui_locate' ? String(args.query ?? '').trim() : '';
      if (!query) return executor.execute(name, args);
      const hit = await cache.lookup(query);
      if (hit) {
        if (hit.source === 'uia') {
          // UIA 可用时永远先查 UIA：实时链成功即用实时 rect 并刷新表，缓存只作兜底
          const fresh = await executor.execute(name, args);
          if (fresh.ok) {
            const box = extractFirstBox(fresh);
            if (box) await cache.record(query, box, sourceFromSummary(fresh.summary));
            return fresh;
          }
        } else {
          return cachedHitResult(query, hit, cache);
        }
        return cachedHitResult(query, hit, cache); // uia 实时链整体失败 → 缓存兜底
      }
      const res = await executor.execute(name, args);
      if (res.ok) {
        const box = extractFirstBox(res);
        if (box) await cache.record(query, box, sourceFromSummary(res.summary));
      }
      return res;
    },
  };
}
