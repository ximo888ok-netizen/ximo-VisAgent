/**
 * bootstrap.ts — 启动序列初始化
 *
 * 从 index.ts 提取的 whenReady 内启动逻辑：
 * - 自检/E2E/坐标链路诊断分支
 * - 自定义工具恢复
 * - UIA sidecar 启动
 * - 灵动岛 + Aura + 托盘 + 热键 + IPC 注册
 * - 微信 Bot 接线
 */
import type { Orchestrator } from './orchestrator';
import type { ZODB } from './audit-store';
import type { ExperienceStore } from './experience-store';
import type { Store as ConfigStore } from './config-store';
import type { MemoryStore } from './memory-store';
import type { ConversationStore } from './conversation-store';
import type { Scheduler } from './scheduler';
import type { EmployeeStore } from './stores/employee-store';
import type { WeChatBot } from './wechat-bot';
import type { MissionRepo } from './mission-db/mission-repo';

import { screen } from 'electron';
import { showSplash, updateSplashStage } from './windows/splash';
import { loadIslandWindow } from './windows/island-loader';
import { getIslandWindow, isForegroundFullscreen } from './windows/island';
import { initAura } from './windows/aura';
import { auraSetIntensity, auraIslandGeometry, auraSetFullscreenProbe, auraSetApprovalMode } from './aura-state';
import { createTray } from './tray';
import { registerHotkeys } from './hotkeys';
import { registerAuraHandlers } from './ipc/aura-handlers';
import { registerIsland } from './ipc-registry';
import { loadApprovedTools } from './custom-tools';
import { scheduleStartupDiagnostics } from './diagnostics';
import { scheduleE2ERun } from './e2e-runner';
import { registerWeChatHandlers } from './ipc/wechat-handlers';
import { setWeChatNotifier } from './orchestrator-notify';

export interface BootstrapDeps {
  orchestrator: Orchestrator;
  auditDb: ZODB;
  experienceStore: ExperienceStore;
  configStore: ConfigStore;
  memoryStore: MemoryStore;
  conversationStore: ConversationStore;
  scheduler: Scheduler;
  employeeStore: EmployeeStore;
  missionRepo: MissionRepo;
  wechatBot: WeChatBot;
  wechatCfg: { enabled: boolean; allowedWxids: string[]; commandPrefix: string; notifyOnFinish: boolean; notifyOnApproval: boolean };
  uiaClient: { start: () => Promise<void>; stop: () => void };
  isE2E: boolean;
  isSelfTest: boolean;
}

/**
 * 应用就绪后的启动序列。
 * 调用方负责在 app.whenReady() 中调用此函数。
 */
export async function bootstrap(deps: BootstrapDeps): Promise<void> {
  const {
    orchestrator, auditDb, experienceStore, configStore,
    memoryStore, conversationStore, scheduler, employeeStore, missionRepo,
    wechatBot, wechatCfg, uiaClient, isE2E, isSelfTest,
  } = deps;

  showSplash();
  updateSplashStage('恢复自定义工具', 0.4);

  try {
    const { loaded, failed } = loadApprovedTools(
      orchestrator.customTools,
      experienceStore.listCustomTools(),
    );
    if (loaded.length > 0) console.log('[main] 自定义工具已注册:', loaded.join(', '));
    if (failed.length > 0) console.warn('[main] 自定义工具加载失败（已禁用）:', failed.join(', '));
  } catch (err) {
    console.error('[main] 自定义工具恢复失败', err);
  }

  updateSplashStage('启动感知服务', 0.65);
  try {
    await uiaClient.start();
    console.log('[main] UIA sidecar started');
  } catch (err) {
    console.error('[main] UIA sidecar start failed', err);
  }

  updateSplashStage('唤醒灵动岛', 0.9);
  loadIslandWindow();
  initAura();
  registerAuraHandlers();
  auraSetIntensity(configStore.get().auraIntensity ?? 'full');
  auraSetApprovalMode(configStore.get().approvalMode);
  createTray(orchestrator);
  registerHotkeys(configStore, orchestrator);
  registerIsland({
    orchestrator,
    configStore,
    auditDb,
    memoryStore,
    conversationStore,
    scheduler,
    experienceStore,
    employeeStore,
    missionRepo,
  });

  auraSetFullscreenProbe(isForegroundFullscreen);
  scheduleStartupDiagnostics(isForegroundFullscreen);
  setInterval(() => {
    if (isSelfTest || isE2E) return;
    const island = getIslandWindow();
    if (island && !island.isDestroyed()) {
      const b = island.getBounds();
      auraIslandGeometry(b.x + b.width / 2, screen.getDisplayMatching(b).bounds.width);
    }
  }, 1500);

  if (configStore.get().schedulerEnabled !== false) {
    scheduler.start();
  }

  if (wechatCfg.enabled) {
    try {
      await wechatBot.start();
      console.log('[main] WeChat Bot 等待扫码登录...');
    } catch (err) {
      console.error('[main] WeChat Bot start failed', err);
    }
  }

  wechatBot.on('message', (msg: { content: string }) => {
    if (!wechatBot.isCommand(msg.content)) return;
    const goal = wechatBot.extractCommand(msg.content);
    if (!goal) return;
    orchestrator.startTask(goal).then((res) => {
      console.log(`[wechat-bot] 任务已提交: ${res.taskId} (goal: ${goal.slice(0, 60)})`);
    }).catch((err) => {
      console.error('[wechat-bot] 任务提交失败', err);
    });
  });

  registerWeChatHandlers({
    getIslandWindow: () => getIslandWindow(),
    wechatBot,
    store: configStore,
  });

  setWeChatNotifier(wechatBot, {
    notifyOnFinish: wechatCfg.notifyOnFinish,
    notifyOnApproval: wechatCfg.notifyOnApproval,
  });

  if (isE2E) {
    scheduleE2ERun(orchestrator, auditDb);
  }
}
