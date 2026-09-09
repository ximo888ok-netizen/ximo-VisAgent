// LLM 调用重试与画面签名（从 loop.ts 拆出，遵守 400 行上限）
import type { ChatMessage, ChatOptions, ILLMClient, ToolDef } from '@ximo-visagent/llm-providers';
import type { ApprovalEngine } from '@ximo-visagent/safety';
import type { AgentEvent } from './types';
import { sleep } from './loop-helpers';

/** 截图快速签名：采样字节 + 长度 → 32bit FNV，判断画面是否变化（开销 <1ms） */
export function quickHash(buf: Buffer): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(buf.length / 1024));
  for (let i = 0; i < buf.length; i += step) {
    h ^= buf[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${buf.length}`;
}

/** LLM 调用 + 指数退避重试（P1-13 / F1.7: 4xx 不重试） */
export async function chatWithRetry(
  model: ILLMClient,
  msgs: ChatMessage[],
  tools: ToolDef[],
  maxRetries: number,
  emit: (e: AgentEvent) => void,
  options?: ChatOptions,
) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await model.chat(msgs, tools, options);
    } catch (err) {
      lastErr = err;
      // F1.7: 4xx 客户端错误（401/400/403 等）不重试，直接返回 null
      const status = (err as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) {
        emit({ type: 'error', message: `LLM 客户端错误 (HTTP ${status})，不重试: ${(err as Error).message}` });
        return null;
      }
      if (attempt < maxRetries) {
        const backoff = Math.min(8000, 500 * 2 ** attempt);
        emit({ type: 'error', message: `LLM 调用失败（第 ${attempt + 1} 次），${backoff}ms 后重试: ${(err as Error).message}` });
        await sleep(backoff);
      }
    }
  }
  emit({ type: 'error', message: `LLM 重试耗尽: ${(lastErr as Error)?.message ?? '未知错误'}` });
  return null;
}

/** 审批轮询：挂起等待外部决定，检查取消/超时/审批状态（从 loop.ts 拆出） */
export function pollApproval(
  id: string,
  engine: ApprovalEngine,
  timeoutMs: number,
  emit: (e: AgentEvent) => void,
  startedAt: number,
  maxDurationMs: number,
  isCancelled: () => boolean,
): Promise<'approved' | 'rejected' | 'timeout_hang' | 'cancelled' | 'task_timeout'> {
  return new Promise((resolve) => {
    let hangAnnounced = false;
    const int = setInterval(() => {
      if (isCancelled()) { clearInterval(int); resolve('cancelled'); return; }
      if (Date.now() - startedAt > maxDurationMs) { clearInterval(int); resolve('task_timeout'); return; }
      if (engine.checkTimeout(id) && !hangAnnounced) {
        hangAnnounced = true;
        emit({ type: 'status', status: 'WAITING_APPROVAL' });
        emit({ type: 'error', message: `审批超时（>${Math.round(timeoutMs / 1000)}s），任务挂起等待人工处理` });
      }
      const a = engine.get(id);
      if (!a) { clearInterval(int); resolve('timeout_hang'); return; }
      if (a.status === 'APPROVED' || a.status === 'EDITED') { clearInterval(int); resolve('approved'); }
      else if (a.status === 'REJECTED') { clearInterval(int); resolve('rejected'); }
    }, 500);
  });
}
