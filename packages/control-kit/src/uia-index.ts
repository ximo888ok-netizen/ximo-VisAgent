// 窗口元素索引客户端：indexWindow（选中/判定目标 → 精准 UIA 元素索引）与 resolveRefs（#ref 点击前重解析）。
// 侧车协议见 native/uia-sidecar-cs/src/Actions/IndexWindowActions.cs 顶部注释（字段正源）。
// 降级契约（硬要求）：侧车不可用/重启预算耗尽/超时/坏报文 → { ok:false, reason }，绝不抛错——
// 上层（工具面同事）按 reason 降级视觉定位；executor.ts 等不在本次改动范围。
import { getUiaClient, withSelfPid } from './uia-client';

// ---------- 类型（与 C# 输出一一对应；缺字段有默认值，见下方解析助手） ----------

export interface IndexRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IndexCenter {
  x: number;
  y: number;
}

export interface IndexPatterns {
  invoke: boolean;
  toggle: boolean;
  scroll: boolean;
  selectionItem: boolean;
  expandCollapse: boolean;
  /** TogglePattern：0=Off 1=On 2=Indeterminate */
  toggleState?: number;
  /** ValuePattern 当前值（密码框侧车已屏蔽；>120 字符截断） */
  value?: string;
  /** SelectionItemPattern.IsSelected */
  selected?: boolean;
  /** ExpandCollapsePattern：true=展开 false=收起（部分展开等中间态省略） */
  expanded?: boolean;
  rangeValue?: { min: number; max: number; value: number };
}

/** 单个元素索引。ref 为响应内全局稳定序号（模型用它寻址）；rect 为物理像素（与截图同坐标系） */
export interface IndexedElement {
  ref: number;
  /** UIA RuntimeId 归一化字符串（"a,b,…"），resolveRefs 跨调用重解析凭据 */
  runtimeId: string;
  name: string;
  /** 短控件类型名（"Button"，已去 ControlType. 前缀） */
  controlType: string;
  className: string;
  automationId: string;
  rect?: IndexRect;
  center?: IndexCenter;
  enabled: boolean;
  offscreen: boolean;
  /** HasKeyboardFocus */
  focused: boolean;
  /** IsKeyboardFocusable */
  focusable: boolean;
  patterns: IndexPatterns;
  /** 祖先链可读路径（"窗口/工具栏/另存为"，≤6 段，无名层用控件类型占位） */
  path: string;
}

export interface IndexedWindow {
  hwnd: number;
  title: string;
  className: string;
  pid: number;
  elements: IndexedElement[];
}

export interface IndexWindowOptions {
  /** 按进程索引其全部可见顶层窗口（与 hwnd 二选一；都不给 → 前台窗口） */
  pid?: number;
  /** 只索引单个窗口 */
  hwnd?: number;
  /** 响应元素上限（侧车钳制 50-2000，默认 800；多窗口共享预算） */
  maxNodes?: number;
  /** 额外排除的 pid；宿主进程 pid 由客户端恒注入，侧车再内置排除自身 pid */
  excludePids?: number[];
}

export interface IndexWindowResult {
  ok: boolean;
  /** 结构指纹（SHA1）：同参数下 signature 不变 = 界面结构未变，可跳过增量刷新 */
  signature?: string;
  windows?: IndexedWindow[];
  /** 达到 maxNodes/访问预算，列表不完整 */
  truncated?: boolean;
  /** 侧车索引耗时（不含 RPC 往返） */
  ms?: number;
  /** ok:false 时的降级依据（sidecar 不可用/超时/侧车错误帧） */
  reason?: string;
}

export interface ResolveRefItem {
  /** 元素所在窗口（缩小重扫范围，建议总是带上） */
  hwnd?: number;
  runtimeId: string;
}

export interface ResolvedRef {
  runtimeId: string;
  /** false = 元素已消失/失效：调用方必须降级（重扫或视觉定位），不得复用旧坐标 */
  ok: boolean;
  rect?: IndexRect;
  center?: IndexCenter;
  enabled?: boolean;
  offscreen?: boolean;
}

export interface ResolveRefsResult {
  ok: boolean;
  resolved?: ResolvedRef[];
  reason?: string;
}

/** 传输抽象：UiaClient 结构上即满足（超时/重启预算在其内）；单测注入假侧车报文 */
export interface UiaTransport {
  readonly healthy: boolean;
  readonly degraded: boolean;
  start(): Promise<void>;
  request(method: string, payload: Record<string, unknown>): Promise<string>;
}

// ---------- 解析助手（防御式：坏字段回默认值，不信任侧车形状） ----------

type Rec = Record<string, unknown>;

function parseRecord(raw: string): Rec | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Rec) : null;
  } catch {
    return null;
  }
}

function str(o: Rec, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

function num(o: Rec, key: string): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function flag(o: Rec, key: string): boolean {
  return o[key] === true;
}

function sub(o: Rec, key: string): Rec {
  const v = o[key];
  return typeof v === 'object' && v !== null ? (v as Rec) : {};
}

function listOf(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter((v): v is Rec => typeof v === 'object' && v !== null) : [];
}

function rectOf(o: Rec): IndexRect | undefined {
  if (typeof o.rect !== 'object' || o.rect === null) return undefined;
  const r = o.rect as Rec;
  return { x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'w'), h: num(r, 'h') };
}

function centerOf(o: Rec): IndexCenter | undefined {
  if (typeof o.center !== 'object' || o.center === null) return undefined;
  const c = o.center as Rec;
  return { x: num(c, 'x'), y: num(c, 'y') };
}

