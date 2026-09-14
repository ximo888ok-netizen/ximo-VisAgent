/**
 * wechat-notify-target.ts — 反向通知目标解析（纯逻辑，无 electron 依赖，便于单测）
 *
 * iLink 协议下 Bot 只能回复"有过会话的联系人"（发送必须带其 context_token），
 * 所以通知目标只能来自入站消息。优先级：显式配置 > 最近一次来消息的联系人。
 */

export interface NotifyTarget {
  wxid: string;
  ctxToken: string;
}

/**
 * 解析反向通知目标。两者都没有可用 context_token 时返回 null（调用方负责可见降级）。
 * 注意：配置了联系人但没有 token（对方从未给 Bot 发过消息）会退回最近联系人——
 * 这也是"配了却不生效"时最可能的原因，降级提示必须说清楚。
 */
export function resolveNotifyTarget(
  configured: string,
  lastContact: string | null,
  tokenOf: (wxid: string) => string | undefined,
): NotifyTarget | null {
  for (const wxid of [configured, lastContact]) {
    if (!wxid) continue;
    const ctxToken = tokenOf(wxid);
    if (ctxToken) return { wxid, ctxToken };
  }
  return null;
}
