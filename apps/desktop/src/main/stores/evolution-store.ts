// P9 域：恢复规则 / Prompt 版本 / 自定义工具（EvolutionStore）
import type Database from 'better-sqlite3';
import type {
  CustomToolRow,
  MetaProposalRow,
  MetaProposalStatus,
  MetaState,
  PromptVersionRow,
  RecoveryRuleRow,
} from './experience-types';

export class EvolutionStore {
  constructor(private db: Database.Database) {
    this.initTables();
  }

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS recovery_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          detectJson TEXT NOT NULL,
          actionJson TEXT NOT NULL,
          sourceAttributionId TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          successCount INTEGER NOT NULL DEFAULT 0,
          failCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          guidance TEXT NOT NULL,
          origin TEXT NOT NULL,
          benchmarkJson TEXT,
          approvalId TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS custom_tools (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          schemaJson TEXT NOT NULL,
          scriptPath TEXT NOT NULL,
          proposalJson TEXT,
          approvalId TEXT,
          status TEXT NOT NULL DEFAULT 'proposed',
          createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta_proposals (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          targetId TEXT NOT NULL,
          reason TEXT NOT NULL,
          payloadJson TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          createdAt INTEGER NOT NULL,
          decidedAt INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_meta_status ON meta_proposals(status);
        CREATE TABLE IF NOT EXISTS meta_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    } catch (err) {
      console.error('[experience-store] init failed (v3 降级，核心执行链路不受影响)', err);
    }
  }

  // ---------- 宪法门提案 CRUD ----------

