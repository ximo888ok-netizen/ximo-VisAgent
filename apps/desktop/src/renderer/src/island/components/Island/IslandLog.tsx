/**
 * IslandLog.tsx — 中庭单行 ReAct 日志（跑马灯 + 悬停暂停）
 * 行数预算 <150 行。
 *
 * 实现要点：
 * - 用 requestAnimationFrame 读取 scrollWidth，超过可视宽度才开启无缝滚动；
 * - 悬停（hover）时暂停（组件状态驱动 CSS animation-play-state）；
 * - 文本通过 data-interactive 命中（点击唤起主窗口，逻辑在 IslandShell）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useIslandStore } from "../../store/islandStore";

const FALLBACK_TEXT = "Agent 已就绪，等待新任务…";

export function IslandLog({ width }: { width: number }) {
  const currentLog = useIslandStore((s) => s.currentLog);
  const text = currentLog?.text ?? FALLBACK_TEXT;

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [paused, setPaused] = useState(false);

  // 内容或可视宽度变化时，评估是否需要滚动
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const track = trackRef.current;
    if (!vp || !track) return;
    const measure = () => setOverflows(track.scrollWidth > vp.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(track);
    return () => ro.disconnect();
  }, [text]);

  // 跑马灯时长随文本长度线性放大，避免过快/过慢
  const duration = useRef(14);
  useEffect(() => {
    duration.current = Math.min(26, Math.max(9, Math.ceil(text.length / 8)));
  }, [text]);

  const style = {
    "--marquee-duration": `${duration.current}s`,
  } as CSSProperties;

  return (
    <div
      ref={viewportRef}
      style={{ width }}
      className={`island-marquee island-no-select flex h-full items-center ${
        paused ? "island-marquee--paused" : ""
      }`}
      data-interactive
      data-action="focus-main"
      title="点击唤起主窗口"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {overflows ? (
        // 无缝滚动：内容复制两遍，利用 -50% 位移循环
        <div ref={trackRef} className="island-marquee__track" style={style}>
          <span className="pr-8 text-[12.5px] text-[#e2e6ee]">{text}</span>
          <span aria-hidden className="pr-8 text-[12.5px] text-[#e2e6ee]">
            {text}
          </span>
        </div>
      ) : (
        <span ref={trackRef} className="truncate text-[12.5px] text-[#e2e6ee]">
          {text}
        </span>
      )}
    </div>
  );
}