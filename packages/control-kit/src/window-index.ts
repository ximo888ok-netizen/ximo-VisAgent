// 窗口元素索引存储与生命周期（第二步：侧车索引 → 模型可按 #ref 直接寻址）。
// 定位优先级（硬约定）：有新鲜索引时**索引优先**——ui_click(ref) 每次执行前经 resolveRefs
// 重解析当前 rect，元素移动/销毁即失效；agent-core 的 ground-cache 坐标表只作 UIA（侧车）
// 完全不可用时的兜底，二者互不覆盖：索引失效信号只触发索引重建，不写坐标表。
// 成本红线（真机实测）：记事本 25 元素热 12ms，但资源管理器 8 窗口 323 元素热约 1.5s/冷 2.2s
// ——索引**绝不能每步重建**，只在信号到来时重建（needsRebuild 的 6 个信号，见下）。
// 缓存 keyed by hwnd + 响应级 signature 判等；单一活跃索引集：一次 indexWindow 响应
// （一个 pid/hwnd 目标及其全部窗口）即当前集合，切换目标即整集替换——保证 #ref 全局唯一。
import { windowMatches } from './ui-locate';
import { fmtCoord } from './coord-normalize';
import {
  indexWindow,
  resolveRefs,
  type IndexedElement,
  type IndexWindowOptions,
  type IndexWindowResult,
  type ResolveRefItem,
  type ResolveRefsResult,
} from './uia-index';

/** 每步摘要的元素上限（与旧「可交互元素清单」同口径；精查是 ui_index{filter} 的职责） */
export const DEFAULT_SUMMARY_LIMIT = 40;
/** TTL（步数）：超期强制重建——远宽于坐标缓存的 8 步，因为索引带 signature 判等，重建更廉价 */
const TTL_STEPS = 12;
/** 名称展示截断（与旧清单一致：够认即可，长标题烧 token） */
const NAME_MAX = 16;
/** 窗口标签截断 */
const WIN_MAX = 14;
/** 画面变化阈值：与 agent-core loop-helpers.isScreenChanged 同口径（分块指纹汉明距离 >6 才算变了） */
const SCREEN_CHANGE_MIN_BITS = 6;

export interface WindowRef { hwnd: number; title: string; pid: number }

export interface WindowIndexDeps {
  index?: (opts: IndexWindowOptions) => Promise<IndexWindowResult>;
  resolve?: (items: ResolveRefItem[]) => Promise<ResolveRefsResult>;
  /** 可见窗口枚举（新窗口/对话框信号与 ui_index{window} 标题解析用；本地 FFI 轻量）。
   *  缺省 = 不做新窗口检测、标题只能匹配已索引窗口 */
  listWindows?: () => Promise<WindowRef[]>;
}

interface StoredWindow {
  hwnd: number;
  title: string;
  className: string;
  pid: number;
  builtStep: number;
  elements: IndexedElement[];
}

export interface IndexBuildOutcome {
  ok: boolean;
  reason?: string;
  added: number;
  removed: number;
  signatureChanged: boolean;
  windows: number;
  elements: number;
  truncated: boolean;
  ms?: number;
}

export interface RefTarget {
  el: IndexedElement;
  winTitle: string;
  hwnd: number;
}

/** resolveForClick 结论：ok=true 带"当前"中心；失败原因供工具话术——调用方不得拿旧坐标硬点 */
export interface RefResolveOutcome {
  ok: boolean;
  why?: string;
  el?: IndexedElement;
  winTitle?: string;
  center?: { x: number; y: number };
  rect?: { x: number; y: number; w: number; h: number };
}

export interface FrameInfo {
  foreground?: { title: string; className?: string } | null;
  signature?: string;
}

interface Counters {
  builds: number;
  buildFailures: number;
  rebuildSignals: number;
  hits: number;
  refFailures: number;
  refClicks: number;
  blindClicks: number;
}

/** 写动作集：做过这些才可能改变界面（"上一步是写动作且画面有变"信号的左半边） */
const WRITE_ACTIONS = new Set([
  'mouse_click', 'ui_click', 'keyboard_type', 'keyboard_press', 'mouse_drag',
  'mouse_drag_hold', 'mouse_hold', 'mouse_scroll', 'ui_scroll_to',
  'open_app', 'activate_window', 'set_clipboard',
]);