  insertMetaProposal(row: Omit<MetaProposalRow, 'status' | 'decidedAt' | 'error'> & { status?: MetaProposalStatus }): void {
    this.db.prepare(`
      INSERT INTO meta_proposals (id, action, targetId, reason, payloadJson, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.action, row.targetId, row.reason, row.payloadJson, row.status ?? 'pending', row.createdAt);
  }

  getMetaProposal(id: string): MetaProposalRow | null {
    return this.db.prepare('SELECT * FROM meta_proposals WHERE id = ?').get(id) as MetaProposalRow | undefined ?? null;
  }

  /** 取指定 targetId 的待决提案（同一目标只允许排队一个变更） */
  getPendingMetaProposal(targetId: string): MetaProposalRow | null {
    return (this.db
      .prepare("SELECT * FROM meta_proposals WHERE targetId = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1")
      .get(targetId) as MetaProposalRow | undefined) ?? null;
  }

  listMetaProposals(status?: MetaProposalStatus, limit = 100): MetaProposalRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM meta_proposals WHERE status = ? ORDER BY createdAt DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM meta_proposals ORDER BY createdAt DESC LIMIT ?').all(limit);
    return rows as MetaProposalRow[];
  }

  updateMetaProposal(id: string, updates: { status?: MetaProposalStatus; decidedAt?: number; error?: string | null }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.decidedAt !== undefined) { sets.push('decidedAt = ?'); params.push(updates.decidedAt); }
    if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error); }
    if (sets.length === 0) return false;
    params.push(id);
    return this.db.prepare(`UPDATE meta_proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  // ---------- 元层总开关 ----------

  getMetaState(): MetaState {
    const rows = this.db.prepare('SELECT key, value FROM meta_state').all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const disabledAt = map.get('disabledAt');
    return {
      // 缺失即视为启用（首次运行没有状态行）
      enabled: map.get('enabled') !== '0',
      lastViolation: map.get('lastViolation') || null,
      disabledAt: disabledAt ? Number(disabledAt) : null,
    };
  }

  setMetaState(state: Partial<Pick<MetaState, 'enabled' | 'lastViolation' | 'disabledAt'>>): void {
    const stmt = this.db.prepare(
      'INSERT INTO meta_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(state)) {
      if (value === undefined) continue;
      // 布尔统一序列化为 '1'/'0'，否则与上面的 !== '0' 判读不一致
      const stored = value === null ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
      stmt.run(key, stored);
    }
  }

  // ---------- 恢复规则 CRUD ----------

  listRecoveryRules(): RecoveryRuleRow[] {
    const rows = this.db
      .prepare('SELECT * FROM recovery_rules ORDER BY createdAt DESC')
      .all() as Array<Omit<RecoveryRuleRow, 'enabled'> & { enabled: number }>;
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
  }

  insertRecoveryRule(row: Omit<RecoveryRuleRow, 'id' | 'createdAt' | 'successCount' | 'failCount' | 'enabled'> & { id?: string; createdAt?: number }): string {
    const id = row.id ?? crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO recovery_rules (id, name, detectJson, actionJson, sourceAttributionId, enabled, successCount, failCount, createdAt)
      VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)
    `).run(id, row.name, row.detectJson, row.actionJson, row.sourceAttributionId, row.createdAt ?? Date.now());
    return id;
  }

  toggleRecoveryRule(id: string, enabled: boolean): boolean {
    const res = this.db.prepare('UPDATE recovery_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return res.changes > 0;
  }

  deleteRecoveryRule(id: string): boolean {
    const res = this.db.prepare('DELETE FROM recovery_rules WHERE id = ?').run(id);
    return res.changes > 0;
  }

  incrementRecoverySuccess(id: string): void {
    this.db.prepare('UPDATE recovery_rules SET successCount = successCount + 1 WHERE id = ?').run(id);
  }

  incrementRecoveryFail(id: string): void {
    this.db.prepare('UPDATE recovery_rules SET failCount = failCount + 1 WHERE id = ?').run(id);
  }

  // ---------- Prompt 版本 CRUD ----------

  listPromptVersions(): PromptVersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM prompt_versions ORDER BY createdAt DESC')
      .all() as Array<Omit<PromptVersionRow, 'active'> & { active: number }>;
    return rows.map((r) => ({ ...r, active: r.active === 1 }));
  }

  getActivePromptVersion(): PromptVersionRow | null {
    const row = this.db
      .prepare('SELECT * FROM prompt_versions WHERE active = 1 LIMIT 1')
      .get() as (Omit<PromptVersionRow, 'active'> & { active: number }) | undefined;
    return row ? { ...row, active: row.active === 1 } : null;
  }

  insertPromptVersion(row: Omit<PromptVersionRow, 'id' | 'createdAt' | 'active'> & { id?: string; createdAt?: number }): string {
    const id = row.id ?? crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO prompt_versions (id, label, guidance, origin, benchmarkJson, approvalId, active, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, row.label, row.guidance, row.origin, row.benchmarkJson, row.approvalId, row.createdAt ?? Date.now());
    return id;
  }

  activatePromptVersion(id: string, approvalId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE prompt_versions SET active = 0').run();
      this.db.prepare('UPDATE prompt_versions SET active = 1, approvalId = ? WHERE id = ?').run(approvalId, id);
    })();
  }

  deactivateAllPromptVersions(): void {
    this.db.prepare('UPDATE prompt_versions SET active = 0').run();
  }

  updatePromptBenchmark(id: string, benchmarkJson: string): void {
    this.db.prepare('UPDATE prompt_versions SET benchmarkJson = ? WHERE id = ?').run(benchmarkJson, id);
  }

  // ---------- 自定义工具 CRUD ----------

  listCustomTools(): CustomToolRow[] {
    return this.db.prepare('SELECT * FROM custom_tools ORDER BY createdAt DESC').all() as CustomToolRow[];
  }

  insertCustomTool(row: Omit<CustomToolRow, 'id' | 'createdAt' | 'status'> & { id?: string; createdAt?: number; status?: string }): string {
    const id = row.id ?? crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO custom_tools (id, name, description, schemaJson, scriptPath, proposalJson, approvalId, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, row.name, row.description, row.schemaJson, row.scriptPath,
      row.proposalJson, row.approvalId, row.status ?? 'proposed', row.createdAt ?? Date.now());
    return id;
  }

  toggleCustomTool(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE custom_tools SET status = ? WHERE id = ?').run(enabled ? 'approved' : 'disabled', id);
  }

  setCustomToolScriptPath(id: string, scriptPath: string): void {
    this.db.prepare('UPDATE custom_tools SET scriptPath = ? WHERE id = ?').run(scriptPath, id);
  }

  setCustomToolApproval(id: string, approvalId: string): void {
    this.db.prepare('UPDATE custom_tools SET approvalId = ? WHERE id = ?').run(approvalId, id);
  }

  updateCustomToolSchema(id: string, schemaJson: string): void {
    this.db.prepare('UPDATE custom_tools SET schemaJson = ? WHERE id = ?').run(schemaJson, id);
  }

  // ---------- Prompt 版本种子初始化 ----------

  /** 如果 prompt_versions 表为空，插入一个初始版本 */
  seedInitialPromptVersion(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM prompt_versions').get() as { c: number }).c;
    if (count > 0) return;
    this.db.prepare(`
      INSERT INTO prompt_versions (id, label, guidance, origin, benchmarkJson, approvalId, active, createdAt)
      VALUES (?, ?, ?, ?, ?, NULL, 1, ?)
    `).run(
      'prompt-v1-default',
      'v1 默认',
      '你是一个智能桌面助手。请通过截图感知屏幕、分析当前状态、选择最佳工具来完成任务。',
      'human',
      null,
      Date.now(),
    );
  }
}
