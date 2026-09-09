/**
 * island-experience-handlers.ts — 世界模型 IPC
 *
 * 全部 payload 主进程侧 Zod 复校，统一 { ok, data | error } 返回。
 */
import { ipcMain, app } from "electron";
import {
  ISLAND_CHANNELS,
  WorldModelAddSchema,
  WorldModelSearchSchema,
} from "../../shared/island-contracts";
import type { EnvFactRowPayload } from "../../shared/island-contracts";
import type { ExperienceStore } from "../experience-store";
import type { ZODB } from "../audit-store";
import type { Orchestrator } from "../orchestrator";
import type { Store } from "../config-store";
import type { ILLMClient, ChatMessage } from "@ximo-visagent/llm-providers";
import { makeClients } from "../orchestrator-clients";
import { scanEnvironment, type EnvProfile } from "../onboarding";

export interface ExperienceDeps {
  experience: ExperienceStore;
  audit: ZODB;
  orchestrator: Orchestrator;
  store: Store;
}

let expRegistered = false;

export function registerExperienceHandlers(deps: ExperienceDeps): void {
  if (expRegistered) return;
  expRegistered = true;

  // ---- 世界模型 ----
  ipcMain.handle(ISLAND_CHANNELS.worldmodelAdd, (_e, raw: unknown) => {
    const parsed = WorldModelAddSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    try {
      // 去重：同 kind 下 Jaccard 相似度 >= 0.35 视为已有事实
      const existing = deps.experience.findSimilarFact(parsed.data.content, parsed.data.kind);
      if (existing) {
        // 更新已有事实：timesObserved+1、lastVerifiedAt 刷新、confidence 略增
        deps.experience.updateEnvFact(existing.id, {
          timesObserved: existing.timesObserved + 1,
          lastVerifiedAt: Date.now(),
          confidence: Math.min(1, existing.confidence + 0.05),
        });
        return { ok: true as const, data: { id: existing.id } };
      }
      const id = deps.experience.insertEnvFact({
        kind: parsed.data.kind,
        content: parsed.data.content,
        confidence: 0.6,
        timesObserved: 1,
        sourceTaskId: null,
        lastVerifiedAt: null,
        enabled: true,
      });
      return { ok: true as const, data: { id } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "add failed" };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.worldmodelSearch, (_e, raw: unknown) => {
    const parsed = WorldModelSearchSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    try {
      const items = parsed.data.query
        ? deps.experience.searchEnvFacts(parsed.data.query, parsed.data.kind)
        : deps.experience.listEnvFacts(parsed.data.kind);
      return { ok: true as const, data: { items: items as EnvFactRowPayload[] } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "search failed" };
    }
  });

  // ---- 世界模型：快速扫描环境 ----
  ipcMain.handle(ISLAND_CHANNELS.worldmodelScan, async () => {
    try {
      const cfg = deps.store.getAgent();
      const { text: llm } = makeClients(cfg);
      const workspaceDir = deps.store.get().workspaceDir || app.getPath('userData');

      const profile = scanEnvironment(workspaceDir);
      const facts = await extractEnvFacts(llm, profile);

      let added = 0;
      let updated = 0;
      for (const f of facts) {
        const existing = deps.experience.findSimilarFact(f.content, f.kind);
        if (existing) {
          // 更新已有事实：timesObserved+1、lastVerifiedAt 刷新、confidence 略增
          deps.experience.updateEnvFact(existing.id, {
            timesObserved: existing.timesObserved + 1,
            lastVerifiedAt: Date.now(),
            confidence: Math.min(1, existing.confidence + 0.03),
          });
          updated++;
          continue;
        }
        deps.experience.insertEnvFact({
          kind: f.kind,
          content: f.content,
          confidence: 0.55,
          timesObserved: 1,
          sourceTaskId: null,
          lastVerifiedAt: Date.now(),
          enabled: true,
        });
        added++;
      }

      return { ok: true as const, data: { added, updated } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "scan failed" };
    }
  });
}

// ---------- LLM 提炼 ----------

interface ExtractedFact {
  kind: 'app' | 'login' | 'path' | 'workflow' | 'preference' | 'ui-convention' | 'fact';
  content: string;
}

const VALID_KINDS = new Set(['app', 'login', 'path', 'workflow', 'preference', 'ui-convention', 'fact']);

async function extractEnvFacts(llm: ILLMClient, profile: EnvProfile): Promise<ExtractedFact[]> {
  const systemPrompt = `你是一个环境分析助手。根据以下环境扫描结果，提炼出对桌面自动化 Agent 有用的结构化事实。

环境信息：
- 工作目录: ${profile.workspaceDir}
- 已安装应用 (${profile.apps.length} 个): ${profile.apps.slice(0, 30).join(', ')}
- 工作目录子目录 (${profile.dirs.length} 个): ${profile.dirs.join(', ')}

请输出 JSON 数组，每条事实包含：
- kind: 分类，必须是以下之一: "app"(应用信息), "login"(登录信息), "path"(路径信息), "workflow"(工作流程), "preference"(偏好设置), "ui-convention"(UI约定), "fact"(通用事实)
- content: 事实陈述（一句话，具体可操作）

示例：
[{"kind":"app","content":"已安装 Chrome 浏览器，可用于网页操作"},{"kind":"path","content":"工作目录 D:\\projects 下有 src、docs、test 三个子目录"}]

只输出 JSON 数组，不要多余文本。最多 20 条事实。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请分析环境并提取事实。' },
  ];

  try {
    const res = await llm.chat(messages);
    const text = res.content?.trim() ?? '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedFact[];
    return parsed.filter(
      (f) => f.content && VALID_KINDS.has(f.kind),
    );
  } catch {
    return [];
  }
}
