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
