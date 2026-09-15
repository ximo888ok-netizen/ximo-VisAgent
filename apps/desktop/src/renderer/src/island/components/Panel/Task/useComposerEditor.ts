/**
 * useComposerEditor.ts — contenteditable 输入区行为层（IME 安全事件路由 / chip 原子操作 / 上限）
 *
 * IME 铁律：compositionstart→end 期间绝不重写 DOM、不跑归一化，input 事件也只纯读
 * 镜像（供推荐/空态判定）；一切 DOM 改写（粘贴注入、chip 插删、提交复位）只发生在
 * composition 之外。粘贴走 paste 拦截取 text/plain 手动建文本节点，禁止 HTML 入 DOM。
 * 生命周期同步：chip 被一次退格整体删除 → 序列化 app 为空 → onAppRemoved 解绑收授权卡。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import type { TargetApp } from "@shared/island-contracts";
import { useIslandStore } from "../../../store/islandStore";
import {
  CHIP_ATTR,
  CHIP_REMOVE_ATTR,
  clampGoal,
  pasteBudget,
  cleanPastedText,
} from "./composer-lib";
import type { ComposerSnapshot } from "./composer-lib";
import {
  caretToEnd,
  clearEditor,
  editorSelectionRange,
  insertChipAtSelection,
  insertPlainTextAtSelection,
  readEditor,
  setChipInvalid,
} from "./composer-dom";

export interface ComposerHandlers {
  onInput(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void;
  onBeforeInput(e: FormEvent<HTMLDivElement>): void;
  onPaste(e: ReactClipboardEvent<HTMLDivElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onBlur(): void;
  onClick(e: ReactMouseEvent<HTMLDivElement>): void;
}

export interface ComposerEditor {
  editorRef: RefObject<HTMLDivElement | null>;
  /** 序列化后的纯文本（不含 chip）：驱动推荐匹配 / 空态 / placeholder */
  text: string;
  empty: boolean;
  handlers: ComposerHandlers;
  /** 选择应用 → 光标处插入 chip（已有则替换，单实例） */
  insertChip(app: TargetApp): void;
  /** 提交成功 → 清空输入区（chip 生命周期移交任务卡） */
  clearEditor(): void;
  /** 提交时读取 { goal, app }（goal 已按 2000 上限收口，不含 chip 文本） */
  serialize(): ComposerSnapshot;
}

export function useComposerEditor(opts: {
  hasContent: boolean;
  onSubmit(): void;
  onAppRemoved(): void;
}): ComposerEditor {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  /** picker 弹层抢焦点前的光标位（chip 插入锚点） */
  const savedRangeRef = useRef<Range | null>(null);
  const optsRef = useRef(opts);
  const [snapshot, setSnapshot] = useState<ComposerSnapshot>({ goal: "", app: null });

  useEffect(() => {
    optsRef.current = opts;
  });

  const targetApp = useIslandStore((s) => s.targetApp);
  const targetAppInvalid = useIslandStore((s) => s.targetAppInvalid);

  /** 纯读镜像：序列化 DOM → 状态；chip 消失 = 解绑信号（序列化核保证 goal 不含 chip） */
  const syncFromDom = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const snap = readEditor(root);
    setSnapshot(snap);
    if (snap.app === null && useIslandStore.getState().targetApp !== null) {
      optsRef.current.onAppRemoved();
    }
  }, []);

  const focusEditor = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    caretToEnd(root);
  }, []);

  // 无内容时自动聚焦 + 全局快速输入聚焦
  useEffect(() => {
    if (opts.hasContent) return;
    const timer = setTimeout(focusEditor, 300);
    return () => clearTimeout(timer);
  }, [opts.hasContent, focusEditor]);

  useEffect(() => {
    window.addEventListener("island:focus-quick-input", focusEditor);
    return () => window.removeEventListener("island:focus-quick-input", focusEditor);
  }, [focusEditor]);

  // 失效态（主进程 existsSync 预检失败）：chip 危险色描边，逻辑同现状
  useEffect(() => {
    const root = editorRef.current;
    if (root) setChipInvalid(root, targetAppInvalid);
  }, [targetApp, targetAppInvalid]);

  const handlers: ComposerHandlers = {
    onInput: () => {
      if (!composingRef.current) syncFromDom();
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      syncFromDom();
    },
    onKeyDown: (e) => {
      // IME 确认用的 Enter 不提交（isComposing 双保险，中文输入不能坏）
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        optsRef.current.onSubmit();
      }
    },
    onBeforeInput: (e) => {
      const ie = e.nativeEvent;
      if (!(ie instanceof InputEvent) || !ie.inputType.startsWith("insert")) return;
      // composition / 程序化粘贴各有自己的通道，此处只拦手打的非插入超限
      if (ie.inputType === "insertCompositionText" || ie.inputType === "insertFromPaste") return;
      const root = editorRef.current;
      if (!root) return;
      const budget = pasteBudget(readEditor(root).goal.length);
      if ((ie.data?.length ?? 1) > budget) e.preventDefault();
    },
    onPaste: (e) => {
      e.preventDefault(); // 只认 text/plain，禁止任何 HTML 进入 DOM
      const root = editorRef.current;
      if (!root) return;
      const raw = e.clipboardData?.getData("text/plain") ?? "";
      const cleaned = cleanPastedText(raw, pasteBudget(readEditor(root).goal.length));
      if (!cleaned) return;
      insertPlainTextAtSelection(root, cleaned);
      syncFromDom();
    },
    onBlur: () => {
      const root = editorRef.current;
      if (!root) return;
      const range = editorSelectionRange(root);
      if (range) savedRangeRef.current = range;
    },
    onClick: (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(`[${CHIP_REMOVE_ATTR}]`)) return;
      e.preventDefault();
      const chip = target.closest(`[${CHIP_ATTR}]`);
      if (chip instanceof HTMLElement) chip.remove(); // 一次删整枚，绝不留半个
      syncFromDom();
    },
  };

  const insertChip = useCallback((app: TargetApp) => {
    const root = editorRef.current;
    if (!root) return;
    insertChipAtSelection(root, savedRangeRef.current, app);
    savedRangeRef.current = null;
    syncFromDom();
  }, [syncFromDom]);

  const clearEditorAll = useCallback(() => {
    const root = editorRef.current;
    if (root) clearEditor(root);
    savedRangeRef.current = null;
    setSnapshot({ goal: "", app: null });
  }, []);

  const serialize = useCallback((): ComposerSnapshot => {
    const root = editorRef.current;
    if (!root) return { goal: "", app: null };
    const snap = readEditor(root);
    return { goal: clampGoal(snap.goal), app: snap.app };
  }, []);

  return {
    editorRef,
    text: snapshot.goal,
    empty: snapshot.goal.length === 0 && snapshot.app === null,
    handlers,
    insertChip,
    clearEditor: clearEditorAll,
    serialize,
  };
}
