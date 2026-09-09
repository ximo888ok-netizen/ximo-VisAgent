/**
 * wechat-bot.ts — 微信 Bot 通讯渠道（iLink 协议版）
 *
 * 基于腾讯微信官方 iLink Bot 协议（ilinkai.weixin.qq.com），扫码登录个人微信：
 * 1. POST ilink/bot/get_bot_qrcode → 获取二维码 → 渲染层展示 → 用户手机扫码
 * 2. GET  ilink/bot/get_qrcode_status → 长轮询扫码状态 → confirmed 时拿 bot_token
 * 3. POST ilink/bot/getupdates → 长轮询持续收消息（自动滚动游标）
 * 4. POST ilink/bot/sendmessage → 回复消息（需 context_token）
 *
 * 登录态持久化：
 * - bot_token / baseUrl / userId → wechat-bot-credentials.json（权限 0600）
 * - get_updates_buf → wechat-bot-sync.json
 * - start() 时自动恢复，stop() 保留凭证，logout() 清除凭证
 *
 * 安全边界：
 * - 只处理白名单联系人的消息
 * - 命令前缀过滤（防任意消息触发任务）
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { httpsPost, httpsGet, ILINK_DEFAULT_BASE } from './wechat-http';
import type {
  ScanStatus,
  WeChatInboundMessage,
  WeChatBotOptions,
  QrCodeResponse,
  StatusResponse,
  WeixinMessage,
  GetUpdatesResp,
  StoredCredentials,
} from './wechat-types';

/** 持久化凭证文件路径 */
const CREDENTIAL_FILE = 'wechat-bot-credentials.json';
/** 持久化游标文件路径 */
const SYNC_BUF_FILE = 'wechat-bot-sync.json';

/**
 * 微信 Bot 客户端：基于 iLink 协议扫码登录。
 *
 * 事件：
 * - 'qr' (qrData: string, status: ScanStatus) → 二维码 data URL + 状态
 * - 'login' (user: string) → 登录成功
 * - 'logout' () → 登出
 * - 'message' (msg: WeChatInboundMessage) → 收到消息
 * - 'status' (connected: boolean, error?: string) → 连接状态变化
 */
export class WeChatBot extends EventEmitter {
  private loggedIn = false;
  private started = false;
  private botToken: string | null = null;
  private baseUrl: string = ILINK_DEFAULT_BASE;
  private getUpdatesBuf = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private qrPollTimer: NodeJS.Timeout | null = null;
  private qrcode: string = '';
  private contextTokenCache = new Map<string, string>();

  constructor(private opts: WeChatBotOptions) {
    super();
  }

