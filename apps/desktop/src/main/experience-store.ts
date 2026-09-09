// v3 经验层存储门面：共享 ZODB 内部同一 better-sqlite3 Database 实例
// 实现按域拆分到 ./stores/（attribution / skill-world / evolution），本文件只做门面委托。
import type Database from 'better-sqlite3';
import { AttributionStore } from './stores/attribution-store';
import { SkillWorldStore } from './stores/skill-world-store';
import { EvolutionStore } from './stores/evolution-store';
import type {
  AttributionRecord,
  BenchmarkRow,
  SkillRunRecord,
  EnvFactRow,
  RecoveryRuleRow,
  PromptVersionRow,
  CustomToolRow,
} from './stores/experience-types';

export type {
  AttributionRecord,
  BenchmarkRow,
  SkillRunRecord,
  EnvFactRow,
  RecoveryRuleRow,
  PromptVersionRow,
  CustomToolRow,
} from './stores/experience-types';

export class ExperienceStore {
  private attribution: AttributionStore;
  private skillWorld: SkillWorldStore;
  private evolution: EvolutionStore;

  constructor(db: Database.Database) {
    this.attribution = new AttributionStore(db);
    this.skillWorld = new SkillWorldStore(db);
    this.evolution = new EvolutionStore(db);
  }

  // ---------- 归因 ----------

  insertAttribution(rec: AttributionRecord): void {
    this.attribution.insertAttribution(rec);
  }

  listAttributions(...args: Parameters<AttributionStore['listAttributions']>): ReturnType<AttributionStore['listAttributions']> {
    return this.attribution.listAttributions(...args);
  }

  getAttribution(taskId: string): ReturnType<AttributionStore['getAttribution']> {
    return this.attribution.getAttribution(taskId);
  }

  updateAttributionVerdict(...args: Parameters<AttributionStore['updateAttributionVerdict']>): void {
    this.attribution.updateAttributionVerdict(...args);
  }

  // ---------- 基准 ----------

  saveBenchmark(row: Parameters<AttributionStore['saveBenchmark']>[0]): string {
    return this.attribution.saveBenchmark(row);
  }

  listBenchmarks(): BenchmarkRow[] {
    return this.attribution.listBenchmarks();
  }

  getBenchmark(id: string): BenchmarkRow | null {
    return this.attribution.getBenchmark(id);
  }

  updateBenchmarkResult(id: string, lastRunAt: number, lastResult: string): void {
    this.attribution.updateBenchmarkResult(id, lastRunAt, lastResult);
  }

  // ---------- 技能运行 ----------

  insertSkillRun(rec: SkillRunRecord): void {
    this.skillWorld.insertSkillRun(rec);
  }

  listSkillRuns(sopId: string, limit = 20): SkillRunRecord[] {
    return this.skillWorld.listSkillRuns(sopId, limit);
  }

  // ---------- SOP 生命周期 ----------

  updateSopStatus(sopId: string, status: string): void {
    this.skillWorld.updateSopStatus(sopId, status);
  }

  incrementSopSuccess(sopId: string): void {
    this.skillWorld.incrementSopSuccess(sopId);
  }

  incrementSopFail(sopId: string): void {
    this.skillWorld.incrementSopFail(sopId);
  }

  setSopPromoted(sopId: string, promotedAt: number): void {
    this.skillWorld.setSopPromoted(sopId, promotedAt);
  }

  // ---------- 世界模型 ----------

  listEnvFacts(kind?: string): EnvFactRow[] {
    return this.skillWorld.listEnvFacts(kind);
  }

  searchEnvFacts(query: string, kind?: string): EnvFactRow[] {
    return this.skillWorld.searchEnvFacts(query, kind);
  }

  insertEnvFact(row: Parameters<SkillWorldStore['insertEnvFact']>[0]): string {
    return this.skillWorld.insertEnvFact(row);
  }

  updateEnvFact(id: string, updates: Parameters<SkillWorldStore['updateEnvFact']>[1]): void {
    this.skillWorld.updateEnvFact(id, updates);
  }

  findSimilarFact(content: string, kind?: string): EnvFactRow | null {
    return this.skillWorld.findSimilarFact(content, kind);
  }

  toggleEnvFact(id: string, enabled: boolean): boolean {
    return this.skillWorld.toggleEnvFact(id, enabled);
  }

