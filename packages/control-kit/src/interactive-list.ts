// 每步感知附带的「窗口索引摘要」（原「可交互元素清单」升级版，同一数据源不再两处轮询 UIA）：
// 由 window-index 存储驱动——每步只做信号判定（前台标题/写动作+画面变化/新窗口/TTL/ref 失效/
// 显式刷新），只在信号到来时重建，绝不每步重扫（资源管理器 323 元素热 1.5s/冷 2.2s 的教训）。
// 行首 #编号即寻址凭据：模型用 ui_click(ref:#N) 按编号点击，执行前 resolveRefs 重解析当前 rect。
import { getHost } from './host';
import { getWindowIndex, type FrameInfo } from './window-index';

/** 采集硬超时：感知每步都做，sidecar 冷启动/卡顿不能拖慢主循环——超时=本步整段省略，
 *  后台构建完成后照常入表，下步命中 */
const COLLECT_TIMEOUT_MS = 1_500;

export interface ListFrame {
  /** 本步前台窗口（感知帧已采，避免重复取；缺省时本函数自取） */
  foreground?: FrameInfo['foreground'];
  /** 本步画面指纹（宿主分块哈希；写动作后判定"画面有变"信号用） */
  signature?: string;
  /** 摘要元素上限（默认 40，与旧清单同口径） */
  limit?: number;
}

/** 采集并生成索引摘要。UIA 降级/无前台窗口/无可视元素 → undefined（整段省略，绝不输出空清单）。 */
export async function buildInteractiveListSection(frame: ListFrame = {}): Promise<string | undefined> {
  const work = (async (): Promise<string | undefined> => {
    const fg: FrameInfo['foreground'] = frame.foreground ?? (await getHost().getForegroundInfo().catch(() => null));
    const store = getWindowIndex();
    await store.observeStep({ foreground: fg, signature: frame.signature });
    return store.formatSummary(frame.limit);
  })();
  const timeout = new Promise<undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), COLLECT_TIMEOUT_MS);
    t.unref?.(); // 单测/退出时不拖住事件循环
  });
  return await Promise.race([work.catch(() => undefined), timeout]);
}