function frameChangedBySig(prev: string | undefined, next: string | undefined): boolean {
  if (!next || !prev) return false;
  if (prev.length === next.length && /^[01]+$/.test(prev)) {
    let d = 0;
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) d++;
    return d > SCREEN_CHANGE_MIN_BITS;
  }
  return prev !== next;
}

export class WindowIndexStore {
  private windows = new Map<number, StoredWindow>();
  private signature = '';
  private step = 0;
  private lastSig: string | undefined;
  private lastActionWasWrite = false;
  private rebuildQueued = false;
  private primaryPids: number[] | null = null;
  private stickyHwnd: number | null = null;
  /** 最近一次失败建索的目标键：同目标不逐步重试（防空转烧超时）；成功或目标变化即解除 */
  private lastFailureKey: string | null = null;
  private truncatedFlag = false;
  private fgTitle: string | null = null;
  private pendingDelta: string | null = null;
  private lastBuildMs = 0;
  private counters: Counters = { builds: 0, buildFailures: 0, rebuildSignals: 0, hits: 0, refFailures: 0, refClicks: 0, blindClicks: 0 };
  private deps: WindowIndexDeps = {};

  configure(deps: WindowIndexDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** 任务边界：计数按任务清、步数归零（旧条目过 TTL 后自然重建）；primary 由 targetApp 决定 */
  beginTask(opts: { targetPids?: number[] } = {}): void {
    this.step = 0;
    this.lastSig = undefined;
    this.lastActionWasWrite = false;
    this.rebuildQueued = false;
    this.lastFailureKey = null;
    this.pendingDelta = null;
    this.counters = { builds: 0, buildFailures: 0, rebuildSignals: 0, hits: 0, refFailures: 0, refClicks: 0, blindClicks: 0 };
    this.primaryPids = opts.targetPids && opts.targetPids.length > 0 ? [...new Set(opts.targetPids)] : null;
    this.stickyHwnd = null;
  }

  get size(): number { return this.windows.size; }

  get indexed(): boolean { return this.windows.size > 0; }

  /** 主目标（自动刷新对象）：显式 ui_index{window} 的 hwnd > targetApp pid 族 > 前台窗口 */
  private buildOptions(): IndexWindowOptions {
    if (this.stickyHwnd !== null) return { hwnd: this.stickyHwnd };
    if (this.primaryPids) return { pid: this.primaryPids[0] };
    return {};
  }

  /** 显式切目标（ui_index{window}）：成功建索引后调用，成为新的自动刷新对象 */
  adoptTarget(target: { pid?: number; hwnd?: number }): void {
    if (target.hwnd !== undefined) {
      this.stickyHwnd = target.hwnd;
      this.primaryPids = null;
    } else if (target.pid !== undefined) {
      this.primaryPids = [target.pid];
      this.stickyHwnd = null;
    }
  }

  /** 建/重建当前主目标的索引（信号驱动或工具显式）。同 signature = 界面结构未变：仍更新 */
  async build(): Promise<IndexBuildOutcome> {
    const opts = this.buildOptions();
    const index = this.deps.index ?? indexWindow;
    const res = await index(opts);
    if (!res.ok || !res.windows) {
      this.lastFailureKey = this.targetKey(opts);
      this.counters.buildFailures++;
      return { ok: false, reason: res.reason ?? 'build-failed', added: 0, removed: 0, signatureChanged: false, windows: 0, elements: 0, truncated: false };
    }
    this.lastFailureKey = null;
    const prevIds = new Set<string>();
    for (const w of this.windows.values()) for (const e of w.elements) prevIds.add(e.runtimeId);
    const nextIds = new Set<string>();
    for (const w of res.windows) for (const e of w.elements) nextIds.add(e.runtimeId);
    let added = 0;
    for (const id of nextIds) if (!prevIds.has(id)) added++;
    let removed = 0;
    for (const id of prevIds) if (!nextIds.has(id)) removed++;
    const signatureChanged = res.signature !== this.signature;
    this.windows = new Map(res.windows.map((w) => [w.hwnd, {
      hwnd: w.hwnd, title: w.title, className: w.className, pid: w.pid,
      builtStep: this.step, elements: w.elements,
    }]));
    this.signature = res.signature ?? '';
    this.truncatedFlag = res.truncated === true;
    this.lastBuildMs = res.ms ?? 0;
    this.counters.builds++;
    this.rebuildQueued = false;
    const elements = [...this.windows.values()].reduce((n, w) => n + w.elements.length, 0);
    this.pendingDelta = `+${added}/-${removed}`;
    console.log(`[window-index] build(${signatureChanged ? 'sig-changed' : 'sig-same'}) ${this.windows.size}窗口/${elements}元素 +${added}/-${removed} ${this.lastBuildMs}ms 签名${this.signature.slice(0, 8)}`);
    return { ok: true, added, removed, signatureChanged, windows: this.windows.size, elements, truncated: this.truncatedFlag, ms: this.lastBuildMs };
  }

  private targetKey(opts: IndexWindowOptions): string {
    return opts.pid !== undefined ? `pid:${opts.pid}` : opts.hwnd !== undefined ? `hwnd:${opts.hwnd}` : `fg:${this.fgTitle ?? ''}`;
  }

  /**
   * 重建信号判定（纯同步；新窗口信号需枚举、在 observeStep 里补）：
   * cold（无索引）｜ref-invalid（#ref 解析失败）｜title-changed（前台漂移，仅无锚定时）｜
   * action-effect（上一步写动作且画面有变）｜ttl（超步数）。null = 本步绝不重建。
   */
  needsRebuild(frame: FrameInfo): string | null {
    if (this.windows.size === 0) {
      const key = this.targetKey(this.buildOptions());
      return this.lastFailureKey === key ? null : 'cold';
    }
    if (this.rebuildQueued) return 'ref-invalid';
    if (this.stickyHwnd === null && this.primaryPids === null
      && frame.foreground?.title && !this.anyWindowMatches(frame.foreground.title)) return 'title-changed';
    if (this.lastActionWasWrite && frameChangedBySig(this.lastSig, frame.signature)) return 'action-effect';
    for (const w of this.windows.values()) if (this.step - w.builtStep > TTL_STEPS) return 'ttl';
    return null;
  }

  private anyWindowMatches(title: string): boolean {
    for (const w of this.windows.values()) if (windowMatches(w.title, title)) return true;
    return false;
  }

  /** 同进程族新窗口/对话框：枚举到已索引 pid 的新可见顶层窗口（无注入 = 跳过该信号） */
  private async hasFamilyNewWindow(): Promise<boolean> {
    const list = this.deps.listWindows;
    if (!list || this.windows.size === 0) return false;
    const pids = new Set([...this.windows.values()].map((w) => w.pid));
    try {
      const wins = await list();
      return wins.some((w) => pids.has(w.pid) && !this.windows.has(w.hwnd));
    } catch {
      return false;
    }
  }

  /**
   * 每步感知入口（interactive-list 调用）：步数 +1 → 信号判定 → 只在信号到来时重建。
   * 永不每步重建；重建失败保留信号（同目标失败键抑制空转，标题变化即再试）。
   */
  async observeStep(frame: FrameInfo): Promise<{ rebuilt: boolean; reason: string | null }> {
    this.step++;
    if (frame.foreground?.title) this.fgTitle = frame.foreground.title;
    let why = this.needsRebuild(frame);
    if (!why && (await this.hasFamilyNewWindow())) why = 'new-window';
    let rebuilt = false;
    if (why) {
      this.counters.rebuildSignals++;
      rebuilt = (await this.build()).ok;
      console.log(`[window-index] rebuild(${why})${rebuilt ? '' : ' 失败，暂缓重试'}`);
    }
    this.lastSig = frame.signature;
    this.lastActionWasWrite = false;
    return { rebuilt, reason: why };
  }

  /** 动作观测（executor 结果包装器调用）：写动作标记 + 目测坐标点击计数（ref 占比分母） */
  noteAction(name: string, _args: Record<string, unknown>): void {
    if (WRITE_ACTIONS.has(name)) this.lastActionWasWrite = true;
    if (name === 'mouse_click') this.counters.blindClicks++;
  }

  findRef(ref: number): RefTarget | null {
    for (const w of this.windows.values()) {
      const el = w.elements.find((e) => e.ref === ref);
      if (el) return { el, winTitle: w.title, hwnd: w.hwnd };
    }
    return null;
  }

  /** 按名称全等（忽略大小写/首尾空白）在索引里找同名元素的编号（ui_locate 命中附复用提示用） */
  refForName(name: string): number | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    for (const w of this.windows.values()) {
      const el = w.elements.find((e) => e.name.trim().toLowerCase() === n);
      if (el) return el.ref;
    }
    return undefined;
  }

