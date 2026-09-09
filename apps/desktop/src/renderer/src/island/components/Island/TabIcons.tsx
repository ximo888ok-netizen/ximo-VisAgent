/**
 * TabIcons.tsx — 面板导航图标（SVG 内联，小尺寸）
 *
 * 从 PanelContainer 拆出：纯呈现，10 个模式各一支 path，无状态无副作用。
 */
export function TabIcon({ name }: { name: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
  } as const;
  switch (name) {
    case "task":
      return (
        <svg {...common}>
          <path d="M3 4h10M3 8h7M3 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "sop":
      return (
        <svg {...common}>
          <rect x="2.5" y="2" width="11" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 5.5h6M5 8h6M5 10.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "schedule":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M5.5 1.5v1.5M10.5 1.5v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "stats":
      return (
        <svg {...common}>
          <path d="M2.5 13.5V11M5.5 13.5V7.5M8.5 13.5V5M11.5 13.5V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "log":
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h6M5 8.5h4M5 11h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "audit":
      return (
        <svg {...common}>
          <path d="M2.5 3.5h8.5v9h-8.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M11.5 5.5h2v5.5a1.5 1.5 0 01-1.5 1.5 1.5 1.5 0 01-1.5-1.5V5.5h1z" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 6.5h4.5M4.5 8.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "evolution":
      return (
        <svg {...common}>
          <path d="M8 2.5C5 2.5 4 5 4 7c0 1.5.5 2.5 1 3.5.4.8.5 1.2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
          <path d="M8 2.5c3 0 4 2.5 4 4.5 0 1.5-.5 2.5-1 3.5-.4.8-.5 1.2-.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
          <circle cx="8" cy="2.5" r="1.2" fill="currentColor" />
          <circle cx="4" cy="7" r="1" fill="currentColor" />
          <circle cx="12" cy="7" r="1" fill="currentColor" />
          <path d="M6.5 13.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "employee":
      return (
        <svg {...common}>
          <circle cx="8" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 13.5c0-3 2.2-5 5-5s5 2 5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "mission":
      return (
        <svg {...common}>
          <rect x="2.5" y="2" width="11" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 5h6M5 8h4M5 11h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <circle cx="11" cy="11" r="1.5" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}
