/**
 * TaskComposer.tsx — 任务输入区（草稿输入 + 提交 + 推荐条 + 会话/档位工具条）
 *
 * 无内容时由父层居中摆放（hasContent=false），有内容时沉到底部。
 * A-M2：目标应用选择器 + chip——镜像层高亮法，chip 内联于输入框文本流：
 * 选中即把 token `[应用:名称]` 插入光标处，镜像层把 token 渲染为 chip；
 * 删除（含删半）token 即解绑。targetApp 状态仍独立持有（绑定语义）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppEntry, StartTaskRequest, TargetApp } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import { ThinkingModeSelect } from "./ThinkingModeSelect";
import { RecommendBar } from "./RecommendBar";
import { useSopRecommendation } from "./useSopRecommendation";
import { AppChipMirror } from "./AppChipMirror";
import { AppPickerButton } from "./AppPicker/AppPickerButton";
import { AppPickerPanel } from "./AppPicker/AppPickerPanel";
import {
  appTokenOf,
  buildStartPayload,
  hasAppToken,
  insertAppToken,
  isChipReplacement,
  removeAppToken,
  stripAppToken,
  toTargetApp,
} from "./AppPicker/lib";
import { PreAuthDialog } from "./PreAuthDialog";

export function TaskComposer({
  hasContent,
  onError,
}: {
  hasContent: boolean;
  onError: (message: string | null) => void;
}) {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** A-M6：带 chip 的提交先过授权卡（未 ack 关闭 = 任务不启动） */
  const [preAuth, setPreAuth] = useState<{ goal: string; app: TargetApp } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  /** token 插入/替换后待恢复的光标位（受控 value 重渲染完成时消费） */
  const pendingCaret = useRef<number | null>(null);

  const taskRunning = useIslandStore((s) => s.taskRunning);
  const setTaskStarted = useIslandStore((s) => s.setTaskStarted);
  const resetRun = useIslandStore((s) => s.resetRun);
  const clearTask = useIslandStore((s) => s.clearTask);
  const pushToast = useIslandStore((s) => s.pushToast);
  const conversationTurns = useIslandStore((s) => s.conversationTurns);
  const clearConversation = useIslandStore((s) => s.clearConversation);
  const targetApp = useIslandStore((s) => s.targetApp);
  const targetAppInvalid = useIslandStore((s) => s.targetAppInvalid);
  const appPickerOpen = useIslandStore((s) => s.appPickerOpen);
  const setTargetApp = useIslandStore((s) => s.setTargetApp);
  const setTargetAppInvalid = useIslandStore((s) => s.setTargetAppInvalid);
  const setAppPickerOpen = useIslandStore((s) => s.setAppPickerOpen);
  const setRecentApps = useIslandStore((s) => s.setRecentApps);

  /** 剥离绑定 token 后的纯文本（推荐匹配 / 空判定 / 提交目标共用） */
  const plainGoal = stripAppToken(goal, targetApp);

  useSopRecommendation(plainGoal);

  // 无内容时自动聚焦
  useEffect(() => {
    if (hasContent) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, [hasContent]);

  // 全局快速输入聚焦
  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("island:focus-quick-input", onFocus);
    return () => window.removeEventListener("island:focus-quick-input", onFocus);
  }, []);

  // 冷启动空闲预热（规划 §4.1-1）：延后触发 apps:list 建立主进程枚举缓存 +
  // 缓存最近列表（面板打开即用；前台推荐随 A-M3 看门狗通道升级）
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.islandAPI.listApps({});
      void window.islandAPI.listRecentApps().then((res) => {
        if (res.ok) setRecentApps(res.data);
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [setRecentApps]);

  // 选择 → token 插入光标处 + 单实例替换 + toast（规划 §4.1-3：任何时刻至多 1 chip）
  const handlePick = useCallback(
    (entry: AppEntry) => {
      const app = toTargetApp(entry);
      const prev = useIslandStore.getState().targetApp;
      const replaced = isChipReplacement(prev, app);
      const ta = inputRef.current;
      let caret = ta ? ta.selectionStart : goal.length;
      let value = goal;
      if (prev) {
        const removed = removeAppToken(value, appTokenOf(prev), caret);
        value = removed.value;
        caret = removed.caret;
      }
      const inserted = insertAppToken(value, caret, caret, appTokenOf(app));
      pendingCaret.current = inserted.caret;
      setGoal(inserted.value);
      setTargetApp(app);
      setAppPickerOpen(false);
      if (replaced) pushToast("info", "已替换目标应用");
    },
    [goal, setTargetApp, setAppPickerOpen, pushToast],
  );

  // token 插入/替换后恢复光标到 token 之后（受控 value 渲染完成时机）
  useLayoutEffect(() => {
    const ta = inputRef.current;
    const pos = pendingCaret.current;
    if (ta && pos !== null) {
      pendingCaret.current = null;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }
  }, [goal]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setGoal(value);
    // 生命周期同步：value 不再含完整 token（整删/剪删/删半）→ 解绑 + 收掉授权卡前提。
    // 残片处理选实现最轻的「降级为普通文本」：不再二次编辑 value（免光标校正），
    // 残片留在原位可正常编辑删除。
    if (targetApp && !hasAppToken(value, targetApp)) {
      setTargetApp(null);
      setPreAuth(null);
    }
  };

  // 滚动同步：ghost textarea → 镜像层（单行到 2000 字上限内滚动场景少，scrollTop 直拷即可）
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  const startWith = useCallback(async (payload: StartTaskRequest) => {
    setSubmitting(true);
    onError(null);
    try {
      const res = await window.islandAPI.startTask(payload);
      if (res.ok) {
        // P2-14 修复：提交成功后才清空旧对话，失败时保留上一轮结果
        resetRun();
        setTaskStarted(res.data.taskId, res.data.goal, res.data.queuedIndex);
        setGoal("");
        setTargetApp(null); // 发送即绑定：chip 生命周期移交任务卡（规划 §4.1-6）
        if (res.data.queued) {
          pushToast("info", `任务已加入队列（前方 ${res.data.queuedIndex ?? 1} 个），将自动依次执行`);
        } else {
          pushToast("success", "任务已启动");
        }
      } else if (res.targetAppMissing) {
        // 失败占位（规划 §4.1-5）：任务未起跑，chip 标红保留 + 行内错误
        setTargetAppInvalid(true);
        pushToast("error", "目标应用不存在，请重选");
      } else {
        onError(res.error);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }, [setTaskStarted, resetRun, setTargetApp, setTargetAppInvalid, pushToast, onError]);

  const handleSubmit = useCallback(async () => {
    const trimmed = plainGoal.trim();
    if (!trimmed || submitting || taskRunning) return;
    // A-M6 授权卡闸：锚定任务先取得用户逐项确认的作用域包，未 ack 关闭 = 不启动
    if (targetApp) {
      setPreAuth({ goal: trimmed, app: targetApp });
      return;
    }
    await startWith(buildStartPayload(trimmed, null));
  }, [plainGoal, submitting, taskRunning, targetApp, startWith]);

  // 新对话：清空会话上下文与当前展示
  const handleNewConversation = useCallback(async () => {
    await clearConversation();
    clearTask();
    resetRun();
    pushToast("info", "已开启新对话");
  }, [clearConversation, clearTask, resetRun, pushToast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className={hasContent ? "" : "w-full max-w-[460px]"}>
      <RecommendBar />
      {!hasContent && (
        <div className="mb-4 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full ig-bg-panel grid place-items-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L14 8H20L15 12L17 18L12 14L7 18L9 12L4 8H10L12 2Z" stroke="var(--ig-t-muted)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-[15px] t-body font-medium">有什么可以帮你？</p>
          <p className="mt-1 text-[12px] t-faint">输入任务，Agent 将自动执行</p>
        </div>
      )}
      <div className="relative">
        {appPickerOpen && (
          <AppPickerPanel onPick={handlePick} onClose={() => setAppPickerOpen(false)} />
        )}
        {preAuth && (
          <PreAuthDialog
            goal={preAuth.goal}
            app={preAuth.app}
            onAcked={(grantId) => {
              const payload = buildStartPayload(preAuth.goal, preAuth.app);
              setPreAuth(null);
              void startWith({ ...payload, grantId });
            }}
            onCancel={() => setPreAuth(null)}
          />
        )}
        <div className="relative">
          <textarea
            ref={inputRef}
            value={goal}
            onChange={handleChange}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            placeholder="输入任务，例如：打开记事本，输入「你好」并保存到桌面"
            rows={hasContent ? 1 : 2}
            maxLength={2000}
            className="island-input island-input--ghost island-glow resize-none"
            style={{ fontSize: "13px", lineHeight: "1.5", minHeight: hasContent ? 36 : 56 }}
            data-interactive
          />
          <AppChipMirror
            ref={mirrorRef}
            goal={goal}
            app={targetApp}
            invalid={targetAppInvalid}
            fontSize="13px"
            lineHeight="1.5"
          />
        </div>
        {targetAppInvalid && (
          <div className="mt-1 text-[12px] ig-fg-danger">目标应用不存在，请重选</div>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {conversationTurns > 0 ? (
          <div className="flex items-center gap-2" data-interactive>
            <span className="text-[12px] t-faint">已关联 {conversationTurns} 轮对话（可说"把刚才那个再…"）</span>
            <button className="text-[12px] t-muted hover:t-body" onClick={() => void handleNewConversation()} data-interactive>
              新对话
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2" data-interactive>
            <AppPickerButton />
            <ApprovalModeSelect />
            <ThinkingModeSelect />
            <span className="text-[12px] t-faint">Enter 提交 · Shift+Enter 换行</span>
          </div>
        )}
        <button
          className="island-btn island-btn--primary text-[12px]"
          disabled={!goal.trim() || submitting}
          onClick={handleSubmit}
          data-interactive
        >
          {submitting ? "提交中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