  /**
   * #ref 点击前重解析（点击链路的地基）：拿"当前"rect/center/enabled/offscreen。
   * 解析失败/离屏 → 置失效信号（下步重建）并返回 why——调用方必须告诉模型刷新索引，
   * 绝不允许拿索引里的旧坐标硬点。禁用不算失效（元素还在，只是此刻点不动）。
   */
  async resolveForClick(ref: number): Promise<RefResolveOutcome> {
    const found = this.findRef(ref);
    if (!found) {
      this.counters.refFailures++;
      this.rebuildQueued = true;
      return { ok: false, why: '编号不在当前索引里（索引可能已切换或界面已变）' };
    }
    const resolve = this.deps.resolve ?? resolveRefs;
    const item: ResolveRefItem = { runtimeId: found.el.runtimeId, hwnd: found.hwnd };
    const res = await resolve([item]);
    const r = res.ok ? res.resolved?.[0] : undefined;
    if (!r || !r.ok || !r.center) {
      this.counters.refFailures++;
      this.rebuildQueued = true;
      return { ok: false, why: '元素已移动/销毁，编号失效' };
    }
    if (r.enabled === false) {
      return { ok: false, why: `「${found.el.name || found.el.controlType}」当前被禁用` };
    }
    if (r.offscreen === true) {
      this.counters.refFailures++;
      this.rebuildQueued = true;
      return { ok: false, why: `「${found.el.name || found.el.controlType}」已滚出视野/离屏` };
    }
    this.counters.hits++;
    const out: RefResolveOutcome = { ok: true, el: found.el, center: r.center, winTitle: found.winTitle };
    if (r.rect) out.rect = r.rect;
    return out;
  }

