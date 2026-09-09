/**
 * orchestrator-notify.ts — 任务与审批的用户可达通道（从 orchestrator.ts 拆出）
 *
 * 三种可达方式各有分工：灵动岛事件流（在线）、系统通知（岛被隐藏/全屏时兜底）、
 * stdout JSONL（E2E 自动化）。任何一种失败都不能影响任务本身。
 * 微信 Bot 通道（outbound）：任务终态/审批请求推送到微信，第四种可达方式。
 */
import { Notification } from 'electron';
import { ISLAND_CHANNELS } from '../shared/island-channels';
import { getIslandWindow, showIsland, publishStep } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';
import { pushApprovalRequest } from './island-bridge';
import type { WeChatBot } from './wechat-bot';
import { formatTaskNotification, formatApprovalNotification } from './wechat-notify';

/** 微信 Bot 通知器（可选，启动后注入） */
let wechatNotifier: { bot: WeChatBot; notifyOnFinish: boolean; notifyOnApproval: boolean; defaultContact: string } | null = null;

/** 注入微信 Bot 通知器（index.ts 启动后调用） */
export function setWeChatNotifier(bot: WeChatBot | null, opts: { notifyOnFinish: boolean; notifyOnApproval: boolean; defaultContact?: string }): void {
  if (!bot || (!opts.notifyOnFinish && !opts.notifyOnApproval)) {
    wechatNotifier = null;
    return;
  }
  wechatNotifier = { bot, notifyOnFinish: opts.notifyOnFinish, notifyOnApproval: opts.notifyOnApproval, defaultContact: opts.defaultContact ?? '' };
}

export interface ApprovalOperation {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  level?: number;
}

/** 推送任务终态到岛 + stdout（E2E 归集用） */
export function pushTaskFinished(
  taskId: string,
  status: string,
  finalAnswer: string,
  steps: number,
  totalTokens: number,
): void {
  const win = getIslandWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send(ISLAND_CHANNELS.taskFinished, { taskId, status, finalAnswer, steps, totalTokens });
  }
  // 微信 Bot outbound：任务终态推送
  if (wechatNotifier && wechatNotifier.notifyOnFinish && wechatNotifier.bot.isConnected) {
    const goal = win?.webContents.getTitle() ?? taskId.slice(0, 8); // 退化用 taskId
    // iLink 协议：Bot 只能回复用户先发来的消息，使用最近联系人 context_token
    const ctxToken = wechatNotifier.bot.getContextToken(wechatNotifier.defaultContact) ?? wechatNotifier.defaultContact;
    if (ctxToken) {
      void wechatNotifier.bot.sendText(
        ctxToken,
        formatTaskNotification(goal, status, finalAnswer),
      ).catch(() => {});
    }
  }
}

/** 排队任务真正开始执行时通知 UI（排队态 → 运行态） */
export function notifyTaskStarted(taskId: string, goal: string): void {
  const win = getIslandWindow();
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.send(ISLAND_CHANNELS.taskStarted, { taskId, goal, ts: Date.now() });
  win.webContents.send(ISLAND_CHANNELS.step, {
    status: 'thinking',
    text: `任务开始: ${goal.slice(0, 80)}`,
    taskId,
    ts: Date.now(),
  });
}

export function notifyTaskFinished(goal: string, status: string): void {
  const ok = status === 'COMPLETED';
  notify(ok ? '任务已完成' : `任务${status === 'FAILED' ? '失败' : '结束'}`, goal.slice(0, 80));
}

/**
 * 审批请求：默认走灵动岛审批卡并挂起等待人工决定（返回 null 让 AgentLoop 轮询）。
 * 没有任何 UI 窗口时保守拒绝 —— 宁可任务停住也不代人操作桌面。
 */
export async function requestApprovalUI(
  approvalId: string,
  op: ApprovalOperation,
  approvalTimeoutMs: number,
): Promise<{ action: 'reject'; reason: string } | null> {
  const island = getIslandWindow();
  if (!island || island.isDestroyed()) {
    return { action: 'reject', reason: '无 UI 窗口，自动拒绝' };
  }
  try {
    await pushApprovalRequest(approvalId, { ...op, approvalTimeoutMs });
  } catch (err) {
    console.error('[island] push approval failed', err);
  }
  // A14：岛隐藏时用系统通知唤回
  if (!island.isVisible()) {
    notify('ximo-VisAgent 需要审批', `Agent 请求执行「${op.tool}」，点击此处打开灵动岛处理`);
  }
  // 微信 Bot outbound：审批请求推送
  if (wechatNotifier && wechatNotifier.notifyOnApproval && wechatNotifier.bot.isConnected) {
    // iLink 协议：Bot 只能回复用户先发来的消息，使用最近联系人 context_token
    const ctxToken = wechatNotifier.bot.getContextToken(wechatNotifier.defaultContact) ?? wechatNotifier.defaultContact;
    if (ctxToken) {
      void wechatNotifier.bot.sendText(
        ctxToken,
        formatApprovalNotification(op.tool, op.reason, approvalId),
      ).catch(() => {});
    }
  }
  return null;
}

/** 系统通知（点击唤回灵动岛）；不支持时静默降级 */
function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => showIsland());
    n.show();
  } catch {
    /* 通知失败不影响任务 */
  }
}

/** 主进程内部日志（供无 UI 场景留痕） */
export function logInfo(text: string): void {
  publishStep(createStepEvent('thinking', text));
}
