/**
 * 微信 Bot 通讯域 schema（iLink 协议扫码登录版）
 */
import { z } from "zod";

export const WeChatBotConfigSchema = z.object({
  enabled: z.boolean(),
  allowedWxids: z.array(z.string()),
  commandPrefix: z.string(),
  notifyOnFinish: z.boolean(),
  notifyOnApproval: z.boolean(),
});
export type WeChatBotConfigPayload = z.infer<typeof WeChatBotConfigSchema>;

/** 更新微信 Bot 配置请求 */
export const UpdateWeChatConfigSchema = WeChatBotConfigSchema.partial();
export type UpdateWeChatConfigRequest = z.infer<typeof UpdateWeChatConfigSchema>;

/** 扫码登录结果 */
export const WeChatLoginResultSchema = z.object({
  ok: z.boolean(),
  /** QR 码内容，前端可用 qrcode 库渲染为图片 */
  qrCode: z.string().optional(),
  /** 扫码状态 */
  scanStatus: z.enum(["waiting", "scanned", "confirmed", "expired", "error"]).optional(),
  error: z.string().optional(),
});
export type WeChatLoginResult = z.infer<typeof WeChatLoginResultSchema>;