  noteRefClick(): void { this.counters.refClicks++; }

  /** 外部失效信号（看门狗恢复等）：下步 observeStep 强制重建 */
  invalidate(reason: string): void {
    this.rebuildQueued = true;
    console.log(`[window-index] invalidate(${reason})`);
  }

  /** 单行元素摘要（每步清单与 ui_index 输出共用）：`#7 名称 (类型) @(x,y) [态] [窗口:xxx]` */
  formatLine(el: IndexedElement, winTitle?: string): string {
    const name = (el.name || `(${el.controlType})`).slice(0, NAME_MAX);
    const pos = el.center ? ` @${fmtCoord(el.center.x, el.center.y)}` : '';
    const tags: string[] = [];
    if (!el.enabled) tags.push('禁用');
    if (el.offscreen) tags.push('离屏');
    else if (el.patterns.invoke || el.patterns.toggle || el.patterns.expandCollapse) tags.push('可点击');
    if (el.patterns.selected === true) tags.push('已选中');
    if (el.patterns.expanded === true) tags.push('展开');
    else if (el.patterns.expanded === false && el.patterns.expandCollapse) tags.push('收起');
    const tag = tags.length > 0 ? ` [${tags.join('][')}]` : '';
    const win = winTitle ? ` [窗口:${winTitle.slice(0, WIN_MAX)}]` : '';
    return `#${el.ref} ${name} (${el.controlType})${pos}${tag}${win}`;
  }

  /** 每步感知摘要（旧「可交互元素清单」升级版）：#ref + 状态 + 刷新 delta；
   *  无索引/无可视元素 → undefined（保留"UIA 降级整段省略"行为，绝不输出空清单） */
  formatSummary(limit = DEFAULT_SUMMARY_LIMIT): string | undefined {
    if (this.windows.size === 0) return undefined;
    const ordered = [...this.windows.values()].sort((a, b) => {
      const am = this.fgTitle && windowMatches(a.title, this.fgTitle) ? 0 : 1;
      const bm = this.fgTitle && windowMatches(b.title, this.fgTitle) ? 0 : 1;
      return am - bm;
    });
    const multi = ordered.length > 1;
    const picked: { el: IndexedElement; win: StoredWindow }[] = [];
    let total = 0;
    for (const w of ordered) {
      for (const e of w.elements) {
        if (!e.center || e.offscreen) continue;
        total++;
        if (picked.length < limit) picked.push({ el: e, win: w });
      }
    }
    if (picked.length === 0) return undefined;
    const head = ordered[0];
    if (!head) return undefined;
    const age = this.step - head.builtStep;
    const scope = total > picked.length ? `共 ${total} 可见，列前 ${picked.length} 个` : `共 ${total} 个`;
    const lines = picked.map(({ el, win }) => this.formatLine(el, multi ? win.title : undefined));
    const tail: string[] = [`窗口索引[${(head.title || this.fgTitle || '').slice(0, 24)}]（${scope}${multi ? `，${ordered.length}窗口` : ''}${this.truncatedFlag ? '，已截断' : ''}，${age}步前）：`, ...lines];
    if (total > picked.length) tail.push(`…其余未列；ui_index{filter:"关键词"} 检索`);
    tail.push('点击用 ui_click(ref:#编号)，别目测坐标');
    if (this.pendingDelta && this.pendingDelta !== '+0/-0') tail.push(`索引已刷新 ${this.pendingDelta}`);
    this.pendingDelta = null;
    return tail.join('\n');
  }

