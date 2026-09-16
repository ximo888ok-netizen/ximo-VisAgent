/**
 * recovery-signature.ts — 从轨迹里提炼恢复规则（纯函数，零 IO）
 *
 * 为什么需要它：恢复规则的读取侧（orchestrator-recovery 的 matcher）早就接进了循环，
 * 但写入侧一个生产调用方都没有 —— 于是同一个目标连跑 N 次都走完全相同的错路，
 * 「重复撞墙直到止损」被误当成「吸取教训」。
 *
 * 口径纪律（三条，缺一不可）：
 * 1. 只产出 matcher 读得到的字段（见 RecoveryDetectSpec / RecoveryActionSpec），
 *    写进去读不出来的特征等于没写；
 * 2. 触发特征必须是「同特征至少 REPEAT_THRESHOLD 次」的重复失败，不是单次偶发错误；
 * 3. 对策必须是轨迹里**实际发生过的下一步成功动作**（或错误文本里明确点名的处置），
 *    编不出对策就不产规则——宁缺毋滥，否则规则库会污染成「什么都提示」。
 */
import type { StepDetail } from '@ximo-visagent/agent-core';

/** 同特征重复多少次才算「值得记一笔」 */
export const REPEAT_THRESHOLD = 2;
/** detect 各字段的长度封顶（防规则膨胀成不可读的长正则） */
const ERROR_PATTERN_MAX = 160;
const NAME_MAX = 90;

/**
 * 触发特征。字段名与 orchestrator-recovery.ts 的解析口径一一对应：
 * - lastTool：失败的那一步用的工具；
 * - errorPattern：错误摘要的正则（编译不过时按子串兜底）；
 * - windowTitlePattern：前台窗口标题特征；
 * - argPattern：参数形态特征（宿主用 stableArgsJson 还原失败步的键集合再比对）。
 */
export interface RecoveryDetectSpec {
  lastTool?: string;
  errorPattern?: string;
  windowTitlePattern?: string;
  argPattern?: string;
}

/** 有效对策。action 必须是真实工具名，matcher 只在它非空时才产出提示 */
export interface RecoveryActionSpec {
  action: string;
  args?: Record<string, unknown>;
}

/** 一步的可提炼视图（live 事件流与终态 stepsDetail 都归一到这里） */
export interface TraceStep {
  index: number;
  tool: string | null;
  args?: Record<string, unknown> | null;
  ok: boolean;
  /** 失败时的错误摘要（不含「失败: 」前缀） */
  error?: string;
}

export interface RuleEvidence {
  step: number;
  tool: string;
  error: string;
  remedy: string;
}

/** 提炼产物（尚未落库、尚未过宪法门） */
export interface RuleCandidate {
  name: string;
  detect: RecoveryDetectSpec;
  action: RecoveryActionSpec;
  /** 去重合并键：同特征再撞一次就 bump 这条已有规则，而不是新建第二行 */
  signature: string;
  occurrences: number;
  evidence: RuleEvidence[];
}

/** 循环里的 resultSummary 形如「失败: xxx」；matcher 拿到的是去掉前缀的 error */
export function stripFailurePrefix(text: string): string {
  return text.replace(/^失败:\s*/, '').trim();
}

export function toTraceStep(step: StepDetail): TraceStep {
  return {
    index: step.index,
    tool: step.actionName ?? null,
    args: step.args ?? null,
    ok: step.ok !== false,
    error: step.ok === false ? stripFailurePrefix(step.resultSummary ?? '') : undefined,
  };
}

/** 递归按键排序的 JSON 序列化：参数形态指纹与 argPattern 共用同一口径 */
export function stableArgsJson(args: Record<string, unknown> | null | undefined): string {
  if (!args) return '';
  try {
    return JSON.stringify(canonical(args)) ?? '';
  } catch {
    return '';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonical(src[key]);
    return out;
  }
  return value;
}

/** 参数形态 = 失败步参数里出现过的顶层键集合（只认键，不认值：值随任务变，键才是可复用的特征） */
export function argShapeKeys(args: Record<string, unknown> | null | undefined): string[] {
  if (!args) return [];
  return Object.keys(args).sort().slice(0, 4);
}

/** 转义字面量并做有限泛化（数字串 → \d+），让 pattern 能跨任务复用 */
function generalizeLiteral(text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\d+/g, '\\d+');
}

