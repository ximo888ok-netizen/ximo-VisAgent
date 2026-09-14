// 中文输入回读验证（轻量闭环）：注入后读 UIA 焦点元素 value 做尾部抽查。
// 只告警、不重试、不阻塞：回读不可用（Chromium/自绘控件常无 value）时静默跳过。
// 局限：尾部 12 字符采样不是逐字校验；焦点元素判定依赖 UIA sidecar 在线。
import { getUiaClient } from './uia-client';

/** 含非 ASCII（中文/全角）的文本易被输入法/IME 干扰，值得回读；纯 ASCII 注入链路稳定 */
export function needsInputVerify(text: string): boolean {
  return /[^\x20-\x7E]/.test(text);
}

export interface TypeVerifyResult {
  /** 无法回读（UIA 不可用或 focused value 为空）→ 跳过，不误报失败 */
  skipped: boolean;
  matched: boolean;
}

/** 尾部采样比对：去空白后，期望文本的最后 tailChars 个字符应出现在回读文本中 */
export function verifyTypedText(expected: string, readback: string, tailChars = 12): TypeVerifyResult {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const want = norm(expected).slice(-Math.max(1, tailChars));
  const got = norm(readback);
  if (!want || !got) return { skipped: true, matched: false };
  return { skipped: false, matched: got.includes(want) };
}

/** best-effort 回读焦点元素文本值：任何异常都返回空串（验证随之跳过，不拖垮输入路径） */
export async function readFocusedValue(): Promise<string> {
  try {
    const focused = await getUiaClient().focusedElement();
    const value = focused.value ?? focused.cValue;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 注入后的回读附注（拼进工具 summary）；无需/无法验证时返回 ''，全程不抛出 */
export async function verifyTypedInputNote(text: string, settleMs = 150): Promise<string> {
  if (!needsInputVerify(text)) return '';
  try {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const result = verifyTypedText(text, await readFocusedValue());
    if (result.skipped) return '；输入回读不可用（未验证）';
    return result.matched ? '' : '；⚠ 输入回读与文本尾部不符，请截图确认输入是否完整';
  } catch {
    return '';
  }
}