  /** ui_index{filter}：按名称/路径/类型/类名/automationId 子串检索已建索引；
   *  子串零命中回退字符集宽松匹配（与 ui-locate.nameRelevance 同思路，不新造拼音依赖） */
  filterEntries(query: string, limit = DEFAULT_SUMMARY_LIMIT): RefTarget[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all: RefTarget[] = [];
    for (const w of this.windows.values()) for (const e of w.elements) all.push({ el: e, winTitle: w.title, hwnd: w.hwnd });
    const exact = all.filter((t) =>
      `${t.el.name}/${t.el.path}/${t.el.controlType}/${t.el.className}/${t.el.automationId}`.toLowerCase().includes(q));
    if (exact.length > 0) return exact.slice(0, limit);
    const qc = new Set(q);
    return all
      .filter((t) => [...`${t.el.name}${t.el.path}`.toLowerCase()].some((ch) => qc.has(ch)))
      .slice(0, limit);
  }

  describeWindows(): { title: string; elements: number; ageSteps: number }[] {
    return [...this.windows.values()].map((w) => ({
      title: w.title || `hwnd ${w.hwnd}`,
      elements: w.elements.length,
      ageSteps: this.step - w.builtStep,
    }));
  }

  /** ui_index{window} 参数解析：数字串按 pid；否则先匹配已索引窗口标题，再枚举可见窗口标题子串 */
  async resolveWindowQuery(raw: string): Promise<{ pid?: number; hwnd?: number; title?: string; candidates?: string[] }> {
    const s = raw.trim();
    if (!s) return {};
    if (/^\d+$/.test(s)) return { pid: Number(s) };
    const inSet = [...this.windows.values()].find((w) => windowMatches(w.title, s));
    if (inSet) return { hwnd: inSet.hwnd, title: inSet.title };
    if (this.deps.listWindows) {
      try {
        const wins = await this.deps.listWindows();
        const hit = wins.find((w) => w.title.toLowerCase().includes(s.toLowerCase()));
        if (hit) return { hwnd: hit.hwnd, title: hit.title };
        return { candidates: wins.slice(0, 8).map((w) => w.title) };
      } catch { /* 枚举失败按未找到 */ }
    }
    return { candidates: this.describeWindows().map((w) => w.title) };
  }

  /** 为指定目标建索引（ui_index{window}）：先采纳为主目标再建，成功后自动刷新对象随之切换 */
  async buildFor(target: { pid?: number; hwnd?: number }): Promise<IndexBuildOutcome> {
    this.adoptTarget(target);
    return this.build();
  }

  statsLine(): string {
    const c = this.counters;
    return `索引 建${c.builds} 信号${c.rebuildSignals} 失效${c.refFailures} 命中${c.hits} 表${this.windows.size}窗 末次${this.lastBuildMs}ms`;
  }

  /** 任务终态占比（判断本功能有没有用的关键指标；orchestrator-launch 落日志/审计） */
  taskStatsLine(): string {
    const c = this.counters;
    const clickTotal = c.refClicks + c.blindClicks;
    const refPct = clickTotal === 0 ? '-' : `${Math.round((c.refClicks / clickTotal) * 100)}%`;
    return `索引 建${c.builds}次(${c.buildFailures}败) 信号${c.rebuildSignals} ref失效${c.refFailures}；点击 ref${c.refClicks}/目测${c.blindClicks} ref占比${refPct}`;
  }
}

let store: WindowIndexStore | null = null;

export function getWindowIndex(): WindowIndexStore {
  if (!store) store = new WindowIndexStore();
  return store;
}

export function configureWindowIndexDeps(deps: WindowIndexDeps): void {
  getWindowIndex().configure(deps);
}

/** 单测隔离用：销毁单例（下一个 getWindowIndex 全新构建）。生产装配不走这里 */
export function resetWindowIndex(): void {
  store = null;
}
