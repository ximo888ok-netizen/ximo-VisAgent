/**
 * island-smart-handlers.ts — 智能功能 IPC（记忆/统计/定时/SOP导入导出/推荐/续跑/会话/教学录制）
 *
 * 依赖注入：orchestrator / configStore / auditStore / memoryStore / conversationStore / scheduler。
 * 所有 payload 主进程侧 Zod 复校，统一 { ok, data | error } 返回。
 */
import { ipcMain } from "electron";
import {
  ISLAND_CHANNELS,
  MemoryToggleSchema,
  MemoryDeleteSchema,
  StatsQuerySchema,
  SchedulerCreateSchema,
  SchedulerToggleSchema,
  SchedulerDeleteSchema,
  SopExportSchema,
  SopImportSchema,
  RecommendSopSchema,
  ResumeInterruptedSchema,
  SaveSopStepsSchema,
} from "../../shared/island-contracts";
import type {
  MemoryRowPayload,
  ScheduledJobPayload,
  StatsResultPayload,
  RecommendResultPayload,
  TaskStartedResult,
} from "../../shared/island-contracts";
import type { Store } from "../config-store";
import type { ZODB } from "../audit-store";
import type { Orchestrator } from "../orchestrator";
import type { MemoryStore } from "../memory-store";
import type { ConversationStore } from "../conversation-store";
import type { Scheduler } from "../scheduler";
import { computeStats, recommendSop } from "../task-insights";
import { parseRecordedStep, safeParseVariables, type SopExportFormat } from "../sop-format";

export interface SmartDeps {
  orchestrator: Orchestrator;
  store: Store;
  audit: ZODB;
  memory: MemoryStore;
  conversation: ConversationStore;
  scheduler: Scheduler;
}

let smartRegistered = false;

