/**
 * island-extended-handlers.ts — R1/R2 扩展 IPC（SOP/回放/规则模拟/目录选择/连通性）
 */
import { ipcMain, dialog } from "electron";
import {
  ISLAND_CHANNELS,
  SopRowSchema,
  SaveSopSchema,
  RunSopSchema,
  DeleteSopSchema,
  ReplayImageSchema,
  SimulateRuleSchema,
  TestLlmSchema,
} from "../../shared/island-contracts";
import type { SopRowPayload, SimulateRuleResult, TestLlmResult } from "../../shared/island-contracts";
import type { Store } from "../config-store";
import type { ZODB } from "../audit-store";
import type { Orchestrator } from "../orchestrator";
import { SafetyClassifier } from "@ximo-visagent/safety";
import { OpenAIClient } from "@ximo-visagent/llm-providers";

export interface ExtendedDeps {
  orchestrator: Orchestrator;
  store: Store;
  audit: ZODB;
}

let registered = false;

export function registerExtendedHandlers(deps: ExtendedDeps): void {
  if (registered) return;
  registered = true;

  // ---- SOP ----
  ipcMain.handle(ISLAND_CHANNELS.listSops, () => {
    try {
      const rows = deps.audit.listSops();
      const parsed = rows.map((r) => SopRowSchema.safeParse(r));
      const data = parsed.filter((p) => p.success).map((p) => p.data as SopRowPayload);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "list failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.saveSopFromTask, (_event, raw: unknown) => {
    const parsed = SaveSopSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    try {
      const id = deps.orchestrator.saveSopFromTask(parsed.data.taskId, parsed.data.name, parsed.data.description);
      return { ok: true, data: { id } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.runSop, async (_event, raw: unknown) => {
    const parsed = RunSopSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    try {
      const result = await deps.orchestrator.runSop(parsed.data.sopId, parsed.data.goal, parsed.data.variables);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "run failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.deleteSop, (_event, raw: unknown) => {
    const parsed = DeleteSopSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    deps.audit.deleteSop(parsed.data.sopId);
    return { ok: true };
  });

  // ---- 回放 ----
  ipcMain.handle(ISLAND_CHANNELS.replayImage, (_event, raw: unknown) => {
    const parsed = ReplayImageSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    const dataUrl = deps.audit.readReplayImage(parsed.data.taskId, parsed.data.stepIndex);
    if (!dataUrl) return { ok: false, error: "无该步骤截图" };
    return { ok: true, data: { dataUrl } };
  });

  // ---- 规则模拟器 ----
  ipcMain.handle(ISLAND_CHANNELS.simulateRule, (_event, raw: unknown) => {
    const parsed = SimulateRuleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    // 用当前配置规则构造分类器（与任务执行时一致）
    const classifier = new SafetyClassifier(undefined, deps.store.get().safetyRules);
    const classified = classifier.classify(
      { name: parsed.data.tool, args: parsed.data.args },
      parsed.data.appName,
      parsed.data.domain,
    );
    const disposition = classified.level >= 3
      ? "默认禁止（需在设置中显式解锁）"
      : classified.level === 2
        ? "需要人工审批（HITL）"
        : classified.level === 1
          ? "自动放行（常规操作）"
          : "自动放行（只读观察）";
    const result: SimulateRuleResult = { level: classified.level, reason: classified.reason, disposition };
    return { ok: true, data: result };
  });

  // ---- 工作目录选择 ----
  ipcMain.handle(ISLAND_CHANNELS.pickWorkspaceDir, async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: "已取消" };
    return { ok: true, data: { dir: res.filePaths[0] } };
  });

  // ---- LLM 连通性测试（1 次真实调用） ----
  ipcMain.handle(ISLAND_CHANNELS.testLlmConnectivity, async (_event, raw: unknown) => {
    const parsed = TestLlmSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid payload" };
    const cfg = deps.store.get().agent[parsed.data.which];
    if (!cfg.apiKey) {
      const r: TestLlmResult = { ok: false, error: "未配置 API Key" };
      return { ok: true, data: r };
    }
    const started = Date.now();
    try {
      const client = new OpenAIClient(cfg);
      const res = await client.chat([{ role: "user", content: "回复「ok」两个字母即可。" }], []);
      const r: TestLlmResult = {
        ok: true,
        latencyMs: Date.now() - started,
        reply: (res.content ?? "").slice(0, 100),
      };
      return { ok: true, data: r };
    } catch (err) {
      const r: TestLlmResult = {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : "调用失败",
      };
      return { ok: true, data: r };
    }
  });
}
