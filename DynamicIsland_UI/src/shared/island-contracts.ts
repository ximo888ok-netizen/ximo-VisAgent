/**
 * island-contracts.ts
 * ============================================================================
 * 「灵动岛 DynamicIsland」前后端唯一数据契约。
 *
 * 角色划分：
 * - 本仓库（渲染进程 + preload + 主进程壳）只负责"表现与安全信号"。
 * - Agent Core / Safety / 审批中心 = 由后端 Agent 编程助手实现，它只需
 *   严格按本文件定义的 channel 与 payload 收发数据，即可驱动本 UI。
 *
 * 对接方式（给后端 Agent 看的接口面）：
 *   1. 主进程向渲染进程推送：
 *        - webContents.send("agent:step",           AgentStepEvent)
 *        - webContents.send("approval:pending",     ApprovalRequest)
 *   2. 渲染进程向主进程发送：
 *        - ipcRenderer.invoke("island:expand")
 *        - ipcRenderer.invoke("agent:emergency-stop", { reason })
 *        - ipcRenderer.send("approval:result",        ApprovalResult)
 *        - ipcRenderer.send("island:set-mouse-passthrough", boolean)
 *   （所有 outbound 在主进程用下方 zod schema 校验）
 * ============================================================================
 */
import { z } from "zod";

/** 双向通信 channel 全集：后端 Agent 与主进程均以此为准。 */
export const ISLAND_CHANNELS = {
  /** renderer -> main (invoke)：唤出 / 聚焦全功能主窗口 */
  expand: "island:expand",
  /** renderer -> main (invoke)：紧急停止（真正中断由主进程 Safety 执行） */
  emergencyStop: "agent:emergency-stop",
  /** renderer -> main (send)：切换鼠标穿透（渲染层算出命中区后回报主进程） */
  setPassthrough: "island:set-mouse-passthrough",
  /** main -> renderer (send)：Agent 单步日志 */
  step: "agent:step",
  /** main -> renderer (send)：触发审批展开 */
  approvalPending: "approval:pending",
  /** renderer -> main (send)：用户审批结论 */
  approvalResult: "approval:result",
  /** renderer -> main (invoke)：读取当前系统深浅主题 */
  getTheme: "island:get-theme",
  /** main -> renderer (send)：nativeTheme 更新（切换 Tailwind dark 类） */
  themeChanged: "island:theme-changed",
  /** renderer -> main (send)：上报自适应后的窗口内容尺寸（400–900 × 64|280） */
  resize: "island:resize",
  /** renderer -> main (send)：审批参数编辑需要键盘输入时置可聚焦 */
  keyboardInput: "island:keyboard-input",
} as const;

/* ---------------------------------------------------------------------------
 * Agent 运行状态
 * ------------------------------------------------------------------------- */
export const AGENT_STATUS = [
  "idle",
  "thinking",
  "waiting_approval",
  "error",
  "stopped",
] as const;

export type AgentStatus = (typeof AGENT_STATUS)[number];

export const AgentStatusSchema = z.enum(AGENT_STATUS);

/** 主进程 -> 渲染进程：单条 ReAct 步骤 */
export const AgentStepEventSchema = z.object({
  /** 事件产生时间（毫秒时间戳） */
  ts: z.number().int().nonnegative().default(() => Date.now()),
  status: AgentStatusSchema,
  /** 单行日志文案（跑马灯展示），勿含换行 */
  text: z.string().min(1).max(2000),
});

export type AgentStepEvent = z.infer<typeof AgentStepEventSchema>;

/* ---------------------------------------------------------------------------
 * 审批
 * ------------------------------------------------------------------------- */

export const ApprovalDecisionSchema = z.enum([
  "approved", // 批准
  "rejected", // 拒绝
  "revised",  // 修改参数后批准
]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** 审批关键信息行：label/value 一对 */
export const ApprovalDetailRowSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(240),
});
export type ApprovalDetailRow = z.infer<typeof ApprovalDetailRowSchema>;

/** 允许后端 Agent 注入的可修改参数表（渲染层以字符串编辑） */
export const ApprovalParamsSchema = z.record(z.string(), z.string());
export type ApprovalParams = z.infer<typeof ApprovalParamsSchema>;

/**
 * 主进程 -> 渲染进程：审批请求（触发 64px -> 280px 展开）
 */
export const ApprovalRequestSchema = z.object({
  /** 全局唯一审批 key：渲染层原样带回，用于后端匹配上下文 */
  approvalKey: z.string().min(1).max(128),
  title: z.string().min(1).max(120),
  tool: z.string().min(1).max(120),
  /** 执行前截图：dataURL；图片长边后端必须压缩至 <=600px */
  screenshot: z.string().startsWith("data:image").max(900_000),
  /** 关键信息行（UI 右侧明细，如：目标 / 影响 / 金额） */
  detail: z.array(ApprovalDetailRowSchema).max(8).default([]),
  /** 可修改参数（>¥1,000 审批阈值等场景由后端决定展示与否） */
  params: ApprovalParamsSchema.default({}),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** 渲染进程 -> 主进程：用户审批结论 */
export const ApprovalResultSchema = z.object({
  approvalKey: z.string().min(1).max(128),
  decision: ApprovalDecisionSchema,
  /** revised 时必填：用户修改后的参数 */
  params: ApprovalParamsSchema.optional(),
  note: z.string().max(500).optional(),
});

export type ApprovalResult = z.infer<typeof ApprovalResultSchema>;

/* ---------------------------------------------------------------------------
 * 渲染 -> 主进程请求
 * ------------------------------------------------------------------------- */

/** 紧急停止请求（渲染层只发信号；是否允许 / 如何中断由主进程 Safety 决定） */
export const EmergencyStopRequestSchema = z.object({
  reason: z.string().max(200).optional(),
});

export type EmergencyStopRequest = z.infer<typeof EmergencyStopRequestSchema>;

/* ---------------------------------------------------------------------------
 * 构造器：给后端 Agent 编程助手直接调用，避免手拼 payload 出错
 * ------------------------------------------------------------------------- */

export function createStepEvent(
  status: AgentStatus,
  text: string,
): AgentStepEvent {
  return AgentStepEventSchema.parse({ status, text });
}

export function createApprovalRequest(
  input: Omit<ApprovalRequest, "detail" | "params"> & {
    detail?: ApprovalDetailRow[];
    params?: ApprovalParams;
  },
): ApprovalRequest {
  return ApprovalRequestSchema.parse(input);
}
