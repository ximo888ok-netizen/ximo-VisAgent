/**
 * 员工域 schema（M1 数据底座）：岗位 / 事实卡 / 入职报告
 *
 * 表结构：
 * - positions          岗位定义（身份/职责/边界/目标/资料清单/例行）
 * - fact_cards         事实卡（入职研读产物，带 sourceRef）
 * - onboarding_reports 入职报告（分主题事实卡集合 + 疑问清单）
 *
 * 写入口铁律：L4 表只有两个合法写入口——
 *   ① 入职报告确认（position_status: onboarding → active）
 *   ② 宪法门提案批准（meta_proposals → meta-appliers）
 * 其余路径写入视为越权（S5 同款处理）。
 */
import { z } from "zod";

// ---------- 岗位状态 ----------

export const PositionStatusSchema = z.enum([
  "draft",
  "onboarding",
  "active",
  "suspended",
  "offboarded",
]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

// ---------- 资料清单条目 ----------

export const KnowledgeSourceSchema = z.object({
  /** 资料路径：目录/文件/URL/代码库路径 */
  path: z.string().min(1).max(500),
  /** 优先级：1=必读、2=重要、3=可选 */
  priority: z.number().int().min(1).max(3).default(2),
  /** 资料类型标签 */
  kind: z.enum(["doc", "code", "url", "dir"]).default("doc"),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

// ---------- 岗位定义行 ----------

export const PositionRowSchema = z.object({
  id: z.string(),
  /** 岗位名称 */
  name: z.string().min(1).max(80),
  /** 角色画像描述 */
  roleProfile: z.string().max(500).default(""),
  /** 汇报对象 */
  reportTo: z.string().max(80).default(""),
  /** 语气/口头禅（可空） */
  tone: z.string().max(200).default(""),
  /** 职责范围（做什么） */
  dutyScopeJson: z.string().default("[]"),
  /** 职责边界（不做什么，硬边界） */
  dutyBoundaryJson: z.string().default("[]"),
  /** 工作目标 */
  goalsJson: z.string().default("[]"),
  /** 资料清单（KnowledgeSource[] 序列化） */
  knowledgeJson: z.string().default("[]"),
  /** 例行职责（cron 表达式 + 任务描述） */
  routineJson: z.string().default("[]"),
  /** 岗位状态 */
  status: PositionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PositionRowPayload = z.infer<typeof PositionRowSchema>;

// ---------- 事实卡 ----------

export const FactCardStatusSchema = z.enum([
  "active",
  "stale",
  "contradicted",
  "archived",
]);
export type FactCardStatus = z.infer<typeof FactCardStatusSchema>;

export const FactCardRowSchema = z.object({
  id: z.string(),
  positionId: z.string(),
  /** 主题标签 */
  topic: z.string().min(1).max(120),
  /** 事实陈述 */
  claim: z.string().min(1).max(1000),
  /** 来源引用（文件路径 + 行区间 / URL） */
  sourceRef: z.string().min(1).max(500),
  /** 置信度 0-1 */
  confidence: z.number().min(0).max(1).default(0.6),
  /** 来源文件内容 hash（用于失效检测） */
  sourceHash: z.string().max(64).nullable(),
  /** 状态 */
  status: FactCardStatusSchema,
  /** 是否经用户确认（入职报告确认后为 true） */
  confirmed: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type FactCardRowPayload = z.infer<typeof FactCardRowSchema>;

// ---------- 入职报告 ----------

export const OnboardingReportRowSchema = z.object({
  id: z.string(),
  positionId: z.string(),
  /** 报告内容（分主题的事实卡 ID 集合 + 摘要，JSON 序列化） */
  reportJson: z.string().default("{}"),
  /** 疑问清单（低置信度/冲突条目） */
  questionsJson: z.string().default("[]"),
  /** 断点续读游标（JSON: { source: cursor }） */
  lastCursorJson: z.string().default("{}"),
  /** 覆盖率（已研读条目数 / 资料清单总数） */
  coverage: z.number().min(0).max(1).default(0),
  /** 状态 */
  status: z.enum(["in_progress", "ready", "confirmed", "rejected"]).default("in_progress"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OnboardingReportRowPayload = z.infer<typeof OnboardingReportRowSchema>;

// ---------- IPC 请求/响应 schema ----------

export const CreatePositionSchema = z.object({
  name: z.string().min(1).max(80),
  roleProfile: z.string().max(500).optional(),
  reportTo: z.string().max(80).optional(),
  tone: z.string().max(200).optional(),
  dutyScope: z.array(z.string().max(300)).max(20).default([]),
  dutyBoundary: z.array(z.string().max(300)).max(20).default([]),
  goals: z.array(z.string().max(300)).max(20).default([]),
  knowledge: z.array(KnowledgeSourceSchema).max(50).default([]),
  routine: z.array(z.string().max(300)).max(20).default([]),
});
export type CreatePositionRequest = z.infer<typeof CreatePositionSchema>;

export const UpdatePositionSchema = CreatePositionSchema.partial();
export type UpdatePositionRequest = z.infer<typeof UpdatePositionSchema>;

export const SearchFactCardsSchema = z.object({
  query: z.string().max(200).optional(),
  positionId: z.string().optional(),
  topic: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(100).default(20).optional(),
});
export type SearchFactCardsRequest = z.infer<typeof SearchFactCardsSchema>;

export type SearchFactCardsResult = { items: FactCardRowPayload[] };
