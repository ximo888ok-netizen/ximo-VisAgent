// 自动验收：模型宣布 task_done 后，由独立评审调用（带当前截图+执行轨迹）对照用户目标判定。
// 设计约束：单次调用不重试——评审故障时 fail-open 放行并显式标注，绝不因验收器挂掉而卡死任务。
import type { ChatMessage, ContentPart, ILLMClient } from '@ximo-visagent/llm-providers';
import type { StepDetail } from './types';
import { buildImagePart } from './loop-helpers';

export interface AcceptanceVerdict {
  pass: boolean;
  /** 通过理由 / 不通过时的缺口说明 */
  reason: string;
}

export interface AcceptanceGateResult {
  /** null = 评审不可用（调用失败或输出无法解析），调用方应 fail-open */
  verdict: AcceptanceVerdict | null;
  tokens: number;
  /** 评审调用失败原因（E1：必须可见，不静默吞） */
  error?: string;
}

/** 组装评审消息：system 验收员角色 + 目标/最终答案/轨迹，附当前截图块（内联 base64，如有） */
export async function buildAcceptanceMessages(goal: string, finalAnswer: string, stepsLines: string[], imagePart?: ContentPart): Promise<ChatMessage[]> {
  const system = `你是桌面任务验收员：根据用户目标、执行轨迹和当前屏幕截图（如有），独立判断任务是否真正完成。只有目标中的每个问题都已有证据支撑的回答时才算通过；模型自称"已完成"不构成证据。输出严格 JSON：{"pass": true|false, "reason": "简要理由"}，不通过时 reason 必须指出缺口（哪个目标点未达成/缺什么证据），不要输出其他内容。`;
  const text = [
    `用户目标: ${goal}`,
    `模型给出的最终答案: ${finalAnswer || '(空)'}`,
    '执行轨迹（最近步骤）:',
    ...(stepsLines.length ? stepsLines : ['(无)']),
    '',
    '请对照目标验收：目标中的每个问题是否都已有证据支撑的回答？finalAnswer 是否直接回答了目标而不是罗列操作？',
  ].join('\n');
  const parts: ContentPart[] = [{ type: 'text', text }];
  if (imagePart) parts.push(imagePart);
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
}

/** 解析评审输出：提取 JSON，pass 必须是布尔；解析失败返回 null（fail-open 由调用方处理） */
export function parseVerdict(content: string | null | undefined): AcceptanceVerdict | null {
  const text = (content ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
    if (typeof obj.pass !== 'boolean') return null;
    return { pass: obj.pass, reason: typeof obj.reason === 'string' ? obj.reason : '' };
  } catch {
    return null;
  }
}

/** 执行一次验收评审。轨迹取最近 8 步（含关键结果摘要），截图由调用方传当前感知帧。 */
export async function runAcceptanceGate(opts: {
  goal: string;
  finalAnswer: string;
  stepsDetail: StepDetail[];
  screenshot?: Buffer;
  textLLM: ILLMClient;
  visionLLM?: ILLMClient;
}): Promise<AcceptanceGateResult> {
  try {
    const stepsLines = opts.stepsDetail.slice(-8).map((s) => {
      const what = s.actionName ? `${s.actionName}(${s.args ? JSON.stringify(s.args).slice(0, 80) : ''})` : '思考';
      const outcome = s.resultSummary || s.thought || '';
      return `- [步${s.index}] ${what} → ${outcome.slice(0, 120)}`;
    });
    const model = opts.screenshot && opts.visionLLM ? opts.visionLLM : opts.textLLM;
    // 截图块走 base64 内联——验收与感知步引用同一帧时由 buildImagePart 自动处理
    const imagePart = opts.screenshot ? await buildImagePart(model, opts.screenshot) : undefined;
    const res = await model.chat(
      await buildAcceptanceMessages(opts.goal, opts.finalAnswer, stepsLines, imagePart),
      [],
    );
    return { verdict: parseVerdict(res.content), tokens: res.usage?.totalTokens ?? 0 };
  } catch (err) {
    // E1：评审故障必须可见（loop 侧 fail-open 继续任务，不因验收器挂掉而卡死）
    console.error('[acceptance] 验收评审调用失败，fail-open 放行:', err);
    return { verdict: null, tokens: 0, error: (err as Error).message };
  }
}

