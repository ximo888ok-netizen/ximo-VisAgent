/**
 * index.ts — 主进程入口（编排层）
 *
 * 职责：仅做依赖创建 + 启动序列调用。
 * IPC 注册逻辑 → ipc-registry.ts
 * 启动序列 → bootstrap.ts
 *
 * 子模块：
 * - bootstrap.ts     启动序列（splash → 工具恢复 → UIA → 岛 → Aura → 托盘 → 热键 → IPC → 微信 → E2E）
 * - ipc-registry.ts  全量 IPC handler 注册 + 依赖注入
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, globalShortcut } from 'electron';
import { getUiaClient } from '@ximo-visagent/control-kit';
import { ZODB } from './audit-store';
import { ExperienceStore } from './experience-store';
import { appConfigStore } from './config-store';
import { Orchestrator } from './orchestrator';
import { MemoryStore } from './memory-store';
import { ConversationStore } from './conversation-store';
import { Scheduler } from './scheduler';
import { getIslandWindow } from './windows/island';
import { applyMissionSchema } from './mission-db/migrations';
import { seedCapabilities } from './mission-db/seed-capabilities';
import { createMissionRepo } from './mission-db/mission-repo';
import { EmployeeStore } from './stores/employee-store';
import { WeChatBot } from './wechat-bot';
import { installProcessGuards } from './process-guards';
import { bootstrap } from './bootstrap';

installProcessGuards();

// BUG-18 修复：setName 必须在 getPath('userData') 之前
app.setName('ximo-VisAgent');

// 启动旗标
const isE2E = process.argv.includes('--e2e');
const isSelfTest = process.argv.includes('--selftest');
const isCoordCheck = process.argv.includes('--coordcheck');

// 自检隔离数据目录必须在任何 getPath('userData') 之前生效
const selfTestDir = isSelfTest ? fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-visagent-selftest-')) : null;
if (selfTestDir) app.setPath('userData', selfTestDir);

// ---- 依赖创建 ----
const uiaClient = getUiaClient();
const userData = () => app.getPath('userData');
const auditDb = new ZODB(path.join(userData(), 'audit.db'));
const experienceStore = new ExperienceStore(auditDb.exposeDb());
experienceStore.seedInitialPromptVersion();
applyMissionSchema(auditDb.exposeDb());
seedCapabilities(auditDb.exposeDb());
const missionRepo = createMissionRepo(auditDb.exposeDb());
const employeeStore = new EmployeeStore(auditDb.exposeDb());
const configStore = appConfigStore(path.join(userData(), 'config.json'));
const memoryStore = new MemoryStore(path.join(userData(), 'memory.json'));
const conversationStore = new ConversationStore();
const orchestrator = new Orchestrator(configStore, auditDb, {
  memory: memoryStore,
  conversation: conversationStore,
  experience: experienceStore,
  employee: employeeStore,
});

const wechatCfg = configStore.get().wechatBot ?? { enabled: false, allowedWxids: [], commandPrefix: 'AI:', notifyOnFinish: true, notifyOnApproval: false };
const wechatBot = new WeChatBot({
  allowedWxids: wechatCfg.allowedWxids,
  commandPrefix: wechatCfg.commandPrefix,
  dataDir: userData(),
});
orchestrator.setWeChatBot(wechatBot);

const scheduler = new Scheduler(path.join(userData(), 'scheduler.json'), {
  runJob: async (job) => {
    try {
      if (job.sopId) {
        await orchestrator.runSop(job.sopId, job.goal);
      } else {
        await orchestrator.startTask(job.goal);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '启动失败' };
    }
  },
});

// ---- 启动序列 ----
app.whenReady().then(async () => {
  // 坐标链路诊断模式
  if (isCoordCheck) {
    const { runCoordCheck } = await import('./coordcheck');
    try {
      const checks = await runCoordCheck();
      for (const c of checks) {
        console.log(JSON.stringify({ coordcheck: c.ok ? 'pass' : 'fail', name: c.name, detail: c.detail }));
      }
      const failed = checks.filter((c) => !c.ok).length;
      console.log(JSON.stringify({ coordcheck: 'done', total: checks.length, failed }));
      app.exit(failed > 0 ? 1 : 0);
    } catch (err) {
      console.error(JSON.stringify({ coordcheck: 'error', message: (err as Error).message }));
      app.exit(2);
    }
    return;
  }

  // 自检模式
  if (isSelfTest) {
    const { runSelfTest } = await import('./selftest');
    const checks = await runSelfTest();
    for (const c of checks) {
      console.log(JSON.stringify({ selftest: c.ok ? 'pass' : 'fail', name: c.name, detail: c.detail }));
    }
    const failed = checks.filter((c) => !c.ok).length;
    console.log(JSON.stringify({ selftest: 'done', total: checks.length, failed }));
    if (selfTestDir) {
      try {
        fs.rmSync(selfTestDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[selftest] 临时目录清理失败（不影响结果）', selfTestDir, err instanceof Error ? err.message : err);
      }
    }
    app.exit(failed > 0 ? 1 : 0);
    return;
  }

  // 正常启动
  await bootstrap({
    orchestrator, auditDb, experienceStore, configStore,
    memoryStore, conversationStore, scheduler, employeeStore, missionRepo,
    wechatBot, wechatCfg, uiaClient, isE2E, isSelfTest,
  });
});

// ---- 生命周期 ----
app.on('window-all-closed', () => {
  const island = getIslandWindow();
  if (island && !island.isDestroyed()) return;
  try { scheduler.stop(); } catch { /* noop */ }
  try { uiaClient.stop(); } catch { /* noop */ }
  try { wechatBot.stop(); } catch { /* noop */ }
  try { auditDb.close(); } catch { /* noop */ }
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('before-quit', () => {
  try { scheduler.stop(); } catch { /* noop */ }
  try { wechatBot.stop(); } catch { /* noop */ }
});
