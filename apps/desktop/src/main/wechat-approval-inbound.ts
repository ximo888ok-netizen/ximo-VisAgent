/**
 * wechat-approval-inbound.ts — 微信审批入站承接的纯逻辑（解析 + 路由）
 *
 * 出站审批通知让人「回复同意 xxx」，但入站此前只认命令前缀建任务。
 * 本模块把「同意/拒绝 <审批编号前缀>」解析成决策意图，并在挂起审批里按
 * 前缀找到唯一目标；文本组织在 wechat-notify.ts，副作用（decide/回消息）在 bootstrap。
 */

export type ApprovalReplyDecision = 'approve' | 'reject';

export interface ApprovalReply {
  decision: ApprovalReplyDecision;
  /** 用户给出的审批编号前缀（小写归一） */
  idPrefix: string;
}

const DECISION_WORDS: { words: string[]; decision: ApprovalReplyDecision }[] = [
  { words: ['同意', '批准', 'approve'], decision: 'approve' },
  { words: ['拒绝', '驳回', 'reject'], decision: 'reject' },
];

/** 审批编号来自 crypto.randomUUID 前缀：hex + 连字符，至少 4 位避免误吞日常对话 */
const ID_TOKEN_RE = /^[0-9a-f][0-9a-f-]{3,}$/;

/** 解析审批回复消息；不是审批回复时返回 null（交回命令前缀路径） */
export function parseApprovalReply(content: string): ApprovalReply | null {
  const text = content.trim().toLowerCase();
  if (!text) return null;
  for (const { words, decision } of DECISION_WORDS) {
    for (const word of words) {
      if (!text.startsWith(word)) continue;
      const rest = text.slice(word.length).replace(/^[\s:：，,。]+/, '').trim();
      const idToken = rest.split(/\s+/)[0] ?? '';
      if (!ID_TOKEN_RE.test(idToken)) return null;
      return { decision, idPrefix: idToken };
    }
  }
  return null;
}

export interface ApprovalCandidate {
  id: string;
  /** 状态机已置 TIMEOUT：按需求只告知，不再回写决定 */
  timedOut: boolean;
}

export type ApprovalReplyRoute =
  | { kind: 'decide'; decision: ApprovalReplyDecision; id: string }
  | { kind: 'not_found'; idPrefix: string }
  | { kind: 'ambiguous' }
  | { kind: 'timeout'; id: string };

/** 编号前缀 → 挂起审批路由：唯一命中才执行，多义/缺失/超时都只回复告知 */
export function routeApprovalReply(
  reply: ApprovalReply,
  candidates: ApprovalCandidate[],
): ApprovalReplyRoute {
  const hits = candidates.filter((c) => c.id.toLowerCase().startsWith(reply.idPrefix));
  if (hits.length === 0) return { kind: 'not_found', idPrefix: reply.idPrefix };
  if (hits.length > 1) return { kind: 'ambiguous' };
  const hit = hits[0]!;
  if (hit.timedOut) return { kind: 'timeout', id: hit.id };
  return { kind: 'decide', decision: reply.decision, id: hit.id };
}
