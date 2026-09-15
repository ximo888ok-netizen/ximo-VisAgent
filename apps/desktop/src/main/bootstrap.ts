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
import type { WeChatBotConfig } from '@ximo-visagent/shared-types';
import type { WeChatInboundMessage } from './wechat-types';
import { parseApprovalReply, routeApprovalReply } from './wechat-approval-inbound';
import { formatApprovalReplyResult } from './wechat-notify';
import type { MissionRepo } from './mission-db/mission-repo';
import type { MissionRunRepo } from './mission-db/run-repo';
import type { MissionRunner } from './mission-runner';

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
import { createLongTaskRunner, setLongTaskRunner } from './longtask-runner';
import { loadApprovedTools } from './custom-tools';
import { scheduleStartupDiagnostics } from './diagnostics';
import { scheduleE2ERun } from './e2e-runner';
import { registerWeChatHandlers } from './ipc/wechat-handlers';
import { setWeChatNotifier } from './orchestrator-notify';
import { autoResumeInterrupted } from './orchestrator-autoresume';
import { publishStep } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';

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
  missionRunRepo: MissionRunRepo;
  missionRunner: MissionRunner;
  wechatBot: WeChatBot;
  wechatCfg: WeChatBotConfig;
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
    missionRunRepo, missionRunner,
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

  // A-M7 装配（M4 清单）：长任务薄壳必须在 loadApprovedTools 之后创建——
  // reload() 会清空非内置注册表，先建后载会把 checkpoint 工具洗掉；
  // currentTaskId 走单并发恒 1 的纪律（§3.5），排队/未运行返回 null 即静默跳过登记
  const longTaskRunner = createLongTaskRunner({
    db: auditDb.exposeDb(),
    customTools: orchestrator.customTools,
    currentTaskId: () => orchestrator.runningTaskIds[0] ?? null,
  });
  setLongTaskRunner(longTaskRunner);

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
    missionRunRepo,
    missionRunner,
    longTaskRunner,
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

  wechatBot.on('message', (msg: WeChatInboundMessage) => {
    // 审批承接：出站通知让人「回复同意 xxx」，入站先按审批回复路由，未命中再走命令前缀建任务
    const approvalReply = parseApprovalReply(msg.content);
    if (approvalReply) {
      const route = routeApprovalReply(approvalReply, orchestrator.findPendingApprovals(approvalReply.idPrefix));
      if (route.kind === 'decide') {
        if (route.decision === 'approve') orchestrator.approve(route.id);
        else orchestrator.reject(route.id, '微信回复驳回');
      }
      const ctxToken = wechatBot.getContextToken(msg.fromWxid);
      if (ctxToken) void wechatBot.sendText(ctxToken, formatApprovalReplyResult(route));
      console.log(`[wechat-bot] 审批回复承接: ${route.kind} (编号 ${approvalReply.idPrefix})`);
      return;
    }
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
    // 老配置（load 对 wechatBot 不做深合并）可能没有该字段，回退空串 = 用最近联系人
    notifyContact: wechatCfg.notifyContact ?? '',
  });

  // 条目3.B：重启后自动恢复最近的未完成任务（e2e/selftest 下不恢复，避免污染基准）
  if (!isE2E && !isSelfTest) {
    const resume = autoResumeInterrupted({
      audit: auditDb,
      orchestrator,
      enabled: configStore.get().agent.autoResumeInterrupted !== false,
    });
    if (resume.resumed) {
      console.log(`[main] 已自动恢复上次未完成任务: ${resume.goal?.slice(0, 60)}`);
      publishStep(createStepEvent('thinking', `已自动恢复上次未完成任务: ${resume.goal?.slice(0, 40)}`));
    } else if (resume.error) {
      console.warn('[main] 自动恢复扫描失败:', resume.error);
    }
    // Mission 断点：running 态 Mission 重建调度循环；崩溃遗留子任务按审计终态收敛
    missionRunner.resumeRunningMissions();
  }

  if (isE2E) {
    scheduleE2ERun(orchestrator, auditDb);
  }
}
