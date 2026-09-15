/**
 * composer-lib.test.ts — contenteditable 输入区纯函数核单测
 *
 * 渲染层无组件测试基座（node 环境无 jsdom）：序列化/chip 识别/清洗全部走
 * EditableNodeLike 最小结构接口，用 plain object 打桩即可钉死关键行为。
 * 红线：无 chip 序列化 + buildStartPayload 与旧 token 方案逐字段一致（零回归）。
 */
import { describe, expect, it } from "vitest";
import type { TargetApp } from "@shared/island-contracts";
import {
  CHIP_APP_ATTR,
  CHIP_ATTR,
  MAX_GOAL_LENGTH,
  clampGoal,
  cleanPastedText,
  decodeChipApp,
  encodeChipApp,
  findChipNodes,
  pasteBudget,
  pickChipApp,
  serializeEditable,
} from "../composer-lib";
import { buildStartPayload } from "../AppPicker/lib";

/* ---- 最小结构节点桩（与真实 DOM 节点同形状） ---- */

interface TextNode {
  readonly nodeType: 3;
  readonly nodeName: string;
  readonly textContent: string;
  readonly childNodes: readonly never[];
}
function text(t: string): TextNode {
  return { nodeType: 3, nodeName: "#text", textContent: t, childNodes: [] };
}

interface ElNode {
  readonly nodeType: 1;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: readonly FakeNode[];
  readonly getAttribute: (name: string) => string | null;
}
type FakeNode = TextNode | ElNode;

function el(nodeName: string, attrs: Record<string, string>, children: FakeNode[] = []): ElNode {
  return {
    nodeType: 1,
    nodeName,
    textContent: children.map((c) => c.textContent ?? "").join(""),
    childNodes: children,
    getAttribute: (name) => attrs[name] ?? null,
  };
}

function chipNode(app: TargetApp): ElNode {
  return el("SPAN", { [CHIP_ATTR]: "1", [CHIP_APP_ATTR]: encodeChipApp(app) }, [text(app.name), text("×")]);
}

function brNode(): ElNode {
  return el("BR", {}, []);
}

function target(id: string): TargetApp {
  return { id, name: id, exePath: `C:\\apps\\${id}.exe`, iconRef: "", procFamily: [`${id}.exe`] };
}

describe("序列化（chip = 原子节点，goal 贡献 0 字符）", () => {
  const app = target("记事本");
  it("含 chip：goal 剔除 chip 全部子文本，app 从 data 属性还原", () => {
    const snap = serializeEditable([text("打开"), chipNode(app), text("，输入「你好」")]);
    expect(snap.goal).toBe("打开，输入「你好」");
    expect(snap.app).toStrictEqual(app);
  });
  it("无 chip：与旧 textarea 行为逐字段一致（原文透传 + payload 仅 { goal }）", () => {
    const snap = serializeEditable([text(" 打开记事本 ")]);
    expect(snap.goal).toBe(" 打开记事本 ");
    expect(snap.app).toBeNull();
    expect(buildStartPayload(snap.goal, snap.app)).toStrictEqual({ goal: "打开记事本" });
  });
  it("零回归对照：旧 stripAppToken(「打开[应用:记事本]保存」) 的输出 = 新序列化输出", () => {
    const snap = serializeEditable([text("打开"), chipNode(app), text("保存")]);
    expect(buildStartPayload(snap.goal, snap.app).goal).toBe("打开保存");
  });
  it("单实例裁决：异常多枚 chip 取首枚 app", () => {
    const chips = findChipNodes([chipNode(app), chipNode(target("计算器"))]);
    expect(chips).toHaveLength(2);
    expect(pickChipApp(chips)).toStrictEqual(app);
  });
  it("换行：BR → \\n；块尾/文档尾占位 BR 丢弃", () => {
    expect(serializeEditable([text("a"), brNode(), text("b")]).goal).toBe("a\nb");
    expect(serializeEditable([text("a"), brNode()]).goal).toBe("a");
    expect(serializeEditable([text("a"), brNode(), brNode(), text("b")]).goal).toBe("a\n\nb");
  });
  it("contenteditable=true 回退形态：DIV 块补换行，空块（仅占位 BR）成空行", () => {
    const nodes = [el("DIV", {}, [text("第一行")]), el("DIV", {}, [text("第二行")])];
    expect(serializeEditable(nodes).goal).toBe("第一行\n第二行");
    const withEmpty = [el("DIV", {}, [text("x")]), el("DIV", {}, [brNode()])];
    expect(serializeEditable(withEmpty).goal).toBe("x\n");
  });
  it("chip 序列化不递归其子树（图标/名称/× 均不进 goal）", () => {
    const nested = el("SPAN", { [CHIP_ATTR]: "1", [CHIP_APP_ATTR]: encodeChipApp(app) }, [
      el("SPAN", {}, [text("记事本")]),
      el("SPAN", {}, [text("×")]),
    ]);
    expect(serializeEditable([text("前"), nested, text("后")]).goal).toBe("前后");
  });
});

describe("chip 数据编解码（payload 契约不变的载体）", () => {
  it("encode→decode 往返逐字段一致", () => {
    const app = target("kis");
    expect(decodeChipApp(encodeChipApp(app))).toStrictEqual(app);
  });
  it("脏数据一律判 null（宁丢绑定不造脏 payload）", () => {
    expect(decodeChipApp(null)).toBeNull();
    expect(decodeChipApp("{bad")).toBeNull();
    expect(decodeChipApp("[1,2]")).toBeNull();
    expect(decodeChipApp(JSON.stringify({ id: "a" }))).toBeNull(); // 缺必填字段
    expect(decodeChipApp(JSON.stringify({ id: "a", name: "A", exePath: "e", procFamily: [1] }))).toBeNull();
  });
});

describe("输入治理", () => {
  it("MAX_GOAL_LENGTH 沿袭 textarea 2000 上限", () => {
    expect(MAX_GOAL_LENGTH).toBe(2000);
  });
  it("粘贴清洗：剥 HTML 标签残留 / CRLF 归一 / 去控制字符 / 预算截断", () => {
    expect(cleanPastedText("<b>粗体</b>普通文本", 100)).toBe("粗体普通文本");
    expect(cleanPastedText("a\r\nb\rc", 100)).toBe("a\nb\nc");
    expect(cleanPastedText("a\u0000b\u001fc", 100)).toBe("abc");
    expect(cleanPastedText("超长内容abcdefg", 4)).toBe("超长内容");
    expect(cleanPastedText("任何内容", 0)).toBe("");
    expect(cleanPastedText("任何内容", -5)).toBe("");
  });
  it("清洗输出不含 HTML 标签形态", () => {
    expect(cleanPastedText('<img src=x onerror="alert(1)">hi', 100)).toBe("hi");
    expect(cleanPastedText('<script>alert(1)</script>', 100)).toBe("alert(1)");
  });
  it("clampGoal / pasteBudget 边界", () => {
    expect(clampGoal("abc", 2)).toBe("ab");
    expect(clampGoal("abc", 5)).toBe("abc");
    expect(pasteBudget(1990)).toBe(10);
    expect(pasteBudget(2500)).toBe(0);
  });
});
