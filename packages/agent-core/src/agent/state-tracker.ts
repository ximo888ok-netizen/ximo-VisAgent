// 关键状态追踪：在循环中自动记录结构化关键状态（窗口切换/文件打开/复制操作等），
// 注入感知文本让模型不丢线索。与 ContextManager（步骤摘要）互补：
// ContextManager 记"刚做了什么"，StateTracker 记"当前在哪个状态"。
//
// 设计原则：
// - 只在关键动作成功后记录（失败的动作不改变状态）
// - 容量封顶：最多保留最近 N 条关键状态，超出 FIFO 淘汰
// - 注入到 buildPerceptionText 的一行式摘要（不增加消息条数）

/** 关键状态条目 */
export interface StateEntry {
  /** 状态类型 */
  kind: 'window' | 'file' | 'clipboard' | 'app' | 'note';
  /** 状态内容（一句话，如 "窗口切换到 记事本"、"打开文件 D:\\test.txt"、"剪贴板: 50字"） */
  text: string;
  /** 记录时间（ms） */
  ts: number;
}

const MAX_ENTRIES = 8;

/** 关键动作 → 状态提取规则 */
function extractState(
  actionName: string,
  args: Record<string, unknown>,
  resultSummary: string,
): StateEntry | null {
  // 只在成功时记录（resultSummary 不含"失败"字样时）
  if (resultSummary.includes('失败') || resultSummary.includes('错误')) return null;

  switch (actionName) {
    case 'open_app': {
      const name = String(args.nameOrPath ?? '');
      if (!name) return null;
      return { kind: 'app', text: `已打开: ${name}`, ts: Date.now() };
    }
    case 'activate_window': {
      const title = String(args.title ?? '');
      if (!title) return null;
      return { kind: 'window', text: `已激活窗口: ${title}`, ts: Date.now() };
    }
    case 'file_read': {
      const p = String(args.path ?? '');
      return { kind: 'file', text: `已读文件: ${p}`, ts: Date.now() };
    }
    case 'file_write': {
      const p = String(args.path ?? '');
      return { kind: 'file', text: `已写文件: ${p}`, ts: Date.now() };
    }
    case 'get_clipboard': {
      // 从 resultSummary 提取剪贴板内容摘要
      const preview = resultSummary.slice(0, 40);
      return { kind: 'clipboard', text: `剪贴板: ${preview}`, ts: Date.now() };
    }
    case 'set_clipboard': {
      const text = String(args.text ?? '');
      const preview = text.length > 30 ? `${text.slice(0, 30)}...` : text;
      return { kind: 'clipboard', text: `已复制: "${preview}" (${text.length}字)`, ts: Date.now() };
    }
    case 'keyboard_type': {
      const text = String(args.text ?? '');
      if (text.length > 10) {
        const preview = text.slice(0, 20);
        return { kind: 'note', text: `输入了: "${preview}..."`, ts: Date.now() };
      }
      return null;
    }
    case 'keyboard_press': {
      const combo = String(args.combo ?? '');
      const lower = combo.toLowerCase();
      // 重要快捷键记录（Ctrl/Alt/Win 组合），单键不记
      if (lower.includes('ctrl') || lower.includes('alt') || lower.includes('win') || lower.includes('f1') || lower.includes('f2') || lower.includes('f5')) {
        return { kind: 'note', text: `按键: ${combo}`, ts: Date.now() };
      }
      return null;
    }
    case 'mouse_click': {
      // 右键点击可能打开上下文菜单，值得记录
      const button = String(args.button ?? 'left');
      if (button === 'right') {
        return { kind: 'note', text: `右键点击了`, ts: Date.now() };
      }
      return null;
    }
    case 'mouse_scroll': {
      const delta = Number(args.delta ?? 0);
      if (Math.abs(delta) >= 3) {
        return { kind: 'note', text: `滚动了${delta > 0 ? '向上' : '向下'}${Math.abs(delta)}格`, ts: Date.now() };
      }
      return null;
    }
    default:
      return null;
  }
}

/** 关键状态追踪器：在 loop 每步执行后检查动作，自动记录结构化状态 */
export class StateTracker {
  private entries: StateEntry[] = [];

  /** 每步执行后调用：从动作和结果中提取关键状态 */
  track(actionName: string, args: Record<string, unknown>, resultSummary: string): void {
    const entry = extractState(actionName, args, resultSummary);
    if (!entry) return;
    // 同类状态只保留最新一条（如最新的"已打开"、最新的"剪贴板"）
    this.entries = this.entries.filter((e) => e.kind !== entry.kind);
    this.entries.push(entry);
    // FIFO 淘汰
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  /** 获取注入感知文本的状态行（一行式，越短越好） */
  snapshotLines(): string[] {
    if (this.entries.length === 0) return [];
    // 按时间倒序（最新的在前）
    return [...this.entries].reverse().map((e) => e.text);
  }

  /** 重置（新任务开始时） */
  reset(): void {
    this.entries = [];
  }
}
