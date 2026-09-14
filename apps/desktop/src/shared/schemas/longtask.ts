/**
 * longtask.ts — 锚定长任务域 schema（A 期地基）
 *
 * 一域一文件（engineering.md C6）。A-M1 先落地应用目录契约（AppEntry / apps:* 出入参）
 * 与 targetApp/longTask 正源（规划 §2.1，A-M2 的 task.ts 扩展从这里取型）。
 */
import { z } from "zod";

/* ---------------------------------------------------------------------------
 * 应用目录（apps:list / apps:icons / apps:recent）
 * ------------------------------------------------------------------------- */

/** 枚举来源：registry Uninstall 键 / 开始菜单 .lnk / 最近使用表回填 */
export const AppSourceSchema = z.enum(["registry", "startmenu", "recent"]);

/** 选择器行模型（侧车 listApps 行经主进程规整后的对渲染层契约） */
export const AppEntrySchema = z.object({
  /** 稳定标识 = sha1(normalize(exePath))，跨重启可对账 */
  id: z.string().min(1),
  name: z.string().min(1),
  /** 绝对路径（.lnk 解析失败时为 .lnk 本体，直喂 openAppSafe 现成分支） */
  exePath: z.string().min(1),
  /** icon-cache 文件名（{sha1}_{mtime}_{size}.png）；空=字母图标回退 */
  iconRef: z.string().default(""),
  source: AppSourceSchema,
});
export type AppEntry = z.infer<typeof AppEntrySchema>;

/** apps:list 入参：refresh=true 手动失效内存缓存（规划 §2.5） */
export const AppsListSchema = z.object({
  refresh: z.boolean().optional(),
});
export type AppsListRequest = z.infer<typeof AppsListSchema>;

/** apps:icons 入参：批量 ≤25（超限边界直接拒绝，preload 与主进程双侧复校） */
export const AppsIconsSchema = z.object({
  exePaths: z.array(z.string().min(1).max(1024)).max(25),
  size: z.number().int().min(16).max(256).default(32),
});
export type AppsIconsRequest = z.infer<typeof AppsIconsSchema>;

/** 单个图标出参：pngBase64 缺省=提取失败（渲染层字母图标兜底，永不出错） */
export const AppIconPayloadSchema = z.object({
  exePath: z.string(),
  pngBase64: z.string().optional(),
  error: z.string().optional(),
});
export type AppIconPayload = z.infer<typeof AppIconPayloadSchema>;

/* ---------------------------------------------------------------------------
 * targetApp 绑定与长任务档位（规划 §2.1，A-M2 接线）
 * ------------------------------------------------------------------------- */

export const TargetAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  exePath: z.string().min(1),
  iconRef: z.string().default(""),
  /** 进程族 basename 小写（看门狗匹配用），缺省由 exePath basename 推出 */
  procFamily: z.array(z.string().min(1)).default([]),
});
export type TargetApp = z.infer<typeof TargetAppSchema>;

export const LongTaskOptionsSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  watchdogIdleMs: z.number().int().min(60_000).max(600_000).optional(),
});
export type LongTaskOptions = z.infer<typeof LongTaskOptionsSchema>;

/* ---------------------------------------------------------------------------
 * 断点检查点与工件对账（规划 §2.3，A-M4）
 * ------------------------------------------------------------------------- */

/** 工件角色：产出物（恢复时逐个核对）/ 输入引用（缺失即需重读） */
export const CheckpointRoleSchema = z.enum(["output", "input-ref"]);
export type CheckpointRole = z.infer<typeof CheckpointRoleSchema>;

/** 工件指纹：contentHash=sha256 hex；''=登记时不可读（对账按需重做处理） */
export const CheckpointArtifactSchema = z.object({
  path: z.string().min(1).max(1024),
  contentHash: z.string().max(128),
  role: CheckpointRoleSchema,
});
export type CheckpointArtifact = z.infer<typeof CheckpointArtifactSchema>;

/** 业务进度游标："已录入 17/30 张发票" → { done:17, total:30, unit:"张发票" } */
export const CheckpointCursorSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().positive().optional(),
  unit: z.string().min(1).max(40).default("项"),
  lastItem: z.string().max(200).optional(),
});
export type CheckpointCursor = z.infer<typeof CheckpointCursorSchema>;

/** host=宿主写副作用工具成功后自动登记；model=模型经 checkpoint 工具显式补语义 */
export const CheckpointKindSchema = z.enum(["host", "model"]);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

