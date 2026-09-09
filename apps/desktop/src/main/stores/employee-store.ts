/**
 * employee-store.ts — 员工域存储（positions / fact_cards / onboarding_reports）
 *
 * 复用同一 better-sqlite3 Database 实例（与 ExperienceStore 同模式）。
 * 表拥有者纪律（C5）：本文件拥有 positions/fact_cards/onboarding_reports 三张表。
 */
import type Database from 'better-sqlite3';
import type { PositionRow, FactCardRow, OnboardingReportRow } from './employee-types';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export class EmployeeStore {
  constructor(private db: Database.Database) {
    this.initTables();
  }

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          roleProfile TEXT NOT NULL DEFAULT '',
          reportTo TEXT NOT NULL DEFAULT '',
          tone TEXT NOT NULL DEFAULT '',
          dutyScopeJson TEXT NOT NULL DEFAULT '[]',
          dutyBoundaryJson TEXT NOT NULL DEFAULT '[]',
          goalsJson TEXT NOT NULL DEFAULT '[]',
          knowledgeJson TEXT NOT NULL DEFAULT '[]',
          routineJson TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS fact_cards (
          id TEXT PRIMARY KEY,
          positionId TEXT NOT NULL,
          topic TEXT NOT NULL,
          claim TEXT NOT NULL,
          sourceRef TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.6,
          sourceHash TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          confirmed INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          FOREIGN KEY (positionId) REFERENCES positions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_fact_cards_position ON fact_cards(positionId);
        CREATE INDEX IF NOT EXISTS idx_fact_cards_topic ON fact_cards(topic);
        CREATE INDEX IF NOT EXISTS idx_fact_cards_status ON fact_cards(status);

        CREATE TABLE IF NOT EXISTS onboarding_reports (
          id TEXT PRIMARY KEY,
          positionId TEXT NOT NULL,
          reportJson TEXT NOT NULL DEFAULT '{}',
          questionsJson TEXT NOT NULL DEFAULT '[]',
          lastCursorJson TEXT NOT NULL DEFAULT '{}',
          coverage REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'in_progress',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          FOREIGN KEY (positionId) REFERENCES positions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_reports_position ON onboarding_reports(positionId);

        -- M4: FTS5 全文索引（trigram 分词，无外部依赖）
        CREATE VIRTUAL TABLE IF NOT EXISTS fact_cards_fts USING fts5(
          claim,
          topic,
          sourceRef,
          content='fact_cards',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `);

      // M4: 建立触发器保持 FTS5 索引与 fact_cards 同步
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS fact_cards_ai AFTER INSERT ON fact_cards BEGIN
          INSERT INTO fact_cards_fts(rowid, claim, topic, sourceRef)
          VALUES (new.rowid, new.claim, new.topic, new.sourceRef);
        END;
        CREATE TRIGGER IF NOT EXISTS fact_cards_ad AFTER DELETE ON fact_cards BEGIN
          INSERT INTO fact_cards_fts(fact_cards_fts, rowid, claim, topic, sourceRef)
          VALUES ('delete', old.rowid, old.claim, old.topic, old.sourceRef);
        END;
        CREATE TRIGGER IF NOT EXISTS fact_cards_au AFTER UPDATE ON fact_cards BEGIN
          INSERT INTO fact_cards_fts(fact_cards_fts, rowid, claim, topic, sourceRef)
          VALUES ('delete', old.rowid, old.claim, old.topic, old.sourceRef);
          INSERT INTO fact_cards_fts(rowid, claim, topic, sourceRef)
          VALUES (new.rowid, new.claim, new.topic, new.sourceRef);
        END;
      `);
    } catch (err) {
      console.error('[employee-store] init failed (v3 降级，核心执行链路不受影响)', err);
    }
  }

  // ---------- 岗位 CRUD ----------

  listPositions(): PositionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM positions ORDER BY createdAt DESC')
      .all() as PositionRow[];
    return rows;
  }

  getPosition(id: string): PositionRow | null {
    return (this.db
      .prepare('SELECT * FROM positions WHERE id = ?')
      .get(id) as PositionRow | undefined) ?? null;
  }

  insertPosition(row: Omit<PositionRow, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): string {
    const now = Date.now();
    const id = row.id;
    this.db.prepare(`
      INSERT INTO positions (id, name, roleProfile, reportTo, tone, dutyScopeJson, dutyBoundaryJson, goalsJson, knowledgeJson, routineJson, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, row.name, row.roleProfile, row.reportTo, row.tone,
      row.dutyScopeJson, row.dutyBoundaryJson, row.goalsJson, row.knowledgeJson, row.routineJson,
      row.status, row.createdAt ?? now, row.updatedAt ?? now,
    );
    return id;
  }

  updatePosition(id: string, updates: Partial<Omit<PositionRow, 'id' | 'createdAt'>> & { updatedAt?: number }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    const fieldKeys = ['name', 'roleProfile', 'reportTo', 'tone', 'dutyScopeJson', 'dutyBoundaryJson', 'goalsJson', 'knowledgeJson', 'routineJson', 'status'] as const;
    for (const f of fieldKeys) {
      const v = updates[f as keyof typeof updates];
      if (v !== undefined) { sets.push(`${f} = ?`); params.push(v as string); }
    }
    sets.push('updatedAt = ?');
    params.push(updates.updatedAt ?? Date.now());
    params.push(id);
    return this.db.prepare(`UPDATE positions SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  deletePosition(id: string): boolean {
    const res = this.db.prepare('DELETE FROM positions WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // ---------- 事实卡 CRUD ----------

  listFactCards(positionId?: string): FactCardRow[] {
    const rows = positionId
      ? this.db.prepare('SELECT * FROM fact_cards WHERE positionId = ? ORDER BY createdAt DESC').all(positionId) as FactCardRow[]
      : this.db.prepare('SELECT * FROM fact_cards ORDER BY createdAt DESC').all() as FactCardRow[];
    return rows.map(this.normalizeFactCard);
  }

  searchFactCards(query: string, positionId?: string, topic?: string, limit = 20): FactCardRow[] {
    const like = `%${query}%`;
    let sql = 'SELECT * FROM fact_cards WHERE claim LIKE ?';
    const params: unknown[] = [like];
    if (positionId) { sql += ' AND positionId = ?'; params.push(positionId); }
    if (topic) { sql += ' AND topic = ?'; params.push(topic); }
    sql += ' ORDER BY confidence DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as FactCardRow[];
    return rows.map(this.normalizeFactCard);
  }

  /**
   * M4: FTS5 全文检索（比 LIKE 更精准，支持中文分词）
   * 仅返回 status=active 且 confirmed=1 的事实卡
   */
  searchFactCardsFTS(query: string, positionId?: string, limit = 5): FactCardRow[] {
    try {
      // FTS5 MATCH 查询，对 claim + topic + sourceRef 做全文检索
      const ftsQuery = this.sanitizeFTSQuery(query);
      let sql = `
        SELECT fc.* FROM fact_cards fc
        JOIN fact_cards_fts fts ON fc.rowid = fts.rowid
        WHERE fact_cards_fts MATCH ? AND fc.status = 'active' AND fc.confirmed = 1
      `;
      const params: unknown[] = [ftsQuery];
      if (positionId) { sql += ' AND fc.positionId = ?'; params.push(positionId); }
      sql += ' ORDER BY fc.confidence DESC LIMIT ?';
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as FactCardRow[];
      return rows.map(this.normalizeFactCard);
    } catch {
      // FTS5 不可用时回退到 LIKE 搜索
      return this.searchFactCards(query, positionId, undefined, limit);
    }
  }

  /** 将用户查询转为 FTS5 安全的 MATCH 表达式 */
  private sanitizeFTSQuery(query: string): string {
    // 去掉特殊字符，按空格分词，每个词加前缀匹配
    const words = query.replace(/["'"*():]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return query;
    return words.map((w) => `"${w}"*`).join(' ');
  }

  /**
   * M4: 资料失效检测 — 检查事实卡对应的源文件是否变更
   * sourceHash 不匹配 → 标记 stale
   */
  detectStaleFactCards(positionId?: string): number {
    const cards = this.listFactCards(positionId).filter((c) => c.status === 'active' && c.confirmed && c.sourceHash);
    let staleCount = 0;
    for (const card of cards) {
      // sourceRef 格式：path Lxx-xx 或 path
      const match = card.sourceRef.match(/^(.+?)(?:\s+L\d|$)/);
      const filePath = match?.[1];
      if (!filePath) continue;
      try {
        if (!fs.existsSync(filePath)) {
          // 文件不存在 → 标记 stale
          this.updateFactCard(card.id, { status: 'stale' });
          staleCount++;
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = createHash('md5').update(content).digest('hex').slice(0, 16);
        if (card.sourceHash && hash !== card.sourceHash) {
          this.updateFactCard(card.id, { status: 'stale' });
          staleCount++;
        }
      } catch { /* 跳过无法检测的 */ }
    }
    return staleCount;
  }

  insertFactCard(row: Omit<FactCardRow, 'createdAt' | 'updatedAt' | 'confirmed'> & { confirmed?: boolean }): string {
    const now = Date.now();
    const id = row.id;
    this.db.prepare(`
      INSERT INTO fact_cards (id, positionId, topic, claim, sourceRef, confidence, sourceHash, status, confirmed, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, row.positionId, row.topic, row.claim, row.sourceRef,
      row.confidence, row.sourceHash, row.status, row.confirmed ? 1 : 0, now, now,
    );
    return id;
  }

  updateFactCard(id: string, updates: Partial<Pick<FactCardRow, 'confidence' | 'status' | 'confirmed' | 'claim' | 'sourceHash'>>): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); params.push(updates.confidence); }
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.confirmed !== undefined) { sets.push('confirmed = ?'); params.push(updates.confirmed ? 1 : 0); }
    if (updates.claim !== undefined) { sets.push('claim = ?'); params.push(updates.claim); }
    if (updates.sourceHash !== undefined) { sets.push('sourceHash = ?'); params.push(updates.sourceHash); }
    if (sets.length === 0) return false;
    sets.push('updatedAt = ?');
    params.push(Date.now());
    params.push(id);
    return this.db.prepare(`UPDATE fact_cards SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  /** 事实卡批量转正（入职报告确认后调用） */
  confirmFactCards(positionId: string): number {
    return this.db.prepare('UPDATE fact_cards SET confirmed = 1, updatedAt = ? WHERE positionId = ?').run(Date.now(), positionId).changes;
  }

  deleteFactCardsByPosition(positionId: string): void {
    this.db.prepare('DELETE FROM fact_cards WHERE positionId = ?').run(positionId);
  }

  // ---------- 入职报告 CRUD ----------

  listReports(positionId?: string): OnboardingReportRow[] {
    const rows = positionId
      ? this.db.prepare('SELECT * FROM onboarding_reports WHERE positionId = ? ORDER BY createdAt DESC').all(positionId) as OnboardingReportRow[]
      : this.db.prepare('SELECT * FROM onboarding_reports ORDER BY createdAt DESC').all() as OnboardingReportRow[];
    return rows;
  }

  getReport(id: string): OnboardingReportRow | null {
    return (this.db.prepare('SELECT * FROM onboarding_reports WHERE id = ?').get(id) as OnboardingReportRow | undefined) ?? null;
  }

  getLatestReport(positionId: string): OnboardingReportRow | null {
    return (this.db
      .prepare('SELECT * FROM onboarding_reports WHERE positionId = ? ORDER BY createdAt DESC LIMIT 1')
      .get(positionId) as OnboardingReportRow | undefined) ?? null;
  }

  upsertReport(row: Omit<OnboardingReportRow, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): string {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO onboarding_reports (id, positionId, reportJson, questionsJson, lastCursorJson, coverage, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reportJson = excluded.reportJson,
        questionsJson = excluded.questionsJson,
        lastCursorJson = excluded.lastCursorJson,
        coverage = excluded.coverage,
        status = excluded.status,
        updatedAt = excluded.updatedAt
    `).run(
      row.id, row.positionId, row.reportJson, row.questionsJson, row.lastCursorJson,
      row.coverage, row.status, row.createdAt ?? now, row.updatedAt ?? now,
    );
    return row.id;
  }

  updateReportStatus(id: string, status: OnboardingReportRow['status']): boolean {
    return this.db.prepare('UPDATE onboarding_reports SET status = ?, updatedAt = ? WHERE id = ?')
      .run(status, Date.now(), id).changes > 0;
  }

  // ---------- 内部辅助 ----------

  private normalizeFactCard(r: FactCardRow): FactCardRow {
    return {
      ...r,
      confirmed: (r as unknown as { confirmed: number }).confirmed === 1,
    };
  }
}
