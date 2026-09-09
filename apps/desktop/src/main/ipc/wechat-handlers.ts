/**
 * wechat-handlers.ts — 微信 Bot IPC 通道注册（扫码登录版）
 *
 * 职责：注册 wechat:* IPC 通道，桥接渲染层与 WeChatBot 实例。
 * 配置更新落库；扫码登录（启动 → 生成 QR → 推送 → 登录）；
 * QR 码/扫码状态/登录/登出/消息/连接状态推送到渲染层。
 */
import { ipcMain, type BrowserWindow } from "electron";
import { ISLAND_CHANNELS } from "../../shared/island-channels";
import type { UpdateWeChatConfigRequest, WeChatLoginResult } from "../../shared/schemas/wechat";
import type { WeChatBot } from "../wechat-bot";
import type { Store } from "../config-store";
import { defaultWeChatConfig } from "../config-sync";

export interface WeChatHandlerDeps {
  getIslandWindow: () => BrowserWindow | null;
  wechatBot: WeChatBot;
  store: Store;
}

export function registerWeChatHandlers(deps: WeChatHandlerDeps): void {
  const { getIslandWindow, wechatBot, store } = deps;

  // 更新配置 → 落库 + 重启 Bot（如已运行）
  ipcMain.handle(ISLAND_CHANNELS.wechatUpdateConfig, async (_evt, req: UpdateWeChatConfigRequest) => {
    const cur = store.get();
    const curWc = cur.wechatBot ?? defaultWeChatConfig();
    const merged = { ...curWc, ...req };
    store.set({ wechatBot: merged });
    return { ok: true };
  });

  // 发起扫码登录：启动 Bot → 获取 iLink 二维码
  ipcMain.handle(ISLAND_CHANNELS.wechatLogin, async (): Promise<{ ok: true; data: WeChatLoginResult } | { ok: false; error: string }> => {
    const cfg = store.get().wechatBot ?? defaultWeChatConfig();
    try {
      // 登出清除旧凭证，再以新配置启动走扫码流程
      wechatBot.logout();
      // 更新 Bot 选项（opts 是 protected 字段，通过 updateOptions 方法访问）
      wechatBot.updateOptions({
        allowedWxids: cfg.allowedWxids ?? [],
        commandPrefix: cfg.commandPrefix ?? 'AI:',
      });
      await wechatBot.start();
      return { ok: true, data: { ok: true, scanStatus: 'waiting' } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 登出：清除磁盘凭证（需重新扫码）
  ipcMain.handle(ISLAND_CHANNELS.wechatLogout, async () => {
    wechatBot.logout();
    return { ok: true };
  });

  // ---- Bot 事件 → 推送到渲染层 ----

  // QR 码
  wechatBot.on('qr', (qrCode: string, status: string) => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.wechatQr, { qrCode });
      win.webContents.send(ISLAND_CHANNELS.wechatScanStatus, { status });
    }
  });

  // 登录成功
  wechatBot.on('login', (user: string) => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.wechatLoginSuccess, { user });
    }
  });

  // 登出
  wechatBot.on('logout', () => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.wechatLogoutEvent, {});
    }
  });

  // 连接状态
  wechatBot.on('status', (connected: boolean, error?: string) => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.wechatStatus, { connected, error });
    }
  });

  // 收到消息
  wechatBot.on('message', (msg) => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.wechatMessage, msg);
    }
  });
}
