/**
 * TaskComposer.tsx — 任务输入区（草稿输入 + 提交 + 推荐条 + 会话/档位工具条）
 *
 * 无内容时由父层居中摆放（hasContent=false），有内容时沉到底部。
 * 输入区为 contenteditable 富文本（behavior 层在 useComposerEditor，序列化/清洗核在 composer-lib）：
 * 应用 chip 是文本流中的真实原子行内节点（contenteditable=false），不再是镜像覆盖层——
 * 光标处插入、一次退格整体删除、删除即解绑；goal 序列化时 chip 贡献 0 字符，
 * 发给主进程的 payload 与旧 token 方案逐字段一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppEntry, StartTaskRequest, TargetApp } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import { ThinkingModeSelect } from "./ThinkingModeSelect";
import { RecommendBar } from "./RecommendBar";
import { useSopRecommendation } from "./useSopRecommendation";
import { useComposerEditor } from "./useComposerEditor";
import { AppPickerButton } from "./AppPicker/AppPickerButton";
import { AppPickerPanel } from "./AppPicker/AppPickerPanel";
import { buildStartPayload, isChipReplacement, toTargetApp } from "./AppPicker/lib";
import { PreAuthDialog } from "./PreAuthDialog";

const COMPOSER_PLACEHOLDER = "输入任务，例如：打开记事本，输入「你好」并保存到桌面";

export function TaskComposer({
  hasContent,
  onError,
}: {
  hasContent: boolean;
  onError: (message: string | null) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  /** A-M6：带 chip 的提交先过授权卡（未 ack 关闭 = 任务不启动） */
  const [preAuth, setPreAuth] = useState<{ goal: string; app: TargetApp } | null>(null);
  /** 同帧双 Enter 去抖：状态提交前先行置位（行为同现状，只加固串发防护） */
  const submittingRef = useRef(false);

  const taskRunning = useIslandStore((s) => s.taskRunning);
  const setTaskStarted = useIslandStore((s) => s.setTaskStarted);
  const resetRun = useIslandStore((s) => s.resetRun);
  const clearTask = useIslandStore((s) => s.clearTask);
  const pushToast = useIslandStore((s) => s.pushToast);
  const conversationTurns = useIslandStore((s) => s.conversationTurns);
  const clearConversation = useIslandStore((s) => s.clearConversation);
  const targetAppInvalid = useIslandStore((s) => s.targetAppInvalid);
  const appPickerOpen = useIslandStore((s) => s.appPickerOpen);
  const setTargetApp = useIslandStore((s) => s.setTargetApp);
  const setTargetAppInvalid = useIslandStore((s) => s.setTargetAppInvalid);
  const setAppPickerOpen = useIslandStore((s) => s.setAppPickerOpen);
  const setRecentApps = useIslandStore((s) => s.setRecentApps);

  const editor = useComposerEditor({
    hasContent,
    onSubmit: () => {
      void handleSubmit();
    },
    // chip 被删除（退格/×）→ 解绑 + 收起授权卡前提
    onAppRemoved: () => {
      setTargetApp(null);
      setPreAuth(null);
    },
  });

  // 序列化后的纯文本（不含 chip）：推荐匹配与 placeholder 空态共用
  const { text: plainGoal } = editor;
  useSopRecommendation(plainGoal);

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

  // 选择 → 光标处插入 chip + 单实例替换 + toast（任何时刻至多 1 chip）
  const handlePick = useCallback(
    (entry: AppEntry) => {
      const app = toTargetApp(entry);
      const replaced = isChipReplacement(useIslandStore.getState().targetApp, app);
      editor.insertChip(app);
      setTargetApp(app);
      setAppPickerOpen(false);
      if (replaced) pushToast("info", "已替换目标应用");
    },
    [editor, setTargetApp, setAppPickerOpen, pushToast],
  );

  const startWith = useCallback(async (payload: StartTaskRequest) => {
    setSubmitting(true);
    submittingRef.current = true;
    onError(null);
    try {
      const res = await window.islandAPI.startTask(payload);
      if (res.ok) {
        // P2-14 修复：提交成功后才清空旧对话/输入区，失败时保留上一轮结果与草稿
        resetRun();
        setTaskStarted(res.data.taskId, res.data.goal, res.data.queuedIndex);
        editor.clearEditor();
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
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [setTaskStarted, resetRun, setTargetApp, setTargetAppInvalid, pushToast, onError, editor]);

  async function handleSubmit(): Promise<void> {
    const { goal, app } = editor.serialize();
    const trimmed = goal.trim();
    if (!trimmed || submittingRef.current || taskRunning) return;
    // A-M6 授权卡闸：锚定任务先取得用户逐项确认的作用域包，未 ack 关闭 = 不启动
    if (app) {
      setPreAuth({ goal: trimmed, app });
      return;
    }
    await startWith(buildStartPayload(trimmed, null));
  }

  // 新对话：清空会话上下文与当前展示
  const handleNewConversation = useCallback(async () => {
    await clearConversation();
    clearTask();
    resetRun();
    pushToast("info", "已开启新对话");
  }, [clearConversation, clearTask, resetRun, pushToast]);

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
        <div
          ref={editor.editorRef}
          className={`island-input island-glow island-composer${hasContent ? " island-composer--tight" : ""}`}
          contentEditable="plaintext-only"
          role="textbox"
          aria-multiline="true"
          aria-label="任务输入"
          data-placeholder={COMPOSER_PLACEHOLDER}
          data-empty={editor.empty ? "true" : "false"}
          data-interactive
          {...editor.handlers}
        />
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
          disabled={editor.empty || submitting}
          onClick={() => {
            void handleSubmit();
          }}
          data-interactive
        >
          {submitting ? "提交中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
