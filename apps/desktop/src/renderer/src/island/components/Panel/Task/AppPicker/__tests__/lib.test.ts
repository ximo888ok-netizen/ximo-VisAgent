/**
 * lib.test.ts — A-M2 AppPicker 纯函数单测（规划 §5：搜索过滤 / chip 组装 /
 * 单实例替换 / 无 chip payload 零回归红线）。渲染层无组件测试基座，
 * 交互逻辑已全部抽入 lib.ts，此处 vitest 直测；Playwright 项为手测待办。
 */
import { describe, expect, it } from "vitest";
import type { AppEntry, TargetApp } from "@shared/island-contracts";
import {
  buildPickerRows,
  buildStartPayload,
  charInitial,
  isChipReplacement,
  matchApp,
  normalizeQuery,
  pinyinInitials,
  toSearchable,
  toTargetApp,
} from "../lib";

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

describe("发送 payload 组装（零回归红线）", () => {
  it("无 chip：与现状逐字段一致（仅 { goal }）", () => {
    expect(buildStartPayload("打开记事本", null)).toStrictEqual({ goal: "打开记事本" });
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
