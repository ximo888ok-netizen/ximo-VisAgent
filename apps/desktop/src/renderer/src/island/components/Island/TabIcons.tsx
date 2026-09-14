/**
 * TabIcons.tsx — 面板导航图标（内联 SVG）
 *
 * 绘制规范（全套 11 个图标一致，不得单独破例）：
 * - 网格 16×16，内容留约 1.5px 安全边距（绘制范围 2.5 ~ 13.5）
 * - 描边统一 1.5，圆头圆角（round cap / round join）
 * - 一律 currentColor，颜色由父级文字色决定
 * - 容器类图形（圆 / 方）统一用 r=5.5 或 11×11，保证光学重量一致
 *
 * 为什么统一：改造前这一套里混用了 1.1 / 1.2 / 1.3 / 1.5 四种描边粗细。
 * 人眼对线宽差异极其敏感——并排两个图标一个 1.1 一个 1.5，就会读出"不是一套东西"，
 * 这是界面显得不精致的头号来源。
 */
const BOX = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
} as const;

/** 统一描边：所有图标共用，不要在内联处再写 strokeWidth */
const S = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 实心小点（不需要描边，用 fill 表达） */
const DOT = { fill: "currentColor", stroke: "none" } as const;

export function TabIcon({ name }: { name: string }) {
  switch (name) {
    /* 任务：对话流（三条递减的线，无容器） */
    case "task":
      return (
        <svg {...BOX}>
          <path d="M3 5h10M3 8h10M3 11h6" {...S} />
        </svg>
      );

    /* 历史：时钟 */
    case "history":
      return (
        <svg {...BOX}>
          <circle cx="8" cy="8" r="5.5" {...S} />
          <path d="M8 4.8v3.4l2.3 1.4" {...S} />
        </svg>
      );

    /* SOP：竖版文档 + 三行正文 */
    case "sop":
      return (
        <svg {...BOX}>
          <rect x="3" y="2.5" width="10" height="11" rx="1.6" {...S} />
          <path d="M5.6 6h4.8M5.6 8.4h4.8M5.6 10.8h2.8" {...S} />
        </svg>
      );

    /* 定时：日历（与"历史"的时钟明确区分）+ 一个实心日期点 */
    case "schedule":
      return (
        <svg {...BOX}>
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.6" {...S} />
          <path d="M2.5 6.6h11M5.6 2v2.6M10.4 2v2.6" {...S} />
          <circle cx="8" cy="10.3" r="1" {...DOT} />
        </svg>
      );

    /* 统计：四根柱 */
    case "stats":
      return (
        <svg {...BOX}>
          <path d="M3.6 13V9.6M6.5 13V6.2M9.5 13V8.2M12.4 13V4" {...S} />
        </svg>
      );

    /* 日志：终端窗口 + 提示符 */
    case "log":
      return (
        <svg {...BOX}>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.6" {...S} />
          <path d="M5.4 6.6 7 8.2l-1.6 1.6M8.6 9.8h3" {...S} />
        </svg>
      );

    /* 设置：齿轮（圆心 + 八向齿） */
    case "settings":
      return (
        <svg {...BOX}>
          <circle cx="8" cy="8" r="2.3" {...S} />
          <path
            d="M8 2.4v2M8 11.6v2M2.4 8h2M11.6 8h2M4.03 4.03l1.42 1.42M10.55 10.55l1.42 1.42M4.03 11.97l1.42-1.42M10.55 5.45l1.42-1.42"
            {...S}
          />
        </svg>
      );

    /* 审计：带夹板的记录本 */
    case "audit":
      return (
        <svg {...BOX}>
          <rect x="3" y="3" width="10" height="10.5" rx="1.6" {...S} />
          <path d="M6 3V2.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V3" {...S} />
          <path d="M5.6 7.2h4.8M5.6 9.8h2.8" {...S} />
        </svg>
      );

    /* 演化：新芽（成长语义，比抽象曲线更可读） */
    case "evolution":
      return (
        <svg {...BOX}>
          <path d="M8 13.5V7.2" {...S} />
          <path d="M8 7.2C8 4.6 6.1 2.8 3.4 2.8c0 2.6 1.9 4.4 4.6 4.4Z" {...S} />
          <path d="M8 7.2c0-2.6 1.9-4.4 4.6-4.4 0 2.6-1.9 4.4-4.6 4.4Z" {...S} />
        </svg>
      );

    /* 员工：人像 */
    case "employee":
      return (
        <svg {...BOX}>
          <circle cx="8" cy="5.6" r="2.6" {...S} />
          <path d="M3.2 13.6c0-2.9 2.1-4.9 4.8-4.9s4.8 2 4.8 4.9" {...S} />
        </svg>
      );

    /* 任务库：带勾的方框 */
    case "mission":
      return (
        <svg {...BOX}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.2" {...S} />
          <path d="M5.6 8.1 7.2 9.8l3.3-3.7" {...S} />
        </svg>
      );

    default:
      return null;
  }
}

/** 返回箭头（二级视图用，与上面共用同一绘制规范） */
export function BackIcon() {
  return (
    <svg {...BOX}>
      <path d="M9.8 3.5 5.4 8l4.4 4.5" {...S} />
    </svg>
  );
}
