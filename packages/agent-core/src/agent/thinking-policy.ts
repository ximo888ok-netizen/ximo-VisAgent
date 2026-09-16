// 按步思考预算（auto 档）：客观信号地板规则 + 上一步模型自请，共同决定「本步开不开思考」。
// 判据全部收在本文件（纯函数可单测）；loop 只做接线，供应商只做参数映射。
import type { ThinkingMode } from '@ximo-visagent/shared-types';
import type { AgentEvent, StepDetail } from './types';

// ---------- 模型自请：复用既有 thought 通道，工具表与执行器零改动 ----------

/** 自请标记：模型在 thought 里写 [需思考]（或 [think]）= 声明「下一步需要认真想」。
 *  先有鸡还是先有蛋：本步请求影响的是下一步，故本模块记录后延后一步消费，且只生效一步（不粘滞）。 */
const THINK_REQUEST = /[［[]\s*(?:需思考|需要思考|要思考|next[_\s-]?think|need[_\s-]?think|thinking|think)\s*[］\]]/i;

/** 从 thought 中取出自请标记并清理正文（协议无关：function calling 的 content 与内联 JSON 的 thought 都走这里） */
export function extractThinkRequest(text: string): { text: string; ask: boolean } {
  if (!THINK_REQUEST.test(text)) return { text, ask: false };
  return { text: text.replace(new RegExp(THINK_REQUEST.source, 'gi'), ' ').replace(/\s{2,}/g, ' ').trim(), ask: true };
}

// ---------- 地板规则（模型完全不使用自请也能触发） ----------

/** ui_locate 多候选 = 目标有歧义，正是该停下来想的时候（"找到N个:" 由 control-kit 回报） */
const AMBIGUOUS_LOCATE = /找到\s*(?:[2-9]|[1-9]\d{1,})\s*个/;

/** loop 干预类步骤事件的 thought 前缀 → 思考原因（停滞/熔断/纠正/收尾/查证/经验/里程碑） */
const INTERVENTION_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: '[死局预警]', reason: '熔断预警' },
  { prefix: '[停滞纠正]', reason: '停滞提示' },
  { prefix: '[效率纠正]', reason: '重复纠正' },
  { prefix: '[收尾提醒]', reason: '收尾对账' },
  { prefix: '[查证提示]', reason: '不确定提示' },
  { prefix: '[常识补发]', reason: '困境补常识' },
  { prefix: '[经验恢复]', reason: '历史经验' },
  { prefix: '[里程碑]', reason: '里程碑审计' },
  { prefix: '[断言]', reason: '断言未过' },
  { prefix: '[验收]', reason: '验收打回' },
];

/** 干预类提示已出现（loop 每次注入纠正都会发一条 step 事件，前缀即原因） */
export function interventionReason(thought: string): string | null {
  const hit = INTERVENTION_PREFIXES.find((p) => thought.startsWith(p.prefix));
  return hit ? hit.reason : null;
}

/** 批执行中断批：同一步号出现多条动作明细且最后一条失败 = 剩余动作没执行，方案已不成立 */
export function interruptedBatch(trail: readonly StepDetail[]): boolean {
  const last = trail.at(-1);
  if (!last || last.ok !== false || !last.actionName) return false;
  const prev = trail.at(-2);
  return prev !== undefined && prev.index === last.index && prev.actionName != null;
}

/** ui_locate 返回多候选（歧义）：只看最近两次定位结果 */
export function ambiguousLocate(trail: readonly StepDetail[]): boolean {
  return trail.slice(-2).some((s) => s.actionName === 'ui_locate' && AMBIGUOUS_LOCATE.test(s.resultSummary));
}

export interface ThinkSignals {
  /** 用户策略档：非 auto 时本模块不表态（沿用旧四档语义，老配置零回归） */
  mode: ThinkingMode | undefined;
  step: number;
  recentFailures: number;
  noChangeCount: number;
  /** 已有步骤明细（失败/审批/歧义/断批等信号从中派生，loop 无需额外维护） */
  trail: readonly StepDetail[];
  /** 上一步出现的干预/异常/审批事件原因（由 ThinkingBudget.observe 采集） */
  interventions: readonly string[];
  /** 上一步模型自请 */
  modelAsk: boolean;
  /** 本任务由规划器产出过多子任务计划（首步该想清楚怎么落地） */
  planned: boolean;
}

export interface ThinkingDecision {
  think: boolean;
  reason: string;
}

