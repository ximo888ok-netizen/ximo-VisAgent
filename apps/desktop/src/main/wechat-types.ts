/**
 * wechat-types.ts — 微信 Bot 共享类型定义
 */

/** 扫码状态 */
export type ScanStatus =
  | 'waiting'    // 等待扫码
  | 'scanned'    // 已扫码，等待确认
  | 'confirmed'  // 已确认登录
  | 'expired'    // 二维码过期
  | 'error';     // 错误

/** 入站微信消息 */
export interface WeChatInboundMessage {
  msgId: string;
  fromWxid: string;
  fromNickname: string;
  type: string;
  content: string;
  isGroup: boolean;
  groupId?: string;
  timestamp: number;
}

export interface WeChatBotOptions {
  allowedWxids: string[];
  commandPrefix: string;
  /** 应用 userData 目录，用于存储登录凭证 */
  dataDir: string;
}

/** QR 码响应 */
export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** 扫码状态响应 */
export interface StatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** iLink 消息项 */
export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
}

/** iLink 消息体 */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

/** getupdates 响应 */
export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/** 持久化凭证结构 */
export interface StoredCredentials {
  botToken: string;
  baseUrl: string;
  userId: string;
  savedAt: string;
}