export function registerSmartHandlers(deps: SmartDeps): void {
  if (smartRegistered) return;
  smartRegistered = true;

  // ---- 记忆 ----
  ipcMain.handle(ISLAND_CHANNELS.memoryList, () => {
    try {
      const data = deps.memory.list() as MemoryRowPayload[];
      return { ok: true as const, data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "list failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.memoryToggle, (_e, raw: unknown) => {
    const parsed = MemoryToggleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    return deps.memory.toggle(parsed.data.id, parsed.data.enabled)
      ? { ok: true }
      : { ok: false, error: "记忆条目不存在" };
  });

  ipcMain.handle(ISLAND_CHANNELS.memoryDelete, (_e, raw: unknown) => {
    const parsed = MemoryDeleteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    return deps.memory.delete(parsed.data.id) ? { ok: true } : { ok: false, error: "记忆条目不存在" };
  });

  ipcMain.handle(ISLAND_CHANNELS.memoryClear, () => {
    deps.memory.clear();
    return { ok: true };
  });

  // ---- 统计 ----
  ipcMain.handle(ISLAND_CHANNELS.statsGet, (_e, raw: unknown) => {
    const parsed = StatsQuerySchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    try {
      const data = computeStats(deps.audit, parsed.data.days ?? 30) as StatsResultPayload;
      return { ok: true as const, data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "stats failed" };
    }
  });

  // ---- 定时任务 ----
  ipcMain.handle(ISLAND_CHANNELS.schedulerList, () => {
    try {
      const data = deps.scheduler.list() as ScheduledJobPayload[];
      return { ok: true as const, data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "list failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.schedulerCreate, (_e, raw: unknown) => {
    const parsed = SchedulerCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid payload" };
    try {
      if (deps.store.get().schedulerEnabled === false) {
        return { ok: false as const, error: "定时任务已在设置中全局关闭" };
      }
      const job = deps.scheduler.create(parsed.data);
      return { ok: true as const, data: { id: job.id } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "create failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.schedulerToggle, (_e, raw: unknown) => {
    const parsed = SchedulerToggleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    return deps.scheduler.toggle(parsed.data.id, parsed.data.enabled)
      ? { ok: true }
      : { ok: false, error: "定时任务不存在" };
  });

  ipcMain.handle(ISLAND_CHANNELS.schedulerDelete, (_e, raw: unknown) => {
    const parsed = SchedulerDeleteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    return deps.scheduler.delete(parsed.data.id) ? { ok: true } : { ok: false, error: "定时任务不存在" };
  });

  // ---- SOP 导入导出 ----
  ipcMain.handle(ISLAND_CHANNELS.sopExport, (_e, raw: unknown) => {
    const parsed = SopExportSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    const sop = deps.audit.getSop(parsed.data.sopId);
    if (!sop) return { ok: false as const, error: "模板不存在" };
    const payload: SopExportFormat = {
      format: "ximo-visagent-sop",
      version: 1,
      name: sop.name,
      description: sop.description,
      goalTemplate: sop.goalTemplate,
      stepsJson: sop.stepsJson,
      variablesJson: sop.variablesJson,
    };
    return { ok: true as const, data: { json: JSON.stringify(payload, null, 2) } };
  });

  ipcMain.handle(ISLAND_CHANNELS.sopImport, (_e, raw: unknown) => {
    const parsed = SopImportSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    let obj: SopExportFormat;
    try {
      obj = JSON.parse(parsed.data.json) as SopExportFormat;
    } catch {
      return { ok: false as const, error: "JSON 解析失败，请检查文件内容" };
    }
    if (obj?.format !== "ximo-visagent-sop" || typeof obj.name !== "string" || !obj.name.trim()) {
      return { ok: false as const, error: "不是有效的 ximo-VisAgent 模板文件" };
    }
    // 步骤合法性校验
    try {
      const steps = JSON.parse(obj.stepsJson ?? "[]") as unknown[];
      if (!Array.isArray(steps)) throw new Error("steps");
    } catch {
      return { ok: false as const, error: "模板步骤数据损坏" };
    }
    const id = deps.audit.saveSop({
      name: obj.name.trim().slice(0, 80),
      description: typeof obj.description === "string" ? obj.description.slice(0, 200) : "",
      goalTemplate: typeof obj.goalTemplate === "string" ? obj.goalTemplate.slice(0, 2000) : "",
      steps: JSON.parse(obj.stepsJson ?? "[]") as unknown[],
      variables: safeParseVariables(obj.variablesJson),
    });
    return { ok: true as const, data: { id, name: obj.name } };
  });

  // ---- SOP 相似推荐 ----
  ipcMain.handle(ISLAND_CHANNELS.recommendSop, (_e, raw: unknown) => {
    const parsed = RecommendSopSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    const best = recommendSop(deps.audit.listSops(), parsed.data.goal) as RecommendResultPayload | null;
    return { ok: true as const, data: best };
  });

  // ---- 断点续跑 ----
  ipcMain.handle(ISLAND_CHANNELS.listInterrupted, () => {
    try {
      const active = new Set([...deps.orchestrator.runningTaskIds, ...deps.orchestrator.queuedTaskIds]);
      const rows = deps.audit.listTasks(200).filter(
        (t) =>
          !active.has(t.taskId) &&
          ["RUNNING", "QUEUED", "PAUSED", "WAITING_APPROVAL"].includes(t.status),
      );
      const data = rows.map((t) => ({
        taskId: t.taskId,
        goal: t.goal,
        steps: deps.audit.getTaskSteps(t.taskId).length,
        status: t.status,
      }));
      return { ok: true as const, data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "query failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.resumeInterrupted, async (_e, raw: unknown) => {
    const parsed = ResumeInterruptedSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    try {
      const res = await deps.orchestrator.resumeInterrupted(parsed.data.taskId);
      const data: TaskStartedResult = {
        taskId: res.taskId,
        goal: res.goal,
        queued: res.queued,
        queuedIndex: res.queuedIndex,
      };
      return { ok: true as const, data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "resume failed" };
    }
  });

  // ---- 会话上下文 ----
  ipcMain.handle(ISLAND_CHANNELS.conversationInfo, () => {
    return { ok: true as const, data: deps.conversation.info() };
  });

  ipcMain.handle(ISLAND_CHANNELS.conversationClear, () => {
    deps.conversation.clear();
    return { ok: true };
  });

  // ---- 教学模式录制 → SOP ----
  ipcMain.handle(ISLAND_CHANNELS.saveSopSteps, (_e, raw: unknown) => {
    const parsed = SaveSopStepsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid payload" };
    try {
      const steps = parsed.data.steps.map((s, i) => parseRecordedStep(s, i + 1));
      const id = deps.audit.saveSop({
        name: parsed.data.name,
        description: parsed.data.description ?? "教学模式录制",
        goalTemplate: parsed.data.steps.join(" ; ").slice(0, 2000),
        steps,
      });
      return { ok: true as const, data: { id } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "save failed" };
    }
  });
}
