/**
 * ApprovalParamsEditor.tsx — 审批卡「修改参数」编辑态
 *
 * 编辑期间由父层临时放开窗口键盘输入（IslandApproval 的 setKeyboardInput effect）。
 */
export function ApprovalParamsEditor({
  keys,
  params,
  onChange,
  onExit,
}: {
  keys: string[];
  params: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onExit: () => void;
}) {
  return (
    <div
      className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onExit();
        }
      }}
    >
      {keys.map((k) => (
        <label key={k} className="flex items-center gap-2 text-[11px] t-body">
          <span className="w-16 shrink-0 truncate">{k}</span>
          <input
            value={params[k] ?? ""}
            onChange={(e) => onChange(k, e.target.value)}
            className="min-w-0 flex-1 rounded-md border ig-border-line ig-bg-panel px-2 py-1 text-[11.5px] text-[var(--ig-t-strong)] outline-none focus:border-[#2e7cf6]"
          />
        </label>
      ))}
      <span className="col-span-2 text-right text-[9.5px] t-faint">Esc 退出编辑</span>
    </div>
  );
}