/** task_done 的结构化处置决策（loop 据此打回或完成，本身不含循环状态） */
export interface DoneOutcome {
  /** true = 允许完成（COMPLETED）；false = 打回继续 */
  finish: boolean;
  /** 最终答案（完成时可能附保留说明；打回时为被拒的那次答案，loop 不使用） */
  finalAnswer: string;
  /** 本次决策后的累计评审次数（loop 需回写持久化，跨打回累计） */
  attempts: number;
  /** 完成时步骤通知前缀（如「通过」「未通过（带保留）」），未启用验收时为空 */
  verdictNote?: string;
  /** 完成时的验收结论；未启用验收时 undefined */
  acceptance?: { passed: boolean | null; attempts: number };
  /** 打回时的注入内容（reject 存在时 loop 必须继续循环） */
  reject?: {
    memoryThought: string;
    memorySummary: string;
    systemMessage: string;
    notice: string;
    /** 累计打回次数（loop 回写计数用） */
    fails: number;
  };
  tokens: number;
  /** 评审调用失败原因（fail-open 时必须可见，E1） */
  error?: string;
}

/** 模型宣布 task_done 时的验收决策：
 *  - 未启用 → 直接放行；
 *  - 评审不通过且未达打回上限 → 打回（reject）；
 *  - 评审不通过但已达上限 → 放行但附「带保留」说明（passed=false）；
 *  - 评审通过 / 评审不可用 → 放行（后者 passed=null，fail-open 永不卡死任务）。 */
export async function onTaskDone(opts: {
  enabled: boolean;
  maxRetries: number;
  failsSoFar: number;
  attempts: number;
  goal: string;
  modelAnswer: string;
  stepsDetail: StepDetail[];
  screenshot?: Buffer;
  textLLM: ILLMClient;
  visionLLM?: ILLMClient;
}): Promise<DoneOutcome> {
  if (!opts.enabled) {
    return { finish: true, finalAnswer: opts.modelAnswer, attempts: opts.attempts, tokens: 0 };
  }
  const gate = await runAcceptanceGate({
    goal: opts.goal,
    finalAnswer: opts.modelAnswer,
    stepsDetail: opts.stepsDetail,
    screenshot: opts.screenshot,
    textLLM: opts.textLLM,
    visionLLM: opts.visionLLM,
  });
  const attempts = opts.attempts + 1;
  const base = { tokens: gate.tokens, error: gate.error };
  if (gate.verdict && !gate.verdict.pass && opts.failsSoFar < opts.maxRetries) {
    const attemptNo = opts.failsSoFar + 1;
    return {
      ...base,
      finish: false,
      finalAnswer: opts.modelAnswer,
      attempts,
      reject: {
        memoryThought: `自动验收未通过: ${gate.verdict.reason}`,
        memorySummary: '需补齐缺口后再次 task_done',
        systemMessage: `⛔ 自动验收未通过（第 ${attemptNo}/${opts.maxRetries} 次）：${gate.verdict.reason}\n请继续完成缺口，达成后再次调用 task_done（finalAnswer 直接回答目标问题，不要罗列操作）。`,
        notice: `[验收] 未通过（${attemptNo}/${opts.maxRetries}）：${gate.verdict.reason}`,
        fails: attemptNo,
      },
    };
  }
  const passed: boolean | null = gate.verdict ? gate.verdict.pass : null;
  const failedTotal = opts.failsSoFar + (passed === false ? 1 : 0);
  return {
    ...base,
    finish: true,
    finalAnswer:
      passed === false
        ? `${opts.modelAnswer}\n\n⚠ 自动验收未通过（累计 ${failedTotal} 次${gate.verdict?.reason ? `：${gate.verdict.reason}` : ''}），结果带保留，请人工复核。`
        : opts.modelAnswer,
    attempts,
    verdictNote: passed === true ? '通过' : passed === false ? '未通过（带保留）' : '跳过（评审不可用）',
    acceptance: { passed, attempts },
  };
}