/** 地板规则：命中任一 → 该步强制思考。顺序即原因优先级（越靠前越硬）。 */
export function floorReason(s: ThinkSignals): string | null {
  const last = s.trail.at(-1);
  if (s.step <= 1) return s.planned ? '规划产出' : '首步';
  // 断批也是失败，但归因不同：剩余动作没执行 = 方案整体不成立，比单点失败更该停下来想
  if (interruptedBatch(s.trail)) return '批执行中断';
  if (last?.ok === false) return '上一步失败';
  if (last?.level !== undefined && last.level >= 2) return 'L2+审批';
  if (s.interventions.length > 0) return s.interventions.at(-1) ?? '干预提示';
  if (ambiguousLocate(s.trail)) return '定位歧义';
  if (s.noChangeCount >= 2) return '画面停滞';
  if (s.recentFailures >= 2) return '连续失败';
  return null;
}

/** 每步一个思考预算决策：地板规则优先，其次模型自请，其余例行步骤关思考省钱。
 *  返回 null = 本模块不表态（daily/long/deep 档由供应商按既有语义判定）。 */
export function decideThinkingStep(s: ThinkSignals): ThinkingDecision | null {
  if ((s.mode ?? 'daily') !== 'auto') return null;
  const floor = floorReason(s);
  if (floor) return { think: true, reason: floor };
  if (s.modelAsk) return { think: true, reason: '模型自请' };
  return { think: false, reason: '例行' };
}

// ---------- 接线用的轻量状态机（采集事件 + 记账 + 观测） ----------

export interface ThinkStepContext {
  mode: ThinkingMode | undefined;
  step: number;
  recentFailures: number;
  noChangeCount: number;
  trail: readonly StepDetail[];
  planned: boolean;
}

export interface ThinkingStats {
  /** 判定为「开思考」的步数 */
  on: number;
  /** 已判定步数（= 本任务 auto 档下的模型调用轮次） */
  total: number;
  /** 各原因命中次数（收益归因用） */
  reasons: Record<string, number>;
}

/** 逐步思考预算：loop 只调用 observe/decide/noteAsk/summary 四个方法。 */
export class ThinkingBudget {
  private modelAsk = false;
  private interventions: string[] = [];
  private last: ThinkingDecision | null = null;
  private reasons = new Map<string, number>();
  private on = 0;
  private total = 0;

  constructor(private readonly taskId: string) {}

  /** 旁路观测事件流：干预/异常/审批都发生在 step|error|approval_* 事件里，
   *  比在 loop 各处埋点更省接线（且天然覆盖「上一步出现的提示」这一语义）。 */
  observe(ev: AgentEvent): void {
    if (ev.type === 'step') {
      const reason = interventionReason(ev.step.thought);
      if (reason) this.interventions.push(reason);
      return;
    }
    if (ev.type === 'error') {
      this.interventions.push('异常上报');
      return;
    }
    if (ev.type === 'approval_result') {
      this.interventions.push(ev.decision === 'approve' ? '审批已放行' : '审批已决');
    }
  }

  /** 记录本步模型自请（影响下一步；不记录即视为无自请，一步衰减） */
  noteAsk(ask: boolean | undefined): void {
    this.modelAsk = ask === true;
  }

  /** 本步决策：算完即消费一次性信号（自请/干预），并把结论记入统计 */
  decide(ctx: ThinkStepContext): ThinkingDecision | null {
    const interventions = this.interventions;
    this.interventions = [];
    const modelAsk = this.modelAsk;
    this.modelAsk = false;
    const decision = decideThinkingStep({ ...ctx, interventions, modelAsk });
    this.last = decision;
    if (decision) {
      this.total += 1;
      if (decision.think) {
        this.on += 1;
        this.reasons.set(decision.reason, (this.reasons.get(decision.reason) ?? 0) + 1);
      }
      console.log(`[thinking] ${this.taskId} 步${ctx.step}: ${decision.think ? `开（${decision.reason}）` : `关（${decision.reason}）`}`);
    }
    return decision;
  }

  /** 进 step 事件的短标签（非 auto 档无判定 → 缺省，既有口径零变化） */
  label(): string | undefined {
    if (!this.last) return undefined;
    return `${this.last.think ? '开' : '关'}·${this.last.reason}`;
  }

  /** 终态汇总：思考步数/占比 + 原因分布，便于以后量收益 */
  summary(): ThinkingStats {
    const ratio = this.total > 0 ? Math.round((this.on / this.total) * 100) : 0;
    if (this.total > 0) {
      const dist = [...this.reasons.entries()].map(([k, v]) => `${k}${v}`).join(' ');
      console.log(`[thinking] ${this.taskId} 汇总: 思考 ${this.on}/${this.total} 步（${ratio}%）${dist ? `｜触发: ${dist}` : ''}`);
    }
    return { on: this.on, total: this.total, reasons: Object.fromEntries(this.reasons) };
  }
}

export function createThinkingBudget(taskId: string): ThinkingBudget {
  return new ThinkingBudget(taskId);
}
