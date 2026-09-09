// 任务洞察：成功率统计（基于审计库） + SOP 相似推荐（词元 Jaccard）
import type { ZODB, SopRow } from './audit-store';
import type { StatsResultPayload } from '../shared/island-contracts';

export function computeStats(audit: ZODB, days = 30): StatsResultPayload {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const tasks = audit.listTasks(10000).filter((t) => t.createdAt >= since);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
  const failed = tasks.filter((t) => t.status === 'FAILED').length;
  const cancelled = tasks.filter((t) => t.status === 'CANCELLED' || t.status === 'EMERGENCY_STOPPED').length;
  const interrupted = tasks.filter((t) => t.status === 'WAITING_APPROVAL' || t.status === 'RUNNING' || t.status === 'PAUSED' || t.status === 'QUEUED').length;
  const totalTokens = tasks.reduce((s, t) => s + (t.tokens ?? 0), 0);
  const failureKinds = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === 'FAILED' && t.failureKind) {
      failureKinds.set(t.failureKind, (failureKinds.get(t.failureKind) ?? 0) + 1);
    }
  }
  return {
    totalTasks: total,
    completed,
    failed,
    cancelled,
    interrupted,
    successRate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
    totalTokens,
    avgTokens: total > 0 ? Math.round(totalTokens / total) : 0,
    interventions: audit.countApprovalDecisions(since),
    failureKinds: [...failureKinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    days,
  };
}

/** 中文字符二元组 + 英文词元，构建用于相似度比较的集合 */
function tokens(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  for (const w of norm.match(/[a-z0-9]+/g) ?? []) out.add(w);
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    if (!/^\s/.test(bg) && !/\s$/.test(bg)) out.add(bg);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 从 SOP 模板库中按目标相似度推荐（阈值 0.18，取最高分） */
export function recommendSop(sops: SopRow[], goal: string): { sopId: string; name: string; score: number } | null {
  const goalTokens = tokens(goal);
  let best: { sopId: string; name: string; score: number } | null = null;
  for (const sop of sops) {
    const text = `${sop.name} ${sop.description} ${sop.goalTemplate}`;
    const score = jaccard(goalTokens, tokens(text));
    if (score >= 0.18 && (!best || score > best.score)) {
      best = { sopId: sop.id, name: sop.name, score: Math.round(score * 100) / 100 };
    }
  }
  return best;
}
