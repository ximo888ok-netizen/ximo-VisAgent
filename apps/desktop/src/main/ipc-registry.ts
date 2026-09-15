/**
 * ipc-registry.ts — 全量 IPC 注册（岛核心 + 面板 + 扩展通道）
 *
 * 从 index.ts 提取的 registerIsland() 函数，集中所有 IPC handler 的依赖注入接线。
 */
import type { Orchestrator } from './orchestrator';
import type { ZODB } from './audit-store';
import type { ExperienceStore } from './experience-store';
import type { Store as ConfigStore } from './config-store';
import type { MemoryStore } from './memory-store';
import type { ConversationStore } from './conversation-store';
import type { Scheduler } from './scheduler';
import type { EmployeeStore } from './stores/employee-store';
import type { MissionRepo } from './mission-db/mission-repo';
import type { MissionRunRepo } from './mission-db/run-repo';
import type { MissionRunner } from './mission-runner';

import { registerIslandHandlers } from './ipc/island.handlers';
import { registerExtendedHandlers } from './ipc/island-extended-handlers';
import { registerSmartHandlers } from './ipc/island-smart-handlers';
import { registerExperienceHandlers } from './ipc/island-experience-handlers';
import { registerEvolutionHandlers } from './ipc/island-evolution-handlers';
import { registerEmployeeHandlers } from './ipc/island-employee-handlers';
import { registerMissionHandlers } from './ipc/mission-handlers';
import { registerAppsHandlers } from './ipc/apps-handlers';
import { registerPreauthHandlers } from './ipc/preauth-handlers';
import { registerLongTaskHandlers } from './ipc/longtask-handlers';
import { getAppCatalogService } from './app-catalog-client';
import { createAppRecentStore } from './app-recent-store';
import { createPreauthStore, type PreauthStore } from './preauth-store';
import { applyLongtaskSchema } from './longtask-db/migrations';
import { applyLongtaskPreauthSchema } from './longtask-db/preauth-migrations';
import { app } from 'electron';
import path from 'node:path';
import { exportAuditToFile } from './audit-export';
import { applyConfigUpdate, sanitizeConfig } from './config-sync';
import { coerceArgs } from './island-bridge';
import type { LongTaskRunner } from './longtask-runner';

export interface IpcRegistryDeps {
  orchestrator: Orchestrator;
  configStore: ConfigStore;
  auditDb: ZODB;
  memoryStore: MemoryStore;
  conversationStore: ConversationStore;
  scheduler: Scheduler;
  experienceStore: ExperienceStore;
  employeeStore: EmployeeStore;
  missionRepo: MissionRepo;
  missionRunRepo: MissionRunRepo;
  missionRunner: MissionRunner;
  /** A-M7：锚定长任务薄壳（bootstrap 组合根装配；null = 未装配，两通道按未锚定降级） */
  longTaskRunner: LongTaskRunner | null;
}

/**
 * preauth_grants 仓储的装配级取用口（A-M7 清单 6）：实例仍由本组合根创建，
 * orchestrator-launch 经此闭包注入 createApprovalGate 的 grantRepo——
 * 审批门与 grant 通道共用同一连接/同一表，不落第二真源。
 * 任务只会在 registerIsland 之后起跑（bootstrap 顺序保证），此前返回 null。
 */
let preauthGrantsInstance: PreauthStore | null = null;

export function getPreauthGrants(): PreauthStore | null {
  return preauthGrantsInstance;
}

