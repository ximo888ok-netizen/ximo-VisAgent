/**
 * lib.test.ts — A-M2 AppPicker 纯函数单测（规划 §5：搜索过滤 / chip 组装 /
 * 单实例替换 / 无 chip payload 零回归红线）。渲染层无组件测试基座，
 * 交互逻辑已全部抽入 lib.ts，此处 vitest 直测；Playwright 项为手测待办。
 */
import { describe, expect, it } from "vitest";
import type { AppEntry, TargetApp } from "@shared/island-contracts";
import {
  appTokenOf,
  appTokenText,
  buildPickerRows,
  buildStartPayload,
  charInitial,
  computePickerHeights,
  hasAppToken,
  insertAppToken,
  isChipReplacement,
  matchApp,
  normalizeQuery,
  pinyinInitials,
  removeAppToken,
  splitGoalByToken,
  stripAppToken,
  toSearchable,
  toTargetApp,
} from "../lib";
import { LIST_MIN_HEIGHT, LIST_VIEWPORT_HEIGHT, POPOVER_HEADER_HEIGHT, POPOVER_TOP_GAP } from "../constants";

function entry(name: string, exePath = "C:\\apps\\a.exe"): AppEntry {
  return { id: name, name, exePath, iconRef: "", source: "registry" };
}

function target(id: string): TargetApp {
  return { id, name: id, exePath: `C:\\apps\\${id}.exe`, iconRef: "", procFamily: [`${id}.exe`] };
}

describe("拼音首字母", () => {
  it("汉字取声母（记事本 → jsb）", () => {
    expect(pinyinInitials("记事本")).toBe("jsb");
    expect(pinyinInitials("北京")).toBe("bj");
  });
  it("字母数字小写直取，其他字符忽略", () => {
    expect(pinyinInitials("Chrome")).toBe("chrome");
    expect(pinyinInitials("Excel 2016")).toBe("excel2016");
    expect(charInitial("，")).toBe("");
  });
});

describe("搜索过滤（名称子串 ∪ 拼音首字母）", () => {
  const apps = toSearchable([entry("记事本"), entry("Google Chrome"), entry("金蝶KIS")]);
  it("首字母串命中", () => {
    expect(apps.filter((a) => matchApp(a, "jsb")).map((a) => a.entry.name)).toEqual(["记事本"]);
    expect(apps.filter((a) => matchApp(a, "kis")).map((a) => a.entry.name)).toEqual(["金蝶KIS"]);
  });
  it("名称子串命中（大小写不敏感）", () => {
    expect(apps.filter((a) => matchApp(a, "chr")).map((a) => a.entry.name)).toEqual(["Google Chrome"]);
    expect(apps.filter((a) => matchApp(a, "金蝶")).length).toBe(1);
  });
  it("无命中返回空；空查询全通过", () => {
    expect(apps.filter((a) => matchApp(a, "zzz不存在"))).toHaveLength(0);
    expect(apps.filter((a) => matchApp(a, "  "))).toHaveLength(3);
  });
});

describe("分组行构建", () => {
  const apps = toSearchable([entry("记事本"), entry("计算器"), entry("Chrome")]);
  it("无查询：推荐组置顶且与全部组去重", () => {
    const rows = buildPickerRows(apps, ["计算器", "记事本"], "");
    expect(rows[0]).toEqual({ kind: "header", label: "推荐" });
    expect(rows.filter((r) => r.kind === "app")).toHaveLength(3);
    const allHeader = rows.findIndex((r) => r.kind === "header" && r.label === "全部");
    expect(allHeader).toBeGreaterThan(0);
    expect(rows.slice(allHeader + 1)).toHaveLength(1); // 仅 Chrome 在全部组
  });
  it("推荐组忽略目录中已不存在（或超上限）的 recent id", () => {
    const rows = buildPickerRows(apps, ["已卸载", "记事本", "计算器", "Chrome"], "");
    expect(rows[1]).toEqual({ kind: "app", app: { entry: entry("记事本"), initials: "jsb" } });
  });
  it("搜索态单「搜索结果」组", () => {
    const rows = buildPickerRows(apps, ["记事本"], "jsq");
    expect(rows[0]).toEqual({ kind: "header", label: "搜索结果" });
    expect(rows).toHaveLength(2); // 组头 + 计算器
  });
});

describe("chip 组装与单实例替换", () => {
  it("AppEntry → TargetApp：procFamily 由 exe basename 小写推出", () => {
    const t = toTargetApp(entry("记事本", "C:\\Windows\\System32\\NOTEPAD.EXE"));
    expect(t).toEqual({
      id: "记事本",
      name: "记事本",
      exePath: "C:\\Windows\\System32\\NOTEPAD.EXE",
      iconRef: "",
      procFamily: ["notepad.exe"],
    });
  });
  it("替换判定：异应用=true，同 id/无前置=false", () => {
    expect(isChipReplacement(null, target("a"))).toBe(false);
    expect(isChipReplacement(target("a"), target("a"))).toBe(false);
    expect(isChipReplacement(target("a"), target("b"))).toBe(true);
  });
});