function patternsOf(e: Rec): IndexPatterns {
  const p = sub(e, 'patterns');
  const out: IndexPatterns = {
    invoke: flag(p, 'invoke'),
    toggle: flag(p, 'toggle'),
    scroll: flag(p, 'scroll'),
    selectionItem: flag(p, 'selectionItem'),
    expandCollapse: flag(p, 'expandCollapse'),
  };
  if (typeof p.toggleState === 'number') out.toggleState = p.toggleState;
  if (typeof p.value === 'string' && p.value.length > 0) out.value = p.value;
  if (typeof p.selected === 'boolean') out.selected = p.selected;
  if (typeof p.expanded === 'boolean') out.expanded = p.expanded;
  if (typeof p.rangeValue === 'object' && p.rangeValue !== null) {
    const rv = p.rangeValue as Rec;
    out.rangeValue = { min: num(rv, 'min'), max: num(rv, 'max'), value: num(rv, 'value') };
  }
  return out;
}

function elementOf(e: Rec): IndexedElement {
  const out: IndexedElement = {
    ref: num(e, 'ref'),
    runtimeId: str(e, 'runtimeId'),
    name: str(e, 'name'),
    controlType: str(e, 'controlType'),
    className: str(e, 'className'),
    automationId: str(e, 'automationId'),
    enabled: e.enabled !== false,
    offscreen: flag(e, 'offscreen'),
    focused: flag(e, 'focused'),
    focusable: flag(e, 'focusable'),
    patterns: patternsOf(e),
    path: str(e, 'path'),
  };
  const rect = rectOf(e);
  if (rect) out.rect = rect;
  const center = centerOf(e);
  if (center) out.center = center;
  return out;
}

function windowOf(w: Rec): IndexedWindow {
  return {
    hwnd: num(w, 'hwnd'),
    title: str(w, 'title'),
    className: str(w, 'className'),
    pid: num(w, 'pid'),
    elements: listOf(w.elements).map(elementOf),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'sidecar call failed';
}

type SidecarCall = { error: string } | { rec: Rec };

/** 统一前置：降级短路 → start → 发请求 → 解 JSON；失败路径全部收敛为 { ok:false, reason } */
async function callSidecar(
  client: UiaTransport,
  method: string,
  payload: Record<string, unknown>,
): Promise<SidecarCall> {
  if (client.degraded) return { error: 'uia-degraded' };
  try {
    if (!client.healthy) await client.start();
    const raw = await client.request(method, payload);
    const parsed = parseRecord(raw);
    if (!parsed) return { error: 'sidecar-bad-json' };
    return { rec: parsed };
  } catch (err) {
    return { error: errText(err) };
  }
}

// ---------- 对外封装 ----------

/**
 * 建窗口元素索引：pid（该进程全部可见顶层窗口）/ hwnd（单窗口）/ 都缺省（前台窗口）三选一。
 * excludePids 会自动并入本进程 pid（自我污染防线，侧车内部再排除侧车自身 pid）。
 */
export async function indexWindow(
  opts: IndexWindowOptions = {},
  client: UiaTransport = getUiaClient(),
): Promise<IndexWindowResult> {
  const payload: Record<string, unknown> = { excludePids: withSelfPid(opts.excludePids) };
  if (opts.pid !== undefined) payload.pid = opts.pid;
  if (opts.hwnd !== undefined) payload.hwnd = opts.hwnd;
  if (opts.maxNodes !== undefined) payload.maxNodes = opts.maxNodes;
  const res = await callSidecar(client, 'indexWindow', payload);
  if ('error' in res) return { ok: false, reason: res.error };
  const ok = res.rec;
  if (ok.ok !== true) return { ok: false, reason: str(ok, 'error') || 'sidecar-error' };
  return {
    ok: true,
    signature: str(ok, 'signature'),
    windows: listOf(ok.windows).map(windowOf),
    truncated: ok.truncated === true,
    ms: typeof ok.ms === 'number' ? ok.ms : undefined,
  };
}

/**
 * 执行前重解析：按 runtimeId 拿"当前"矩形（元素移动/消失时 ok:false，调用方必须降级）。
 * 缓存不能骗人——这条是 #ref 点击链路的地基，配合 indexWindow 的 ref→runtimeId 映射使用。
 * 重解析作用域 = 传入的 hwnd（建议总是带上）；缺省回落到索引时记录的来源窗口；
 * 完全未知（从未索引过）直接 ok:false，不会做全桌面扫描。
 */
export async function resolveRefs(
  items: ResolveRefItem[],
  client: UiaTransport = getUiaClient(),
): Promise<ResolveRefsResult> {
  if (items.length === 0) return { ok: false, reason: 'empty-items' };
  const wire = items.map((it) => {
    const rec: Record<string, unknown> = { runtimeId: it.runtimeId };
    if (it.hwnd !== undefined) rec.hwnd = it.hwnd;
    return rec;
  });
  const res = await callSidecar(client, 'resolveRefs', { items: wire });
  if ('error' in res) return { ok: false, reason: res.error };
  const ok = res.rec;
  if (ok.ok !== true) return { ok: false, reason: str(ok, 'error') || 'sidecar-error' };
  const resolved: ResolvedRef[] = listOf(ok.resolved).map((r) => {
    const out: ResolvedRef = { runtimeId: str(r, 'runtimeId'), ok: r.ok === true };
    if (out.ok) {
      const rect = rectOf(r);
      if (rect) out.rect = rect;
      const center = centerOf(r);
      if (center) out.center = center;
      if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
      if (typeof r.offscreen === 'boolean') out.offscreen = r.offscreen;
    }
    return out;
  });
  return { ok: true, resolved };
}
