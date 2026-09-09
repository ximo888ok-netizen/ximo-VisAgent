/**
 * sop-format.ts — SOP 导入导出的文件格式与纯解析助手
 *
 * 从 ipc/island-smart-handlers.ts 下放：handler 只做「校验 + 转发」（A5），
 * 版本化格式定义与字符串解析属于业务逻辑，独立可测。
 */

/** SOP 导出格式（版本化，供导入校验与未来兼容） */
export interface SopExportFormat {
  format: "ximo-visagent-sop";
  version: 1;
  name: string;
  description: string;
  goalTemplate: string;
  stepsJson: string;
  variablesJson: string;
}

/** SOP 变量占位符声明 */
export interface SopVariable {
  key: string;
  label: string;
  defaultValue: string;
}

/** 教学录制步骤 "actionName(jsonArgs)" 解析出的步骤结构 */
export interface RecordedStep {
  index: number;
  thought: string;
  actionName: string | null;
  args: Record<string, unknown> | null;
  resultSummary: string;
}

export function safeParseVariables(json: string | undefined): SopVariable[] {
  try {
    const v = JSON.parse(json ?? "[]") as { key?: unknown; label?: unknown; defaultValue?: unknown }[];
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => typeof x?.key === "string")
      .map((x) => ({ key: String(x.key), label: String(x.label ?? x.key), defaultValue: String(x.defaultValue ?? "") }));
  } catch {
    return [];
  }
}

/** 教学录制步骤 "actionName(jsonArgs)" → StepDetail 结构 */
export function parseRecordedStep(s: string, index: number): RecordedStep {
  const m = s.match(/^(\w+)\s*\(([\s\S]*)\)\s*$/);
  if (m && m[1]) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(m[2] || "{}") as Record<string, unknown>;
    } catch { args = {}; }
    return { index, thought: "用户演示", actionName: m[1], args, resultSummary: s.slice(0, 300) };
  }
  return { index, thought: s.slice(0, 300), actionName: null, args: null, resultSummary: s.slice(0, 300) };
}