  deleteEnvFact(id: string): boolean {
    return this.skillWorld.deleteEnvFact(id);
  }

  clearEnvFacts(): void {
    this.skillWorld.clearEnvFacts();
  }

  // ---------- 恢复规则 ----------

  listRecoveryRules(): RecoveryRuleRow[] {
    return this.evolution.listRecoveryRules();
  }

  insertRecoveryRule(row: Parameters<EvolutionStore['insertRecoveryRule']>[0]): string {
    return this.evolution.insertRecoveryRule(row);
  }

  toggleRecoveryRule(id: string, enabled: boolean): boolean {
    return this.evolution.toggleRecoveryRule(id, enabled);
  }

  deleteRecoveryRule(id: string): boolean {
    return this.evolution.deleteRecoveryRule(id);
  }

  incrementRecoverySuccess(id: string): void {
    this.evolution.incrementRecoverySuccess(id);
  }

  incrementRecoveryFail(id: string): void {
    this.evolution.incrementRecoveryFail(id);
  }

  // ---------- Prompt 版本 ----------

  listPromptVersions(): PromptVersionRow[] {
    return this.evolution.listPromptVersions();
  }

  getActivePromptVersion(): PromptVersionRow | null {
    return this.evolution.getActivePromptVersion();
  }

  insertPromptVersion(row: Parameters<EvolutionStore['insertPromptVersion']>[0]): string {
    return this.evolution.insertPromptVersion(row);
  }

  activatePromptVersion(id: string, approvalId: string): void {
    this.evolution.activatePromptVersion(id, approvalId);
  }

  deactivateAllPromptVersions(): void {
    this.evolution.deactivateAllPromptVersions();
  }

  updatePromptBenchmark(id: string, benchmarkJson: string): void {
    this.evolution.updatePromptBenchmark(id, benchmarkJson);
  }

  // ---------- 自定义工具 ----------

  listCustomTools(): CustomToolRow[] {
    return this.evolution.listCustomTools();
  }

  insertCustomTool(row: Parameters<EvolutionStore['insertCustomTool']>[0]): string {
    return this.evolution.insertCustomTool(row);
  }

  toggleCustomTool(id: string, enabled: boolean): void {
    this.evolution.toggleCustomTool(id, enabled);
  }

  setCustomToolScriptPath(id: string, scriptPath: string): void {
    this.evolution.setCustomToolScriptPath(id, scriptPath);
  }

  setCustomToolApproval(id: string, approvalId: string): void {
    this.evolution.setCustomToolApproval(id, approvalId);
  }

  updateCustomToolSchema(id: string, schemaJson: string): void {
    this.evolution.updateCustomToolSchema(id, schemaJson);
  }

  // ---------- 宪法门提案 ----------

  insertMetaProposal(row: Parameters<EvolutionStore['insertMetaProposal']>[0]): void {
    this.evolution.insertMetaProposal(row);
  }

  getMetaProposal(id: string): ReturnType<EvolutionStore['getMetaProposal']> {
    return this.evolution.getMetaProposal(id);
  }

  getPendingMetaProposal(targetId: string): ReturnType<EvolutionStore['getPendingMetaProposal']> {
    return this.evolution.getPendingMetaProposal(targetId);
  }

  listMetaProposals(...args: Parameters<EvolutionStore['listMetaProposals']>): ReturnType<EvolutionStore['listMetaProposals']> {
    return this.evolution.listMetaProposals(...args);
  }

  updateMetaProposal(id: string, updates: Parameters<EvolutionStore['updateMetaProposal']>[1]): boolean {
    return this.evolution.updateMetaProposal(id, updates);
  }

  getMetaState(): ReturnType<EvolutionStore['getMetaState']> {
    return this.evolution.getMetaState();
  }

  setMetaState(state: Parameters<EvolutionStore['setMetaState']>[0]): void {
    this.evolution.setMetaState(state);
  }

  // ---------- 统计 ----------

  countAttributions(since: number): ReturnType<AttributionStore['countAttributions']> {
    return this.attribution.countAttributions(since);
  }

  countSkillRuns(since: number): ReturnType<SkillWorldStore['countSkillRuns']> {
    return this.skillWorld.countSkillRuns(since);
  }

  // ---------- 种子 ----------

  seedInitialPromptVersion(): void {
    this.evolution.seedInitialPromptVersion();
  }
}
