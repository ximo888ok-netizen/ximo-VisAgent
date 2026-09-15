/**
 * lib.test.ts — B-M3 长期任务面板纯函数单测（cron 人话 / 状态徽标 / 错过合并标注 /
 * 断点摘要 / 游标比例 / 抽屉轮次解析）。渲染层无组件测试基座，逻辑全部抽入 lib.ts 直测。
 */
import { describe, expect, it } from "vitest";
import type { AuditRowPayload, LongTaskCheckpointSummary } from "@shared/island-contracts";
import {
  cursorText,
  durationText,
  humanizeCron,
  missedLabel,
  nextRunText,
  progressPct,
  roundDurationMs,
  roundGate,
  runBadge,
} from "../lib";

function cp(done: number, total?: number, unit = "行"): LongTaskCheckpointSummary {
  return { seq: 3, kind: "host", done, ...(total ? { total } : {}), unit, summary: "", artifactCount: 0, createdAt: 0 };
}

function audit(kind: string, ts: number, detail = "{}"): AuditRowPayload {
  return { id: `${kind}-${ts}`, taskId: "t1", kind, timestamp: ts, seq: 0, detail };
}

/** 相对 today 的本地时间戳（避免时区脆弱：全部按本机日历构造） */
function dayAt(offsetDays: number, hour: number, minute: number): number {
  const base = new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, hour, minute).getTime();
}

describe("humanizeCron（5 字段 cron → 人话）", () => {
  it("识别每日/工作日/周几/整点/每小时/每月", () => {
    expect(humanizeCron("0 9 * * *")).toBe("每天 09:00");
    expect(humanizeCron("30 18 * * 1-5")).toBe("工作日 18:30");
    expect(humanizeCron("0 10 * * 1")).toBe("每周一 10:00");
    expect(humanizeCron("0 10 * * 1,3,5")).toBe("每周一、周三、周五 10:00");
    expect(humanizeCron("0 * * * *")).toBe("每小时整点");
    expect(humanizeCron("15 * * * *")).toBe("每小时第15分");
    expect(humanizeCron("0 8 1 * *")).toBe("每月1日 08:00");
  });
  it("每 N 分钟 / 每分钟", () => {
    expect(humanizeCron("*/5 * * * *")).toBe("每5分钟");
    expect(humanizeCron("* * * * *")).toBe("每分钟");
  });
  it("识别不了的形态回退原串（不臆造语义）", () => {
    expect(humanizeCron("0 9 * 3 *")).toBe("按 Cron：0 9 * 3 *");
    expect(humanizeCron("bad")).toBe("按 Cron：bad");
    expect(humanizeCron("0 9,18 * * *")).toBe("按 Cron：0 9,18 * * *");
  });
});

describe("runBadge（上次状态徽标）", () => {
  it("paused-out-of-scope → 等待批复（FR-011 标注一）", () => {
    expect(runBadge("paused-out-of-scope", true)).toEqual({ label: "暂停（超范围）· 等待批复", tone: "warning" });
  });
  it("done/failed/running/skipped-busy 各有语义", () => {
    expect(runBadge("done", true).tone).toBe("success");
    expect(runBadge("failed", true).tone).toBe("danger");
    expect(runBadge("running", true).label).toBe("运行中");
    expect(runBadge("skipped-busy", true).label).toContain("上轮");
  });
  it("无状态：停用 → 已停用；启用 → 从未运行", () => {
    expect(runBadge(undefined, false).label).toBe("已停用");
    expect(runBadge(null, true).label).toBe("从未运行");
  });
});

describe("missedLabel（错过合并补跑标注，FR-011 标注二）", () => {
  it("昨日 09:00 错过 → 「昨日 09:00 错过，已并入今日补跑」", () => {
    const now = dayAt(0, 17, 0);
    const text = missedLabel({ count: 1, fromAt: dayAt(-1, 9, 0), intoAt: now }, now);
    expect(text).toBe("昨日 09:00 错过，已并入今日补跑");
  });
  it("多槽位合并附带数量；按时触发无标注", () => {
    const now = dayAt(0, 10, 0);
    const text = missedLabel({ count: 2, fromAt: dayAt(-1, 9, 0), intoAt: now }, now);
    expect(text).toContain("合并 2 个错过槽位");
    expect(missedLabel(undefined, now)).toBeNull();
  });
});

describe("断点摘要与游标", () => {
  it("cursorText：有总数「已处理 1400/2000 行」，无总数不编分母", () => {
    expect(cursorText(cp(1400, 2000))).toBe("已处理 1400/2000 行");
    expect(cursorText(cp(42, undefined, "项"))).toBe("已处理 42 项");
    expect(cursorText(null)).toBeNull();
  });
  it("progressPct：夹在 0..100；无 total 时 done>0 记满", () => {
    expect(progressPct(cp(500, 2000))).toBe(25);
    expect(progressPct(cp(2500, 2000))).toBe(100);
    expect(progressPct(cp(7, undefined))).toBe(100);
    expect(progressPct(null)).toBe(0);
  });
});

describe("抽屉轮次解析", () => {
  it("roundGate：取最新一条 task_gate_report，乱序也稳定", () => {
    const rows = [
      audit("task_gate_report", 200, JSON.stringify({ gate: "assertion" })),
      audit("step", 100),
      audit("task_gate_report", 300, JSON.stringify({ gate: "stall" })),
    ];
    expect(roundGate(rows)).toBe("stall");
    expect(roundGate([audit("step", 1)])).toBeNull();
    expect(roundGate([audit("task_gate_report", 9, "not-json")])).toBeNull();
  });
  it("roundDurationMs：不足两事件返回 null（不猜）", () => {
    expect(roundDurationMs([audit("step", 1000), audit("step", 61000)])).toBe(60000);
    expect(roundDurationMs([audit("step", 1000)])).toBeNull();
  });
  it("durationText：s / m+s / h+m 三档", () => {
    expect(durationText(45_000)).toBe("45s");
    expect(durationText(12 * 60_000 + 5_000)).toBe("12m05s");
    expect(durationText(3_661_000)).toBe("1h01m");
    expect(durationText(null)).toBe("—");
  });
});

describe("nextRunText（相对日 + HH:mm）", () => {
  it("今日/明日/后日；无排期「—」", () => {
    const now = dayAt(0, 8, 0);
    expect(nextRunText(dayAt(0, 9, 0), now)).toBe("今日 09:00");
    expect(nextRunText(dayAt(1, 9, 0), now)).toBe("明日 09:00");
    expect(nextRunText(null, now)).toBe("—");
  });
});
