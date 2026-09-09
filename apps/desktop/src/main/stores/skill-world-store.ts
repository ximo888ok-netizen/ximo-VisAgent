// P8 域：技能运行 / SOP 生命周期 / 世界模型（SkillWorldStore）
import type Database from 'better-sqlite3';
import type { EnvFactRow, SkillRunRecord } from './experience-types';

interface EnvFactRowDb {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  timesObserved: number;
  sourceTaskId: string | null;
  lastVerifiedAt: number | null;
  createdAt: number;
  enabled: number;
}

function dbRowToFactRow(r: EnvFactRowDb): EnvFactRow {
  return {
    ...r,
    kind: r.kind as EnvFactRow['kind'],
    enabled: r.enabled === 1,
  };
}

export class SkillWorldStore {
  constructor(private db: Database.Database) {
    this.initTables();
  }

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS skill_runs (
          id TEXT PRIMARY KEY,
          sopId TEXT NOT NULL,
          taskId TEXT NOT NULL,
          mode TEXT NOT NULL,
          adopted INTEGER NOT NULL DEFAULT 0,
          outcome TEXT,
          stepsUsed INTEGER,
          tokens INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_runs_sop ON skill_runs(sopId);

        CREATE TABLE IF NOT EXISTS env_facts (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.6,
          timesObserved INTEGER NOT NULL DEFAULT 1,
          sourceTaskId TEXT,
          lastVerifiedAt INTEGER,
          createdAt INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_facts_kind ON env_facts(kind);
      `);
    } catch (err) {
      console.error('[experience-store] init failed (v3 降级，核心执行链路不受影响)', err);
    }
  }

  // ---------- 技能运行 CRUD ----------

  insertSkillRun(rec: SkillRunRecord): void {
    this.db.prepare(`
      INSERT INTO skill_runs (id, sopId, taskId, mode, adopted, outcome, stepsUsed, tokens, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rec.id, rec.sopId, rec.taskId, rec.mode, rec.adopted ? 1 : 0,
      rec.outcome, rec.stepsUsed, rec.tokens, rec.createdAt);
  }

  listSkillRuns(sopId: string, limit = 20): SkillRunRecord[] {
    const rows = this.db.prepare('SELECT * FROM skill_runs WHERE sopId = ? ORDER BY createdAt DESC LIMIT ?').all(sopId, limit) as Array<{
      id: string; sopId: string; taskId: string; mode: string; adopted: number;
      outcome: string | null; stepsUsed: number | null; tokens: number | null; createdAt: number;
    }>;
    return rows.map((r) => ({
      ...r,
      mode: r.mode as SkillRunRecord['mode'],
      adopted: r.adopted === 1,
    }));
  }

  // ---------- SOP 生命周期列（sops 表在 ZODB 中，此处仅更新新列） ----------

  updateSopStatus(sopId: string, status: string): void {
    this.db.prepare('UPDATE sops SET status = ? WHERE id = ?').run(status, sopId);
  }

  incrementSopSuccess(sopId: string): void {
    this.db.prepare('UPDATE sops SET successCount = successCount + 1 WHERE id = ?').run(sopId);
  }

  incrementSopFail(sopId: string): void {
    this.db.prepare('UPDATE sops SET failCount = failCount + 1 WHERE id = ?').run(sopId);
  }

  setSopPromoted(sopId: string, promotedAt: number): void {
    this.db.prepare('UPDATE sops SET status = ?, promotedAt = ? WHERE id = ?').run('active', promotedAt, sopId);
  }

  // ---------- 世界模型 CRUD ----------

  listEnvFacts(kind?: string): EnvFactRow[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM env_facts WHERE kind = ? ORDER BY createdAt DESC').all(kind) as EnvFactRowDb[]
      : this.db.prepare('SELECT * FROM env_facts ORDER BY createdAt DESC').all() as EnvFactRowDb[];
    return rows.map(dbRowToFactRow);
  }

  searchEnvFacts(query: string, kind?: string): EnvFactRow[] {
    const like = `%${query}%`;
    const rows = kind
      ? this.db.prepare('SELECT * FROM env_facts WHERE content LIKE ? AND kind = ? ORDER BY createdAt DESC').all(like, kind) as EnvFactRowDb[]
      : this.db.prepare('SELECT * FROM env_facts WHERE content LIKE ? ORDER BY createdAt DESC').all(like) as EnvFactRowDb[];
    return rows.map(dbRowToFactRow);
  }

  insertEnvFact(row: Omit<EnvFactRow, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): string {
    const id = row.id ?? crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO env_facts (id, kind, content, confidence, timesObserved, sourceTaskId, lastVerifiedAt, createdAt, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, row.kind, row.content, row.confidence, row.timesObserved,
      row.sourceTaskId, row.lastVerifiedAt, row.createdAt ?? Date.now(), row.enabled ? 1 : 0);
    return id;
  }

  updateEnvFact(id: string, updates: Partial<Pick<EnvFactRow, 'confidence' | 'timesObserved' | 'lastVerifiedAt' | 'enabled'>>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); params.push(updates.confidence); }
    if (updates.timesObserved !== undefined) { sets.push('timesObserved = ?'); params.push(updates.timesObserved); }
    if (updates.lastVerifiedAt !== undefined) { sets.push('lastVerifiedAt = ?'); params.push(updates.lastVerifiedAt); }
    if (updates.enabled !== undefined) { sets.push('enabled = ?'); params.push(updates.enabled ? 1 : 0); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE env_facts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  findSimilarFact(content: string, kind?: string): EnvFactRow | null {
    // Jaccard 相似度匹配：对同 kind 的事实做词元级比较，阈值 0.35
    const targetTokens = tokenize(content);
    if (targetTokens.size === 0) return null;
    const rows = (kind
      ? this.db.prepare('SELECT * FROM env_facts WHERE kind = ?').all(kind)
      : this.db.prepare('SELECT * FROM env_facts').all()
    ) as EnvFactRowDb[];
    let best: { row: EnvFactRowDb; score: number } | null = null;
    for (const row of rows) {
      const score = jaccard(targetTokens, tokenize(row.content));
      if (score >= 0.35 && (!best || score > best.score)) {
        best = { row, score };
      }
    }
    return best ? dbRowToFactRow(best.row) : null;
  }

  toggleEnvFact(id: string, enabled: boolean): boolean {
    const res = this.db.prepare('UPDATE env_facts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return res.changes > 0;
  }

  deleteEnvFact(id: string): boolean {
    const res = this.db.prepare('DELETE FROM env_facts WHERE id = ?').run(id);
    return res.changes > 0;
  }

  clearEnvFacts(): void {
    this.db.prepare('DELETE FROM env_facts').run();
  }

  // ---------- 统计 ----------

  countSkillRuns(since: number): { shadowTotal: number; shadowAdopted: number; activeTotal: number; activeCompleted: number } {
    const shadowTotal = (this.db.prepare("SELECT COUNT(*) AS c FROM skill_runs WHERE mode = 'shadow' AND createdAt >= ?").get(since) as { c: number }).c;
    const shadowAdopted = (this.db.prepare("SELECT COUNT(*) AS c FROM skill_runs WHERE mode = 'shadow' AND adopted = 1 AND createdAt >= ?").get(since) as { c: number }).c;
    const activeTotal = (this.db.prepare("SELECT COUNT(*) AS c FROM skill_runs WHERE mode = 'active' AND adopted = 1 AND createdAt >= ?").get(since) as { c: number }).c;
    const activeCompleted = (this.db.prepare("SELECT COUNT(*) AS c FROM skill_runs WHERE mode = 'active' AND adopted = 1 AND outcome = 'COMPLETED' AND createdAt >= ?").get(since) as { c: number }).c;
    return { shadowTotal, shadowAdopted, activeTotal, activeCompleted };
  }
}

// ---------- 相似度辅助 ----------

/** 中文字符二元组 + 英文词元，构建用于相似度比较的集合 */
function tokenize(text: string): Set<string> {
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
