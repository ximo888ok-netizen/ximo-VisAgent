/**
 * SopPanel.tsx — SOP 模板库（卡片网格：名称/次数/近次运行 → 填参运行）
 * B2：删除需二次确认（第一次点击变"确认删除"3s）
 * 导入导出：导出 JSON 到剪贴板/文件；导入从 .json 文件
 */
import { useEffect, useRef, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import type { SopRowPayload } from "@shared/island-contracts";
import { SopCard } from "./Sop/SopCard";

export function SopPanel() {
  const sops = useIslandStore((s) => s.sops);
  const sopLoading = useIslandStore((s) => s.sopLoading);
  const sopError = useIslandStore((s) => s.sopError);
  const loadSops = useIslandStore((s) => s.loadSops);
  const deleteSop = useIslandStore((s) => s.deleteSop);
  const pushView = useIslandStore((s) => s.pushView);
  const pushToast = useIslandStore((s) => s.pushToast);
  /** 待二次确认删除的模板 id */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSops();
  }, [loadSops]);

  // 二次确认 3s 超时自动取消
  useEffect(() => {
    if (!confirmingId) return;
    const t = window.setTimeout(() => setConfirmingId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmingId]);

  // 导出：写剪贴板（失败回退下载 .json 文件）
  const handleExport = async (sop: SopRowPayload) => {
    const res = await window.islandAPI.sopExport({ sopId: sop.id });
    if (!res.ok) {
      pushToast("error", `导出失败: ${res.error}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(res.data.json);
      pushToast("success", `模板「${sop.name}」已复制到剪贴板，可分享给他人导入`);
    } catch {
      try {
        const blob = new Blob([res.data.json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${sop.name}.sop.json`;
        a.click();
        URL.revokeObjectURL(url);
        pushToast("info", `模板「${sop.name}」已导出为文件`);
      } catch {
        pushToast("error", "导出失败：剪贴板与文件下载均不可用");
      }
    }
  };

  // 导入：读取 .json 文件
  const handleImportFile = async (file: File) => {
    try {
      const json = await file.text();
      const res = await window.islandAPI.sopImport({ json });
      if (res.ok) {
        pushToast("success", `模板「${res.data.name}」导入成功`);
        void loadSops();
      } else {
        pushToast("error", res.error);
      }
    } catch {
      pushToast("error", "文件读取失败");
    }
  };

  const handleDelete = async (sop: SopRowPayload) => {
    if (confirmingId !== sop.id) {
      setConfirmingId(sop.id);
      return;
    }
    setConfirmingId(null);
    // M01 修复：检查删除结果，失败时提示错误
    const ok = await deleteSop(sop.id);
    if (ok) {
      pushToast("success", `模板「${sop.name}」已删除`);
    } else {
      pushToast("error", `删除失败`);
    }
  };

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10.5px] t-faint">
          任务完成后在任务面板「存为模板」；运行时注入步骤骨架提升成功率
        </span>
        <div className="flex shrink-0 gap-2">
          <button data-interactive className="text-[10.5px] t-muted hover:t-body" onClick={() => void loadSops()}>
            刷新
          </button>
          <button data-interactive className="text-[10.5px] t-muted hover:t-body" onClick={() => importInputRef.current?.click()}>
            导入
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="island-panel-scroll min-h-0 flex-1">
        {/* C：首次加载骨架 */}
        {sopLoading && sops.length === 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="island-skeleton h-24 rounded-xl ig-bg-panel" />
            <div className="island-skeleton h-24 rounded-xl ig-bg-panel" />
            <div className="island-skeleton h-24 rounded-xl ig-bg-panel" />
            <div className="island-skeleton h-24 rounded-xl ig-bg-panel" />
          </div>
        )}
        {!sopLoading && sopError && (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <span className="text-[11px] text-red-300">模板列表加载失败：{sopError}</span>
            <button data-interactive className="island-btn island-btn--ghost text-[10.5px]" onClick={() => void loadSops()}>
              重试
            </button>
          </div>
        )}
        {!sopLoading && !sopError && sops.length === 0 && (
          <div className="flex h-24 items-center justify-center text-[11px] t-faint">
            暂无模板 · 完成一个任务后保存试试
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {sops.map((sop) => (
            <SopCard
              key={sop.id}
              sop={sop}
              confirming={confirmingId === sop.id}
              onRun={() => pushView({ kind: "sopRun", sopId: sop.id })}
              onDelete={() => handleDelete(sop)}
              onExport={() => void handleExport(sop)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