/** 全量 IPC 注册（岛核心 + 面板 + 扩展通道） */
export function registerIsland(deps: IpcRegistryDeps): void {
  const {
    orchestrator, configStore, auditDb, memoryStore,
    conversationStore, scheduler, experienceStore, employeeStore, missionRepo,
    missionRunRepo, missionRunner, longTaskRunner,
  } = deps;

  // 应用目录服务（A-M1）：建表必须先于任何 app_recent store 创建（better-sqlite3
  // prepare 在构造期解析 SQL）；面板（chip 绑定成功写入）与 apps:recent 共用同一实例。
  applyLongtaskSchema(auditDb.exposeDb());
  const appRecent = createAppRecentStore(auditDb.exposeDb());
  // 预授权作用域包（A-M6）：独立版本戳域 longtask-preauth，共库互不踩踏
  applyLongtaskPreauthSchema(auditDb.exposeDb());
  const preauthGrants = createPreauthStore(auditDb.exposeDb());
  preauthGrantsInstance = preauthGrants;

  registerIslandHandlers({
    getMainWindow: () => null,
    safety: {
      emergencyStop: () => {
        orchestrator.emergencyStopAll();
        return Promise.resolve();
      },
    },
    onApprovalResult: (result) => {
      switch (result.decision) {
        case 'approved':
          orchestrator.approve(result.approvalKey);
          break;
        case 'rejected':
          orchestrator.reject(result.approvalKey, result.note ?? '用户拒绝');
          break;
        case 'revised':
          orchestrator.editAndApprove(
            result.approvalKey,
            coerceArgs(result.params ?? {}, orchestrator.getApprovalArgs(result.approvalKey)),
          );
          break;
      }
    },
    panelDeps: {
      configStore: {
        getConfig: async () => sanitizeConfig(configStore.get()),
        updateConfig: async (req) => applyConfigUpdate(req, { configStore, audit: auditDb, scheduler }),
      },
      auditStore: {
        queryTasks: async (limit) => auditDb.listTasks(limit),
        queryAudit: async (taskId, limit) => auditDb.query(taskId, limit),
        exportCsv: async () => exportAuditToFile(auditDb, 'csv'),
        exportJson: async () => exportAuditToFile(auditDb, 'json'),
      },
      taskRunner: {
        startTask: async (goal) => {
          const llm = configStore.get().agent.textLLM;
          if (!llm.apiKey) throw new Error('尚未配置模型 API Key：请打开「设置 → 模型」填写并保存');
          if (!llm.baseUrl) throw new Error('尚未配置模型 Base URL：请打开「设置 → 模型」完成配置');
          if (!llm.model) throw new Error('尚未选择模型：请打开「设置 → 模型」完成配置');
          const res = await orchestrator.startTask(goal, undefined, { interactive: true });
          return { taskId: res.taskId, goal, queued: res.queued, queuedIndex: res.queuedIndex };
        },
        cancelTask: async (taskId) => orchestrator.cancelTask(taskId),
        pauseTask: (taskId) => orchestrator.pauseTask(taskId),
        resumeTask: (taskId) => orchestrator.resumeTask(taskId),
        getActiveTasks: () => orchestrator.getActiveTasks(),
      },
      appRecent,
      preauthGrants,
    },
  });

  registerExtendedHandlers({ orchestrator, store: configStore, audit: auditDb });
  registerSmartHandlers({ orchestrator, store: configStore, audit: auditDb, memory: memoryStore, conversation: conversationStore, scheduler });
  registerExperienceHandlers({ experience: experienceStore, audit: auditDb, orchestrator, store: configStore });
  registerEvolutionHandlers({ experience: experienceStore, audit: auditDb, orchestrator, tools: orchestrator.customTools, toolsDir: orchestrator.toolsDir, employee: employeeStore, mission: missionRepo, missionDb: auditDb.exposeDb() });
  registerEmployeeHandlers({ employee: employeeStore, audit: auditDb, store: configStore });
  registerMissionHandlers({ repo: missionRepo, runRepo: missionRunRepo, runner: missionRunner, audit: auditDb, experience: experienceStore });

  // 应用目录服务（A-M1）：专属侧车枚举+图标（低频批量走侧车，规划 §3.4）
  registerAppsHandlers({
    catalog: getAppCatalogService({
      exePath: app.isPackaged ? path.join(process.resourcesPath, 'uia-sidecar.exe') : undefined,
      iconCacheDir: path.join(app.getPath('userData'), 'icon-cache'),
    }),
    recent: appRecent,
  });

  // 预授权作用域包（A-M6）：三通道 + 启动期过期清扫（状态迁移可审计，不做定时器）
  preauthGrants.sweepExpired();
  registerPreauthHandlers({ grants: preauthGrants });

  // 锚定长任务聚合态（A-M7，§4.2/§4.4）：控制条 1s 轮询 status + 恢复预览 checkpoints；
  // 已用步数取审计里有实际动作的步骤（与重试/自动恢复同口径）
  if (longTaskRunner) {
    registerLongTaskHandlers({
      runner: longTaskRunner,
      stepsUsed: (taskId) => orchestrator.getTaskSteps(taskId).filter((s) => s.actionName).length,
    });
  }
}
