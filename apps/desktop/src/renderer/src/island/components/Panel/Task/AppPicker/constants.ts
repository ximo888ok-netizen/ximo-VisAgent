/**
 * constants.ts — AppPicker 常量（分组标签、虚拟滚动参数、拼音边界、锚定档位）
 *
 * 规划 §4.1：AppList 虚拟滚动行高/分组顺序 + useAppSearch 拼音首字母边界表。
 */
import type { LongTaskOptions } from "@shared/island-contracts";

/** 虚拟滚动统一行高（px，组头行与应用行同高，免测量；≥40 让 24px 图标底衬有呼吸感） */
export const ROW_HEIGHT = 40;
/** 弹层内列表视口高度（px）——小窗体量，超出即虚拟滚动（ROW_HEIGHT 整数倍免半行抖动） */
export const LIST_VIEWPORT_HEIGHT = 240;
/** 弹层搜索头实测高度（px）：行高 28 + 上下内衬 8×2 + 1px 分隔线 */
export const POPOVER_HEADER_HEIGHT = 45;
/** 列表硬保底线高（px，一行）——空间不足时先牺牲列表行数，搜索框永不被裁 */
export const LIST_MIN_HEIGHT = 48;
/** 弹层与裁剪容器（面板滚动区顶边）之间的留白：8px 呼吸位 + 6px 弹层锚点间距（mb-1.5） */
export const POPOVER_TOP_GAP = 14;
/** 视口上下各多渲染的行数（防快速滚动白屏） */
export const OVERSCAN = 5;
/** 推荐组最多展示条数（A-M2 以 apps:recent 头部为“前台推荐”，A-M3 接看门狗真前台） */
export const RECOMMEND_LIMIT = 5;

/** 分组顺序即渲染顺序：推荐 → 全部；搜索态单组「搜索结果」 */
export const LABEL_RECOMMEND = "推荐";
export const LABEL_ALL = "全部";
export const LABEL_SEARCH = "搜索结果";

/** 锚定长任务档位（规划 §2.1 Q4：600 步 / 4h / 8M tokens；watchdogIdleMs 缺省走 config-store） */
export const ANCHOR_LONG_TASK: LongTaskOptions = {
  maxSteps: 600,
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxTokens: 8_000_000,
};

/**
 * GB2312 一级字拼音排首边界表：第 i 项表示声母 letter 的起始汉字。
 * 对任一汉字用拼音排序（zh-u-co-pinyin）二分定位其所属声母；表覆盖
 * 23 个常用声母（无 I/U/V，与 GB2312 排字一致）。
 */
export const PINYIN_BOUNDARIES: ReadonlyArray<{ letter: string; ch: string }> = [
  { letter: "a", ch: "阿" }, { letter: "b", ch: "八" }, { letter: "c", ch: "嚓" },
  { letter: "d", ch: "哒" }, { letter: "e", ch: "蛾" }, { letter: "f", ch: "发" },
  { letter: "g", ch: "嘎" }, { letter: "h", ch: "哈" }, { letter: "j", ch: "击" },
  { letter: "k", ch: "喀" }, { letter: "l", ch: "垃" }, { letter: "m", ch: "妈" },
  { letter: "n", ch: "拿" }, { letter: "o", ch: "哦" }, { letter: "p", ch: "啪" },
  { letter: "q", ch: "期" }, { letter: "r", ch: "然" }, { letter: "s", ch: "撒" },
  { letter: "t", ch: "塌" }, { letter: "w", ch: "挖" }, { letter: "x", ch: "昔" },
  { letter: "y", ch: "压" }, { letter: "z", ch: "匝" },
];