  /** 启动 Bot：有缓存 token 则自动恢复，否则获取二维码扫码 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 尝试从磁盘恢复登录态
    const stored = this.loadStoredCredentials();
    if (stored?.botToken) {
      this.botToken = stored.botToken;
      this.baseUrl = stored.baseUrl || ILINK_DEFAULT_BASE;
      this.getUpdatesBuf = this.loadSyncBuf();
      this.loggedIn = true;
      console.log('[wechat-bot] 已从磁盘恢复登录态，跳过扫码');
      this.emit('login', stored.userId || '微信用户');
      this.emit('status', true);
      this.startCallbackPolling();
      return;
    }

    // 无缓存凭证，走扫码流程
    try {
      await this.requestQrCode();
      console.log('[wechat-bot] iLink Bot 已启动，等待扫码...');
    } catch (err) {
      this.started = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[wechat-bot] 启动失败', msg);
      this.emit('status', false, msg);
      throw err;
    }
  }

  /** 请求二维码并启动扫码状态轮询 */
  private async requestQrCode(): Promise<void> {
    const body = JSON.stringify({ local_token_list: [] });
    const rawText = await httpsPost('ilink/bot/get_bot_qrcode?bot_type=3', body);
    const resp = JSON.parse(rawText) as QrCodeResponse;
    this.qrcode = resp.qrcode;
    const qrUrl = resp.qrcode_img_content;

    // 用 qrcode 库在主进程生成 data URL（避免 CSP 限制）
    let qrDataUrl = qrUrl;
    try {
      const QRCode = (await import('qrcode')).default;
      qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 240, margin: 1 });
    } catch {
      // 降级：直接传原始 URL
    }

    this.emit('qr', qrDataUrl, 'waiting' as ScanStatus);
    this.startQrCodePolling();
  }

  /** 长轮询扫码状态 */
  private startQrCodePolling(): void {
    this.stopQrCodePolling();

    const poll = async () => {
      if (!this.qrcode) return;
      try {
        const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.qrcode)}`;
        const rawText = await httpsGet(endpoint, 35000);
        const resp = JSON.parse(rawText) as StatusResponse;
        const status = this.mapQrStatus(resp.status);

        if (status === 'scanned') {
          this.emit('qr', '', 'scanned' as ScanStatus);
        }

        if (status === 'confirmed' && resp.bot_token) {
          this.botToken = resp.bot_token;
          if (resp.baseurl) this.baseUrl = resp.baseurl;
          this.stopQrCodePolling();
          this.loggedIn = true;
          const displayName = resp.ilink_user_id ?? '微信用户';
          this.saveStoredCredentials({
            botToken: this.botToken,
            baseUrl: this.baseUrl,
            userId: resp.ilink_user_id ?? '',
          });
          this.emit('login', displayName);
          this.emit('status', true);
          console.log('[wechat-bot] 登录成功，凭证已持久化');
          this.startCallbackPolling();
          return;
        }

        if (status === 'expired') {
          this.stopQrCodePolling();
          this.emit('qr', '', 'expired' as ScanStatus);
          this.started = false;
          console.log('[wechat-bot] 二维码已过期');
          return;
        }

        // IDC 重定向：切换轮询 host
        if (resp.status === 'scaned_but_redirect' && resp.redirect_host) {
          this.baseUrl = `https://${resp.redirect_host}`;
        }
      } catch (err) {
        console.error('[wechat-bot] 扫码状态轮询失败', err);
      }

      if (this.started && !this.loggedIn) {
        this.qrPollTimer = setTimeout(poll, 1000);
      }
    };
    poll();
  }

  private stopQrCodePolling(): void {
    if (this.qrPollTimer) {
      clearTimeout(this.qrPollTimer);
      this.qrPollTimer = null;
    }
  }

  /** 长轮询收消息（iLink 无 webhook，长轮询即回调） */
  private startCallbackPolling(): void {
    this.stopCallbackPolling();

    const poll = async () => {
      if (!this.botToken || !this.loggedIn) return;
      try {
        const body = JSON.stringify({
          get_updates_buf: this.getUpdatesBuf ?? '',
        });
        const rawText = await httpsPost('ilink/bot/getupdates', body, this.botToken, 35000);
        const resp = JSON.parse(rawText) as GetUpdatesResp;

        if (resp.ret && resp.ret !== 0) {
          console.error('[wechat-bot] getupdates 错误', resp.ret, resp.errmsg);
          if (resp.errcode === -14) {
            this.stopCallbackPolling();
            this.loggedIn = false;
            this.botToken = null;
            this.getUpdatesBuf = '';
            this.clearStoredCredentials();
            this.emit('logout');
            this.emit('status', false, 'token 过期，请重新登录');
            return;
          }
        }

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          this.saveSyncBuf(this.getUpdatesBuf);
        }

        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            this.handleMessage(msg);
          }
        }
      } catch (err) {
        console.error('[wechat-bot] 消息轮询失败', err);
      }

      if (this.loggedIn && this.botToken) {
        this.pollTimer = setTimeout(poll, 1000);
      }
    };
    poll();
  }

  private stopCallbackPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 停止 Bot（保留磁盘凭证，下次启动可自动恢复） */
  stop(): void {
    this.stopQrCodePolling();
    this.stopCallbackPolling();
    this.loggedIn = false;
    this.started = false;
    this.qrcode = '';
    this.baseUrl = ILINK_DEFAULT_BASE;
    this.emit('status', false);
  }

  /** 登出：清除磁盘凭证 + 内存状态（需重新扫码） */
  logout(): void {
    this.stopQrCodePolling();
    this.stopCallbackPolling();
    this.loggedIn = false;
    this.started = false;
    this.botToken = null;
    this.getUpdatesBuf = '';
    this.qrcode = '';
    this.baseUrl = ILINK_DEFAULT_BASE;
    this.clearStoredCredentials();
    this.emit('logout');
    this.emit('status', false);
  }

  get isConnected(): boolean {
    return this.loggedIn;
  }

  /** 更新运行时选项（allowedWxids / commandPrefix），dataDir 不可变 */
  updateOptions(opts: { allowedWxids?: string[]; commandPrefix?: string }): void {
    if (opts.allowedWxids !== undefined) this.opts.allowedWxids = opts.allowedWxids;
    if (opts.commandPrefix !== undefined) this.opts.commandPrefix = opts.commandPrefix;
  }

  /** 回复消息给指定联系人 */
  async sendText(to: string, content: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.loggedIn || !this.botToken) {
      return { ok: false, error: '微信未登录' };
    }
    try {
      const clientId = `ximo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body = JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: content } }],
        },
      });
      await httpsPost('ilink/bot/sendmessage', body, this.botToken, 15000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 判断消息是否为 Agent 命令（匹配前缀） */
  isCommand(content: string): boolean {
    const prefix = this.opts.commandPrefix.trim();
    if (!prefix) return false;
    return content.trim().toLowerCase().startsWith(prefix.toLowerCase());
  }

  /** 提取命令内容（去掉前缀后的文本） */
  extractCommand(content: string): string {
    const prefix = this.opts.commandPrefix.trim();
    return content.trim().slice(prefix.length).trim();
  }

  /** 获取联系人的 context_token（用于主动回复） */
  getContextToken(wxid: string): string | undefined {
    return this.contextTokenCache.get(wxid);
  }

  // ---- 私有辅助方法 ----

  private mapQrStatus(status: string): ScanStatus {
    switch (status) {
      case 'wait': return 'waiting';
      case 'scaned': return 'scanned';
      case 'confirmed': return 'confirmed';
      case 'expired': return 'expired';
      case 'scaned_but_redirect':
      case 'binded_redirect':
        return 'scanned';
      default: return 'error';
    }
  }

  private handleMessage(msg: WeixinMessage): void {
    let text = '';
    if (msg.item_list && msg.item_list.length > 0) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          text += item.text_item.text;
        }
      }
    }
    if (!text) return;

    const fromWxid = msg.from_user_id ?? '';
    if (this.opts.allowedWxids.length > 0 && !this.opts.allowedWxids.includes(fromWxid)) {
      return;
    }

    const inbound: WeChatInboundMessage = {
      msgId: String(msg.message_id ?? ''),
      fromWxid,
      fromNickname: fromWxid,
      type: 'text',
      content: text,
      isGroup: false,
      timestamp: msg.create_time_ms ?? Date.now(),
    };

    this.emit('message', inbound);

    if (msg.context_token) {
      this.contextTokenCache.set(fromWxid, msg.context_token);
    }
  }

  // ---- 磁盘持久化辅助方法 ----

  private get credFilePath(): string {
    return path.join(this.opts.dataDir, CREDENTIAL_FILE);
  }

  private get syncBufPath(): string {
    return path.join(this.opts.dataDir, SYNC_BUF_FILE);
  }

  private loadStoredCredentials(): StoredCredentials | null {
    try {
      if (!fs.existsSync(this.credFilePath)) return null;
      const raw = fs.readFileSync(this.credFilePath, 'utf-8');
      const data = JSON.parse(raw) as StoredCredentials;
      if (!data.botToken?.trim()) return null;
      return data;
    } catch {
      return null;
    }
  }

  private saveStoredCredentials(data: { botToken: string; baseUrl: string; userId: string }): void {
    try {
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
      const cred: StoredCredentials = {
        botToken: data.botToken,
        baseUrl: data.baseUrl,
        userId: data.userId,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.credFilePath, JSON.stringify(cred, null, 2), 'utf-8');
      try { fs.chmodSync(this.credFilePath, 0o600); } catch { /* best-effort */ }
    } catch (err) {
      console.error('[wechat-bot] 凭证持久化失败', err);
    }
  }

  private clearStoredCredentials(): void {
    for (const f of [this.credFilePath, this.syncBufPath]) {
      try { fs.unlinkSync(f); } catch { /* 文件不存在 */ }
    }
  }

  private loadSyncBuf(): string {
    try {
      if (!fs.existsSync(this.syncBufPath)) return '';
      const raw = fs.readFileSync(this.syncBufPath, 'utf-8');
      const data = JSON.parse(raw) as { get_updates_buf?: string };
      return typeof data.get_updates_buf === 'string' ? data.get_updates_buf : '';
    } catch {
      return '';
    }
  }

  private saveSyncBuf(buf: string): void {
    try {
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
      fs.writeFileSync(this.syncBufPath, JSON.stringify({ get_updates_buf: buf }), 'utf-8');
    } catch (err) {
      console.error('[wechat-bot] 游标持久化失败', err);
    }
  }
}
