/**
 * aura-contracts.ts — Agent 在场指示（极光边框）的共享契约
 *
 * 边框唯一职责是把「Agent 正在操作你的电脑」这件事放到用户必然看得到的地方：
 * 全屏边缘。它不接收点击（click-through），也不承载任何权限操作。
 *
 * 状态优先级（高到低）：halted > awaiting-approval > running > capturing > idle。
 * 降级（degraded）表示本机没能把边框盖在当前前台窗口之上（例如独占全屏），
 * 此时主进程会改用托盘/通知提示，不能假装"用户在看着"。
 */
import { z } from 'zod';

export const AURA_STATES = ['idle', 'capturing', 'running', 'awaiting-approval', 'halted'] as const;
export const AuraStateSchema = z.enum(AURA_STATES);
export type AuraState = z.infer<typeof AuraStateSchema>;

/** 一帧边框所需的全部信息（无边框窗口只做渲染，不做决策） */
export const AuraFrameSchema = z.object({
  state: AuraStateSchema,
  /** 给人看的一句话，如「正在打开记事本」；不超过 40 字 */
  hint: z.string().max(40).default(''),
  /** 灵动岛在屏幕左半还是右半：待审批时边框向其收拢，把视线引过去 */
  islandOnLeft: z.boolean().default(true),
  // 注：是否做呼吸动画由边框窗口自己读系统的 prefers-reduced-motion，
  // 主进程不重复决定同一件事（单一事实来源）
  /** 边框无法覆盖当前前台（独占全屏等），已降级为托盘/通知提示 */
  degraded: z.boolean().default(false),
  /** 审批档位：运行中边框据此换色（auto=青 / autonomous=橙红）；非法值由 aura-state fail-closed 回 manual */
  mode: z.enum(["manual", "auto", "autonomous"]).default("manual"),
});
export type AuraFrame = z.infer<typeof AuraFrameSchema>;

/** 设置项：边框强度。off 时完全不创建窗口（省电/录屏/多屏投影场景） */
export const AuraIntensitySchema = z.enum(['off', 'subtle', 'full']).default('full');
export type AuraIntensity = z.infer<typeof AuraIntensitySchema>;
