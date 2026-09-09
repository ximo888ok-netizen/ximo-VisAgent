/**
 * WorkspaceSettings.tsx — 工作目录设置子组件（原生目录选择对话框）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import type { AppConfigPayload } from "@shared/island-contracts";

export function WorkspaceSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [dir, setDir] = useState(config.workspaceDir);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDir(config.workspaceDir), [config.workspaceDir]);

  const handlePick = async () => {
    const res = await window.islandAPI.pickWorkspaceDir();
    if (res.ok) setDir(res.data.dir);
  };

  const handleSave = async () => {
    const res = await saveConfig({ workspaceDir: dir });
    if (res.ok) {
      useIslandStore.getState().pushToast("success", "工作目录已保存");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      useIslandStore.getState().pushToast("error", `保存失败: ${res.error ?? '未知错误'}`);
    }
  };

  return (
    <div>
      <label className="island-label">沙箱工作目录</label>
      <p className="mb-2 text-[11px] t-faint leading-relaxed">
        Agent 的文件读写操作仅限此目录（路径逃逸防护）。修改后需重启任务生效。
      </p>
      <div className="flex gap-2">
        <input
          className="island-input flex-1 text-[11px]"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          data-interactive
        />
        <button className="island-btn island-btn--ghost text-[11px]" onClick={handlePick} data-interactive>
          浏览…
        </button>
        <button
          className="island-btn island-btn--primary"
          onClick={handleSave}
          disabled={dir === config.workspaceDir}
          data-interactive
        >
          {saved ? "已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}
