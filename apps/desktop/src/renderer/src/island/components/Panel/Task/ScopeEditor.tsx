/**
 * ScopeEditor.tsx — 作用域包四节编辑器（A-M6 授权卡主体，规划 §4.2）
 *
 * 纯受控组件：不碰 IPC。逐项默认勾选（FR-012 审批疲劳缓解定论）由
 * PreAuthDialog 的初始草稿决定：目标应用窗口内 type_text/click/scroll/read_only
 * 默认选中；预算三输入与 ScopePackage.budget 同源可改。
 */
import { useState, type ReactNode } from "react";
import type { GrantOpClass, ScopePackage } from "@shared/island-contracts";

const OP_CLASSES: ReadonlyArray<{ value: GrantOpClass; label: string; hint: string }> = [
  { value: "type_text", label: "输入文字", hint: "在目标应用窗口内键入" },
  { value: "click", label: "点击", hint: "含拖拽与窗口激活" },
  { value: "scroll", label: "滚动", hint: "浏览翻页" },
  { value: "read_only", label: "只读感知", hint: "截图/读界面树/读文件" },
  { value: "hotkey", label: "快捷键", hint: "组合键（默认不勾）" },
  { value: "file_write", label: "写文件", hint: "仅限下方目录白名单内" },
  { value: "export", label: "导出", hint: "另存/导出（默认不勾）" },
];

const HOUR_MS = 3_600_000;
const MILLION_TOKENS = 1_000_000;

function SectionTitle({ children }: { children: string }) {
  return <p className="mb-1.5 text-[11px] font-semibold tracking-wide t-muted">{children}</p>;
}

/** 四节统一分组容器：发丝线 + 留白分节，扫读时一眼数出四节 */
function Section({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <div className={first ? "" : "border-t ig-border-line pt-2.5"}>{children}</div>;
}

export function ScopeEditor({
  appName,
  scope,
  onChange,
}: {
  appName: string;
  scope: ScopePackage;
  onChange: (next: ScopePackage) => void;
}) {
  const [dirDraft, setDirDraft] = useState("");
  const [kwDraft, setKwDraft] = useState("");

  const patch = (over: Partial<ScopePackage>) => onChange({ ...scope, ...over });

  const addListEntry = (key: "dirs" | "sensitiveExcludes", list: string[], value: string) => {
    const v = value.trim();
    if (!v || list.includes(v)) return;
    patch({ [key]: [...list, v] } as Partial<ScopePackage>);
  };
  const removeListEntry = (key: "dirs" | "sensitiveExcludes", list: string[], idx: number) =>
    patch({ [key]: list.filter((_, i) => i !== idx) } as Partial<ScopePackage>);

  const budgetPatch = (key: keyof ScopePackage["budget"], value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    patch({ budget: { ...scope.budget, [key]: Math.round(value) } });
  };

  return (
    <div className="space-y-2.5 text-[12px]">
      <Section first>
        <SectionTitle>① 目标应用</SectionTitle>
        <p className="rounded-lg ig-alert ig-tone-info px-2.5 py-1.5 leading-relaxed">
          仅锚定「{appName}」窗口内的操作生效；窗口外的任何动作一律逐次询问
        </p>
      </Section>

      <Section>
        <SectionTitle>② 读写目录白名单（写文件/导出仅在这些目录内放行）</SectionTitle>
        <div className="flex gap-1.5">
          <input
            data-interactive
            className="island-input flex-1 text-[12px]"
            placeholder="如 C:/发票/**（可留空 = 不授权任何文件写）"
            value={dirDraft}
            maxLength={1024}
            onChange={(e) => setDirDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addListEntry("dirs", scope.dirs, dirDraft);
                setDirDraft("");
              }
            }}
          />
          <button className="island-btn h-8 shrink-0 px-2.5 text-[12px]" onClick={() => { addListEntry("dirs", scope.dirs, dirDraft); setDirDraft(""); }} data-interactive>
            添加
          </button>
        </div>
        {scope.dirs.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {scope.dirs.map((d, i) => (
              <div key={d} className="flex items-center justify-between gap-1.5 rounded-lg ig-bg-panel py-1 pr-1 pl-2.5">
                <span className="min-w-0 truncate" title={d}>{d}</span>
                <button className="island-chip-x" onClick={() => removeListEntry("dirs", scope.dirs, i)} data-interactive aria-label={`移除目录 ${d}`}>×</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section>
        <SectionTitle>③ 操作类别（默认勾选高频安全四类，缓解审批疲劳）</SectionTitle>
        <div className="grid grid-cols-2 gap-x-1.5 gap-y-0.5">
          {OP_CLASSES.map((o) => {
            const on = scope.opClasses.includes(o.value);
            return (
              <label
                key={o.value}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors duration-150 ${
                  on ? "ig-bg-panel-hover t-strong" : "t-body hover:ig-bg-panel"
                }`}
                title={o.hint}
                data-interactive
              >
                <input
                  data-interactive
                  type="checkbox"
                  className="island-check h-3.5 w-3.5"
                  checked={on}
                  onChange={(e) =>
                    patch({
                      opClasses: e.target.checked
                        ? [...scope.opClasses, o.value]
                        : scope.opClasses.filter((v) => v !== o.value),
                    })}
                />
                <span className="truncate">{o.label}</span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section>
        <SectionTitle>④ 敏感排除（命中即强制询问，任何作用域不可覆盖）</SectionTitle>
        <div className="flex gap-1.5">
          <input
            data-interactive
            className="island-input flex-1 text-[12px]"
            placeholder="按钮文本/路径关键词，如 删除"
            value={kwDraft}
            maxLength={64}
            onChange={(e) => setKwDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addListEntry("sensitiveExcludes", scope.sensitiveExcludes, kwDraft);
                setKwDraft("");
              }
            }}
          />
          <button className="island-btn h-8 shrink-0 px-2.5 text-[12px]" onClick={() => { addListEntry("sensitiveExcludes", scope.sensitiveExcludes, kwDraft); setKwDraft(""); }} data-interactive>
            添加
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {scope.sensitiveExcludes.map((kw, i) => (
            <span key={kw} className="ig-tag ig-tone-danger flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-[11px]">
              {kw}
              <button className="island-chip-x" onClick={() => removeListEntry("sensitiveExcludes", scope.sensitiveExcludes, i)} data-interactive aria-label={`移除排除词 ${kw}`}>×</button>
            </span>
          ))}
        </div>
      </Section>

      <Section>
        <SectionTitle>预算（超限自动收口；与任务档位同源）</SectionTitle>
        <div className="grid grid-cols-3 gap-1.5">
          <label className="flex flex-col gap-1 text-[11px] t-faint">
            步数上限
            <input
              data-interactive
              type="number"
              min={1}
              className="island-input t-num text-[12px]"
              value={scope.budget.maxSteps}
              onChange={(e) => budgetPatch("maxSteps", Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] t-faint">
            时长（小时）
            <input
              data-interactive
              type="number"
              min={0.1}
              step={0.5}
              className="island-input t-num text-[12px]"
              value={Number((scope.budget.maxDurationMs / HOUR_MS).toFixed(1))}
              onChange={(e) => budgetPatch("maxDurationMs", Number(e.target.value) * HOUR_MS)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] t-faint">
            Tokens（百万）
            <input
              data-interactive
              type="number"
              min={1}
              className="island-input t-num text-[12px]"
              value={Math.round(scope.budget.maxTokens / MILLION_TOKENS)}
              onChange={(e) => budgetPatch("maxTokens", Number(e.target.value) * MILLION_TOKENS)}
            />
          </label>
        </div>
      </Section>
    </div>
  );
}
