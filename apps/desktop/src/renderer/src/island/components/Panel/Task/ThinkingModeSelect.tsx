/**
 * ThinkingModeSelect.tsx — 思考模式四档选择器（Agent 输入框工具条，审批档位旁）
 *
 * 档位决定「这一步开不开思考」，再由各供应商映射成真实参数（qwen enable_thinking /
 * glm+deepseek thinking.type；kimi 无开关字段 → 安全降级为无操作）：
 * - auto  按步自适应（默认）：失败/停滞/审批/歧义/里程碑等节点强制思考，例行动作不思考，模型也可自请
 * - daily 恒关——日常直操最快
 * - long  前 2 步关，之后恒开——长任务中途防走歪
 * - deep  全程恒开——调研/复杂分析
 */
import { useIslandStore } from "../../../store/islandStore";

const OPTIONS = [
  { value: "auto", label: "思考·自动" },
  { value: "daily", label: "思考·日常" },
  { value: "long", label: "思考·长任务" },
  { value: "deep", label: "思考·深度" },
] as const;

type Mode = (typeof OPTIONS)[number]["value"];

const TITLES: Record<Mode, string> = {
  auto: "自动（默认）：按步自适应——失败/停滞/审批/多候选/里程碑等节点强制思考，例行动作不思考",
  daily: "日常：全程不思考，最快",
  long: "长任务：前 2 步不思考，之后每步思考",
  deep: "深度研究：全程深度思考",
};

export function ThinkingModeSelect() {
  const config = useIslandStore((s) => s.config);
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const pushToast = useIslandStore((s) => s.pushToast);
  const mode = config?.agent.thinkingMode ?? "auto";

  async function onChange(next: Mode) {
    if (next === mode) return;
    const res = await saveConfig({ agent: { thinkingMode: next } });
    if (!res.ok) pushToast("error", res.error ?? "思考模式切换失败");
  }

  return (
    <div data-interactive>
      <select
        className="island-select px-2 py-1 text-[12px]"
        style={{ paddingRight: 22 }}
        value={mode}
        onChange={(e) => void onChange(e.target.value as Mode)}
        aria-label="思考模式"
        title={TITLES[mode]}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={TITLES[o.value]}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