/** 取错误文本的第一分句（到第一个标点为止）作为可复用特征 */
function errorClause(error: string): string {
  const head = error.split(/[，。；,;\n]/)[0]?.trim() ?? '';
  return head.slice(0, 60);
}

/** 同簇错误特征的并集（最多 3 条分句，封顶长度；只差数字的分句合并为一条） */
function buildErrorPattern(errors: string[]): string {
  const clauses: string[] = [];
  for (const e of errors) {
    const head = errorClause(e);
    const generalized = head ? generalizeLiteral(head) : '';
    if (generalized && !clauses.includes(generalized)) clauses.push(generalized);
    if (clauses.length >= 3) break;
  }
  return clauses.join('|').slice(0, ERROR_PATTERN_MAX);
}

/** 参数形态特征：stableArgsJson 按键排序，因此按键序用 [^{}]* 串联即可稳定命中同一个对象的键集合 */
function buildArgPattern(keys: string[]): string {
  if (keys.length === 0) return '';
  return keys.map((k) => generalizeLiteral(`"${k}"`)).join('[^{}]*').slice(0, ERROR_PATTERN_MAX);
}

/** 失败簇：同一「工具 + 参数形态」上反复出现的无效动作 */
interface FailureCluster {
  tool: string;
  argKeys: string[];
  steps: TraceStep[];
}

function clusterKey(tool: string, args: Record<string, unknown> | null | undefined): string {
  return `${tool}|${argShapeKeys(args).join(',')}`;
}

/** 按「工具 + 参数形态」聚簇（只统计失败步），返回达到重复阈值的簇 */
export function failureClusters(steps: TraceStep[], minCount = REPEAT_THRESHOLD): FailureCluster[] {
  const byKey = new Map<string, FailureCluster>();
  for (const s of steps) {
    if (s.ok || !s.tool || !s.error) continue;
    const key = clusterKey(s.tool, s.args ?? null);
    const hit = byKey.get(key);
    if (hit) hit.steps.push(s);
    else byKey.set(key, { tool: s.tool, argKeys: argShapeKeys(s.args ?? null), steps: [s] });
  }
  return [...byKey.values()].filter((c) => c.steps.length >= minCount);
}

/**
 * 对策从证据里来：簇末之后第一个「换了工具且成功」的动作。
 * 找不到就返回 null —— 不编造处置方案。
 */
function findRemedy(steps: TraceStep[], cluster: FailureCluster): TraceStep | null {
  const lastFailedIndex = Math.max(...cluster.steps.map((s) => s.index));
  for (const s of steps) {
    if (s.index <= lastFailedIndex) continue;
    if (s.ok && s.tool && s.tool !== cluster.tool) return s;
  }
  return null;
}

export function signatureOf(detect: RecoveryDetectSpec): string {
  return [detect.lastTool ?? '', detect.errorPattern ?? '', detect.windowTitlePattern ?? '', detect.argPattern ?? ''].join('|').slice(0, 200);
}

/** 轨迹 → 候选规则（按重复次数降序，同签名只留一条） */
export function mineCandidates(steps: TraceStep[], minCount = REPEAT_THRESHOLD): RuleCandidate[] {
  const usable = steps.filter((s) => Number.isFinite(s.index));
  const out: RuleCandidate[] = [];
  const seen = new Set<string>();
  for (const cluster of failureClusters(usable, minCount).sort((a, b) => b.steps.length - a.steps.length)) {
    const remedyTool = findRemedy(usable, cluster)?.tool ?? '';
    if (!remedyTool) continue;
    const detect: RecoveryDetectSpec = {
      lastTool: cluster.tool,
      errorPattern: buildErrorPattern(cluster.steps.map((s) => s.error ?? '')) || undefined,
      argPattern: buildArgPattern(cluster.argKeys) || undefined,
    };
    if (!detect.errorPattern) continue;
    const signature = signatureOf(detect);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    const action: RecoveryActionSpec = { action: remedyTool };
    out.push({
      name: `${cluster.tool} 连败 ${cluster.steps.length} 次 → 换 ${remedyTool}`.slice(0, NAME_MAX),
      detect,
      action,
      signature,
      occurrences: cluster.steps.length,
      evidence: cluster.steps.slice(0, 3).map((s) => ({
        step: s.index,
        tool: s.tool ?? '',
        error: (s.error ?? '').slice(0, 160),
        remedy: remedyTool,
      })),
    });
  }
  return out;
}
