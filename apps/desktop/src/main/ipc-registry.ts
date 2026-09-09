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

import { registerIslandHandlers } from './ipc/island.handlers';
import { registerExtendedHandlers } from './ipc/island-extended-handlers';
import { registerSmartHandlers } from './ipc/island-smart-handlers';
import { registerExperienceHandlers } from './ipc/island-experience-handlers';
import { registerEvolutionHandlers } from './ipc/island-evolution-handlers';
import { registerEmployeeHandlers } from './ipc/island-employee-handlers';
import { registerMissionHandlers } from './ipc/mission-handlers';
import { exportAuditToFile } from './audit-export';
import { applyConfigUpdate, sanitizeConfig } from './config-sync';
import { coerceArgs } from './island-bridge';

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
}

/** 全量 IPC 注册（岛核心 + 面板 + 扩展通道） */
export function registerIsland(deps: IpcRegistryDeps): void {
  const {
    orchestrator, configStore, auditDb, memoryStore,
    conversationStore, scheduler, experienceStore, employeeStore, missionRepo,
  } = deps;

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
    },
  });

  registerExtendedHandlers({ orchestrator, store: configStore, audit: auditDb });
  registerSmartHandlers({ orchestrator, store: configStore, audit: auditDb, memory: memoryStore, conversation: conversationStore, scheduler });
  registerExperienceHandlers({ experience: experienceStore, audit: auditDb, orchestrator, store: configStore });
  registerEvolutionHandlers({ experience: experienceStore, audit: auditDb, orchestrator, tools: orchestrator.customTools, toolsDir: orchestrator.toolsDir, employee: employeeStore });
  registerEmployeeHandlers({ employee: employeeStore, audit: auditDb, store: configStore });
  registerMissionHandlers({ db: auditDb.exposeDb(), repo: missionRepo });
}