/** task_checkpoints 行的写入契约（仓储层入参，zod 复校后落库） */
export const CheckpointDraftSchema = z.object({
  taskId: z.string().min(1),
  kind: CheckpointKindSchema,
  cursor: CheckpointCursorSchema,
  artifacts: z.array(CheckpointArtifactSchema).max(200),
  summary: z.string().max(500).default(""),
});
export type CheckpointDraft = z.infer<typeof CheckpointDraftSchema>;

/** checkpoint 模型工具的入参契约（宿主自动登记之外，模型补业务进度语义） */
export const CheckpointToolArgsSchema = z.object({
  summary: z.string().min(1).max(500),
  done: z.number().int().min(0).optional(),
  total: z.number().int().positive().optional(),
  unit: z.string().min(1).max(40).optional(),
  lastItem: z.string().max(200).optional(),
  /** 关联工件绝对路径（与宿主自动登记同一指纹即去重合流） */
  artifacts: z.array(z.string().min(1).max(1024)).max(50).optional(),
});
export type CheckpointToolArgs = z.infer<typeof CheckpointToolArgsSchema>;

/** 恢复对账预览（listInterrupted 附带 → InterruptedBanner 锚定分支消费） */
export const CheckpointPreviewSchema = z.object({
  /** 读自工件核对后的进度（stale 重做项已扣除） */
  done: z.number().int().min(0),
  total: z.number().int().positive().optional(),
  unit: z.string(),
  summary: z.string(),
  redoCount: z.number().int().min(0),
  redoItems: z.array(z.object({
    path: z.string(),
    reason: z.enum(["changed", "missing"]),
  })).max(50),
});
export type CheckpointPreview = z.infer<typeof CheckpointPreviewSchema>;

/* ---------------------------------------------------------------------------
 * 预授权作用域包 grant（规划 §2.2，A-M6）
 * ------------------------------------------------------------------------- */

/** 可预授权的 L2 操作类别（授权卡逐项勾选的用语；L3 永不可预授权） */
export const GrantOpClassSchema = z.enum([
  "type_text",
  "click",
  "hotkey",
  "scroll",
  "read_only",
  "file_write",
  "export",
]);
export type GrantOpClass = z.infer<typeof GrantOpClassSchema>;

/** 预算三输入（与 LongTaskOptions 同源子集，授权卡上可见可改） */
export const GrantBudgetSchema = z.object({
  maxDurationMs: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});
export type GrantBudget = z.infer<typeof GrantBudgetSchema>;

/** ScopePackage：授权卡与决策函数共用的 JSON 契约（规划 §2.2 逐字） */
export const ScopePackageSchema = z.object({
  /** 绑 TargetAppSchema.id（grant 只在锚定该应用的任务内生效） */
  appId: z.string().min(1),
  /** 读写目录白名单，glob 前缀匹配（"C:/发票/**"） */
  dirs: z.array(z.string().min(1).max(1024)).max(50).default([]),
  opClasses: z.array(GrantOpClassSchema).max(10).default([]),
  /** 敏感对象排除：按钮文本/路径关键词；命中强制 ask，不可被作用域覆盖 */
  sensitiveExcludes: z.array(z.string().min(1).max(64)).max(50).default([]),
  budget: GrantBudgetSchema,
  note: z.string().max(200).optional(),
});
export type ScopePackage = z.infer<typeof ScopePackageSchema>;

/** grant:create 入参：授权卡打开即建（status active, acked 0，未 ack 永不生效） */
export const GrantCreateSchema = z.object({
  scope: ScopePackageSchema,
  /** A 期绑定任务（起跑前可先建后绑，task:start 携带 grantId 时补写） */
  taskId: z.string().min(1).optional(),
  /** 有效期天数，缺省 30（用户确认参数 Q8） */
  ttlDays: z.number().int().min(1).max(365).optional(),
});
export type GrantCreateRequest = z.infer<typeof GrantCreateSchema>;

/**
 * grant:ack 入参：ack 是放行前提。携带 scope 时一并覆盖草稿
 * （授权卡打开即建的是草稿，用户编辑后在 ack 这一刻定格——
 * 未 ack 的 grant 三条件缺一道永不生效，覆盖草稿无安全风险）。
 */
export const GrantAckSchema = z.object({
  grantId: z.string().regex(/^g_[0-9a-f]{12}$/, "grantId 形态非法"),
  scope: ScopePackageSchema.optional(),
});
export type GrantAckRequest = z.infer<typeof GrantAckSchema>;

/** grant:revoke 入参（B 期面板 / 授权卡取消回收草稿） */
export const GrantIdSchema = z.object({
  grantId: z.string().regex(/^g_[0-9a-f]{12}$/, "grantId 形态非法"),
});
export type GrantIdRequest = z.infer<typeof GrantIdSchema>;