describe("token 文本流呈现（镜像层高亮法）", () => {
  const tk = appTokenText("记事本"); // [应用:记事本]
  it("token 形态统一半角常量，appTokenOf 取绑定应用名", () => {
    expect(tk).toBe("[应用:记事本]");
    expect(appTokenOf(target("记事本"))).toBe(tk);
  });
  it("插入 = 光标处替换选区，光标落在 token 之后", () => {
    const r = insertAppToken("打开并保存", 2, 2, tk);
    expect(r.value).toBe(`打开${tk}并保存`);
    expect(r.caret).toBe(2 + tk.length);
    const sel = insertAppToken("abcdef", 1, 4, tk);
    expect(sel.value).toBe(`a${tk}ef`);
  });
  it("替换 = 旧 token 全删 + 光标按被删位数左移，再插新 token", () => {
    const old = appTokenText("计算器");
    const value = `${old}+3`;
    const removed = removeAppToken(value, old, value.length);
    expect(removed.value).toBe("+3");
    expect(removed.caret).toBe(2);
    const mid = removeAppToken(`a${old}b`, old, 1); // token 在光标之后 → 光标不动
    expect(mid.caret).toBe(1);
  });
  it("生命周期：整删/删半均判缺失（触发解绑）；strip 只剥绑定应用 token", () => {
    const app = target("记事本");
    expect(hasAppToken(`跑${tk}一下`, app)).toBe(true);
    expect(hasAppToken(`跑[应用:记事本一下`, app)).toBe(false); // 删掉右括号 → 视为删除
    expect(hasAppToken("", app)).toBe(false);
    expect(hasAppToken(tk, target("其他"))).toBe(false);
    expect(stripAppToken(`跑${tk}一下`, app)).toBe("跑一下");
    expect(stripAppToken(`手打${tk}`, null)).toBe(`手打${tk}`); // 未绑定 = 普通文本
  });
  it("镜像分段：text/chip 交替，无绑定整体一段 text", () => {
    expect(splitGoalByToken("打开", null)).toEqual([{ kind: "text", text: "打开" }]);
    expect(splitGoalByToken(`a${tk}b${tk}`, tk)).toEqual([
      { kind: "text", text: "a" },
      { kind: "chip", text: tk },
      { kind: "text", text: "b" },
      { kind: "chip", text: tk },
    ]);
  });
});

describe("发送 payload 组装（零回归红线）", () => {
  it("无 chip：与现状逐字段一致（仅 { goal }）", () => {
    expect(buildStartPayload("打开记事本", null)).toStrictEqual({ goal: "打开记事本" });
  });
  it("带 chip：goal 剥离 token 后为剩余文本，targetApp 字段承载应用语义", () => {
    const t = target("记事本");
    const payload = buildStartPayload(`  ${appTokenOf(t)}输入「你好」  `, t);
    expect(payload.goal).toBe("输入「你好」");
    expect(payload.targetApp).toEqual(t);
  });
  it("带 chip：附加 targetApp + 锚定档 longTask（600 步/4h）", () => {
    const t = target("kis");
    const payload = buildStartPayload("跑月结", t);
    expect(payload.targetApp).toEqual(t);
    expect(payload.longTask?.maxSteps).toBe(600);
    expect(payload.longTask?.maxDurationMs).toBe(4 * 60 * 60 * 1000);
  });
  it("normalizeQuery 去空白并小写", () => {
    expect(normalizeQuery("  JDB ")).toBe("jdb");
  });
});

describe("computePickerHeights（弹层向上弹出的自适应高度）", () => {
  const HEADER = POPOVER_HEADER_HEIGHT;

  it("空间充足：列表取满视口高", () => {
    const r = computePickerHeights({ anchorTop: 400, clipTop: 64, headerH: HEADER });
    expect(r.listH).toBe(LIST_VIEWPORT_HEIGHT);
    expect(r.maxHeight).toBe(HEADER + LIST_VIEWPORT_HEIGHT);
  });

  it("空间紧张：列表收缩到剩余空间，弹层总高不越裁剪边界（搜索框被裁的回归）", () => {
    const available = 228 - 64 - POPOVER_TOP_GAP; // 150
    const r = computePickerHeights({ anchorTop: 228, clipTop: 64, headerH: HEADER });
    expect(r.listH).toBe(available - HEADER);
    expect(r.maxHeight).toBeLessThanOrEqual(available);
  });

  it("以裁剪容器而非视口为界：clipTop 越大可用空间越小", () => {
    const byViewport = computePickerHeights({ anchorTop: 228, clipTop: 0, headerH: HEADER });
    const byClipper = computePickerHeights({ anchorTop: 228, clipTop: 64, headerH: HEADER });
    expect(byViewport.maxHeight).toBeGreaterThan(byClipper.maxHeight);
  });

  it("极端矮：保底一行列表，宁少显示不丢搜索框", () => {
    const r = computePickerHeights({ anchorTop: 100, clipTop: 64, headerH: HEADER });
    expect(r.listH).toBe(LIST_MIN_HEIGHT);
    expect(r.maxHeight).toBe(HEADER + LIST_MIN_HEIGHT);
  });
});
