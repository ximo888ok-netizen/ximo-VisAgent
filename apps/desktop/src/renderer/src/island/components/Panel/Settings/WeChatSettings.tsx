/**
 * WeChatSettings.tsx — 微信 Bot 通讯渠道设置子组件（iLink 协议扫码登录版）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import type { AppConfigPayload } from "@shared/island-contracts";

const SCAN_STATUS_TEXT: Record<string, string> = {
  waiting: "等待扫码...",
  scanned: "已扫码，请在手机上确认登录",
  confirmed: "登录确认中...",
  expired: "二维码已过期，请重新扫码",
  error: "发生错误",
};

export function WeChatSettings({ config }: { config: AppConfigPayload }) {
  const wc = config.wechatBot ?? {
    enabled: false,
    allowedWxids: [],
    commandPrefix: "AI:",
    notifyOnFinish: true,
    notifyOnApproval: false,
  };
  const [allowedWxids, setAllowedWxids] = useState(wc.allowedWxids.join(", "));
  const [commandPrefix, setCommandPrefix] = useState(wc.commandPrefix);
  const [notifyOnFinish, setNotifyOnFinish] = useState(wc.notifyOnFinish);
  const [notifyOnApproval, setNotifyOnApproval] = useState(wc.notifyOnApproval);
  const [saving, setSaving] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string>("");

  useEffect(() => {
    const unsubStatus = window.islandAPI.onWeChatStatus((ev) => {
      setConnected(ev.connected);
      if (ev.connected) setQrCode(null);
    });
    const unsubQr = window.islandAPI.onWeChatQr((data) => {
      setQrCode(data.qrCode);
    });
    const unsubScan = window.islandAPI.onWeChatScanStatus((ev) => {
      setScanStatus(ev.status);
    });
    const unsubLogin = window.islandAPI.onWeChatLoginSuccess((ev) => {
      setConnected(true);
      setQrCode(null);
      setScanStatus("");
      useIslandStore.getState().pushToast("success", `微信登录成功: ${ev.user}`);
    });
    const unsubLogout = window.islandAPI.onWeChatLogout(() => {
      setConnected(false);
      setQrCode(null);
    });
    return () => {
      unsubStatus();
      unsubQr();
      unsubScan();
      unsubLogin();
      unsubLogout();
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await window.islandAPI.wechatUpdateConfig({
        enabled: true,
        allowedWxids: allowedWxids.split(",").map((s) => s.trim()).filter(Boolean),
        commandPrefix,
        notifyOnFinish,
        notifyOnApproval,
      });
      if (res.ok) {
        useIslandStore.getState().pushToast("success", "微信 Bot 配置已保存");
      } else {
        useIslandStore.getState().pushToast("error", `保存失败: ${res.error ?? "未知错误"}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleLogin = async () => {
    setLoginLoading(true);
    setQrCode(null);
    setScanStatus("waiting");
    try {
      const res = await window.islandAPI.wechatLogin();
      if (!res.ok) {
        useIslandStore.getState().pushToast("error", `启动失败: ${res.error}`);
        setScanStatus("");
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await window.islandAPI.wechatLogout();
    setConnected(false);
    setQrCode(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="island-label">微信 Bot 通讯渠道</label>
        <p className="mb-2 text-[11px] t-faint leading-relaxed">
          基于微信官方 iLink Bot 协议，扫码登录个人微信。登录后 Agent 可通过微信收发消息，
          收到命令前缀的消息自动触发任务，任务完成/审批请求自动推送到微信。
        </p>
      </div>

      {connected ? (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-3 text-center">
          <div className="text-[13px] text-green-300 font-medium">✅ 微信已登录</div>
          <button
            className="island-btn island-btn--ghost mt-2 text-[11px]"
            onClick={handleLogout}
            data-interactive
          >
            退出登录
          </button>
        </div>
      ) : (
        <div className="rounded-lg ig-bg-panel p-4 text-center">
          {qrCode ? (
            <>
              <img
                src={qrCode}
                alt="微信登录二维码"
                className="mx-auto rounded-lg"
                style={{ width: 200, height: 200 }}
              />
              <p className="mt-2 text-[11px] t-body">
                {SCAN_STATUS_TEXT[scanStatus] ?? "请用微信扫码登录"}
              </p>
            </>
          ) : (
            <>
              <div className="py-6 text-[12px] t-faint">
                {loginLoading ? "正在生成二维码..." : "点击下方按钮扫码登录微信"}
              </div>
              <button
                className="island-btn island-btn--primary"
                onClick={handleLogin}
                disabled={loginLoading}
                data-interactive
              >
                {loginLoading ? "启动中..." : "扫码登录"}
              </button>
            </>
          )}
        </div>
      )}

      <div>
        <label className="island-label">命令前缀</label>
        <input
          className="island-input w-full text-[11px]"
          placeholder="AI:"
          value={commandPrefix}
          onChange={(e) => setCommandPrefix(e.target.value)}
          data-interactive
        />
        <p className="mt-1 text-[10px] t-faint">收到以此前缀开头的消息时自动触发 Agent 任务</p>
      </div>

      <div>
        <label className="island-label">联系人白名单（wxid，逗号分隔）</label>
        <input
          className="island-input w-full text-[11px]"
          placeholder="留空=接受所有人"
          value={allowedWxids}
          onChange={(e) => setAllowedWxids(e.target.value)}
          data-interactive
        />
      </div>

      <div className="space-y-2">
        <label className="island-label">通知选项</label>
        <label className="flex items-center gap-2 text-[11px] t-body" data-interactive>
          <input
            type="checkbox"
            checked={notifyOnFinish}
            onChange={(e) => setNotifyOnFinish(e.target.checked)}
          />
          任务完成时推送结果到微信
        </label>
        <label className="flex items-center gap-2 text-[11px] t-body" data-interactive>
          <input
            type="checkbox"
            checked={notifyOnApproval}
            onChange={(e) => setNotifyOnApproval(e.target.checked)}
          />
          审批请求时推送到微信
        </label>
      </div>

      <button
        className="island-btn island-btn--primary w-full"
        onClick={handleSave}
        disabled={saving}
        data-interactive
      >
        {saving ? "保存中…" : "保存配置"}
      </button>
    </div>
  );
}
