/**
 * WorldModelPanel.tsx — 世界模型面板（设置子页）
 *
 * 结构：搜索框 → 添加表单 → 事实卡片列表（置信度条 + kind 徽标）
 */
import { useEffect, useState } from "react";
import type { WorldModelAddRequest } from "@shared/island-contracts";
import { useIslandStore } from "../../store/islandStore";

type EnvFactKind = WorldModelAddRequest["kind"];

const KIND_LABEL: Record<EnvFactKind, string> = {
  app: "应用",
  login: "登录",
  path: "路径",
  workflow: "流程",
  preference: "偏好",
  "ui-convention": "UI约定",
  fact: "事实",
};

export function WorldModelPanel() {
  const envFacts = useIslandStore((s) => s.envFacts);
  const envFactsLoading = useIslandStore((s) => s.envFactsLoading);
  const envScanning = useIslandStore((s) => s.envScanning);
  const loadEnvFacts = useIslandStore((s) => s.loadEnvFacts);
  const addEnvFact = useIslandStore((s) => s.addEnvFact);
  const scanEnvFacts = useIslandStore((s) => s.scanEnvFacts);
  const [search, setSearch] = useState("");
  const [newKind, setNewKind] = useState<EnvFactKind>("fact");
  const [newContent, setNewContent] = useState("");

  useEffect(() => {
    void loadEnvFacts();
  }, [loadEnvFacts]);

  const handleSearch = () => {
    void loadEnvFacts(search || undefined);
  };

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    const ok = await addEnvFact({ kind: newKind, content: newContent.trim() });
    if (ok) {
      setNewContent("");
      useIslandStore.getState().pushToast("success", "事实已添加");
    }
  };

  const handleScan = async () => {
    const { added, updated } = await scanEnvFacts();
    const parts: string[] = [];
    if (added > 0) parts.push(`新增 ${added} 条`);
    if (updated > 0) parts.push(`更新 ${updated} 条`);
    useIslandStore.getState().pushToast(
      added > 0 || updated > 0 ? "success" : "info",
      parts.length > 0 ? `环境扫描完成：${parts.join("，")}` : "环境扫描完成，未发现新事实",
    );
  };

  return (
    <div className="space-y-3">
      <label className="island-label">世界模型</label>
      <p className="text-[11px] t-faint leading-relaxed">
        结构化事实存储，任务启动时按置信度 top-k 注入 Agent 上下文。
      </p>

      {/* 快速熟悉环境 */}
      <button
        data-interactive
        className="island-btn island-btn--primary w-full text-[10px]"
        onClick={handleScan}
        disabled={envScanning}
      >
        {envScanning ? "正在扫描环境…" : "⚡ 快速熟悉环境"}
      </button>
      {envScanning && (
        <div className="text-[10px] t-faint text-center">
          Agent 正在扫描已安装应用与工作目录，提炼环境事实…
        </div>
      )}

      {/* 搜索 */}
      <div className="flex gap-2">
        <input
          className="island-input flex-1 text-[11px]"
          placeholder="搜索事实…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          data-interactive
        />
        <button data-interactive className="island-btn island-btn--ghost text-[10px]" onClick={handleSearch}>
          搜索
        </button>
      </div>

      {/* 添加表单 */}
      <div className="rounded-lg ig-bg-panel p-2.5 space-y-2">
        <div className="text-[10px] t-faint">手动添加</div>
        <div className="flex gap-2">
          <select
            data-interactive
            className="rounded-md ig-bg-base px-2 py-1 text-[10px] t-body"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as EnvFactKind)}
          >
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input
            className="island-input flex-1 text-[11px]"
            placeholder="事实内容…"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            data-interactive
          />
        </div>
        <button
          data-interactive
          className="island-btn island-btn--primary w-full text-[10px]"
          onClick={handleAdd}
          disabled={!newContent.trim()}
        >
          添加
        </button>
      </div>

      {/* 事实列表 */}
      <div className="space-y-1.5">
        {envFactsLoading && envFacts.length === 0 && (
          <>
            <div className="island-skeleton h-12 rounded-lg ig-bg-panel" />
            <div className="island-skeleton h-12 rounded-lg ig-bg-panel" />
          </>
        )}
        {!envFactsLoading && envFacts.length === 0 && (
          <div className="flex h-16 items-center justify-center text-[11px] t-faint">
            暂无事实 · 任务完成后自动提炼
          </div>
        )}
        {envFacts.map((fact) => (
          <div key={fact.id} className="flex items-start gap-2 rounded-lg ig-bg-panel px-2.5 py-2">
            <div className="shrink-0 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-300">
              {KIND_LABEL[fact.kind] ?? fact.kind}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] t-body">{fact.content}</div>
              <div className="mt-0.5 text-[9px] t-faint">
                观察 {fact.timesObserved} 次
                {fact.lastVerifiedAt && ` · 验证于 ${new Date(fact.lastVerifiedAt).toLocaleDateString("zh-CN")}`}
              </div>
            </div>
            <div className="shrink-0">
              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-zinc-700">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(fact.confidence * 100)}%`,
                    background: fact.confidence >= 0.7 ? "#3fe0a0" : fact.confidence >= 0.5 ? "#fbbf24" : "#f87171",
                  }}
                />
              </div>
              <div className="mt-0.5 text-right text-[8px] t-faint tabular-nums">
                {Math.round(fact.confidence * 100)}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
