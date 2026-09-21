/**
 * screen-marker.ts — 预测标记覆盖层（L2 审批时在屏幕上可视化 Agent 要点的位置）
 *
 * 设计参考：UI-TARS-desktop ScreenMarker.ts，适配 ximo 物理像素坐标系。
 * 关键约束：
 *   - transparent + frame:false + alwaysOnTop('screen-saver') + 鼠标穿透 + 不抢焦点
 *   - setContentProtection(true) = WDA_EXCLUDEFROMCAPTURE，不进 Agent 截图
 *   - 审批结束时立即关闭
 *
 * 与 TARS 的差异：
 *   - 归一化模式（AGENT_COORD_MODE=normalized）下自动把 0-1000 坐标换算为截图像素
 *   - 仅 L2+ 审批时触发（TARS 每步都显示）；L1 自动执行不需要覆盖层
 *   - 动作类型用 ximo 工具名（mouse_click / key_type / hotkey / drag / scroll）
 */
import { BrowserWindow, screen } from 'electron';
import { excludeWindowFromCapture } from '../win-effects';
import { isNormalized, normalizedToPixel, getLastImageSize } from '@ximo-visagent/control-kit';

/** 标记自动关闭兜底时长（审批回调失败/超时时确保不残留） */
const MARKER_AUTO_CLOSE_MS = 30_000;

let currentOverlay: BrowserWindow | null = null;
let autoCloseTimer: NodeJS.Timeout | null = null;

/** 从工具调用参数中提取预测坐标 */
export interface PredictedCoords {
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
}

/**
 * 在屏幕上显示预测标记。
 * - mouse_click / mouse_double_click / mouse_right_click：在 (x,y) 画旋转圆圈
 * - drag：在 (x,y)→(toX,toY) 画箭头
 * - key_type / hotkey：在上次点击位置附近画文字标签
 * - 其他：不画标记（无坐标信息）
 */
export function showPredictionMarker(
  tool: string,
  args: Record<string, unknown>,
  coords?: PredictedCoords,
): void {
  closePredictionMarker();

  const primary = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primary.size;

  const svg = buildMarkerSvg(tool, args, coords);
  if (!svg) return; // 无坐标的动作不画标记

  const boxWidth = 300;
  const boxHeight = 120;

  // 坐标转逻辑像素（screen.size 是逻辑尺寸，工具坐标是物理像素）
  const scaleFactor = primary.scaleFactor || 1;
  const lx = coords?.x !== undefined ? coords.x / scaleFactor : screenWidth / 2;
  const ly = coords?.y !== undefined ? coords.y / scaleFactor : screenHeight / 2;

  currentOverlay = new BrowserWindow({
    width: boxWidth,
    height: boxHeight,
    x: Math.round(lx - boxWidth / 2),
    y: Math.round(ly - boxHeight / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    paintWhenInitiallyHidden: true,
    type: 'panel',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  currentOverlay.setAlwaysOnTop(true, 'screen-saver');
  currentOverlay.setFocusable(false);
  // 不进截图：否则模型下一轮看到自己的标记导致幻觉
  excludeWindowFromCapture(currentOverlay.getNativeWindowHandle());
  currentOverlay.setIgnoreMouseEvents(true, { forward: true });

  currentOverlay.loadURL(`data:text/html;charset=UTF-8,
    <html>
      <body style="background: transparent; margin: 0; overflow: hidden;">
        ${svg}
      </body>
    </html>
  `);

  // 兜底自动关闭（审批超时/回调异常时确保不残留）
  autoCloseTimer = setTimeout(() => closePredictionMarker(), MARKER_AUTO_CLOSE_MS);
}

/** 关闭预测标记覆盖层 */
export function closePredictionMarker(): void {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  if (currentOverlay) {
    const overlay = currentOverlay;
    currentOverlay = null;
    try {
      if (!overlay.isDestroyed()) overlay.close();
    } catch { /* 窗口已销毁 */ }
  }
}

/** 从工具参数中提取坐标（归一化模式下自动换算为截图像素） */
export function extractCoords(tool: string, args: Record<string, unknown>): PredictedCoords | undefined {
  const x = args.x ?? args.cx;
  const y = args.y ?? args.cy;
  const toX = args.toX ?? args.tx ?? args.endX;
  const toY = args.toY ?? args.ty ?? args.endY;
  if (typeof x === 'number' && typeof y === 'number') {
    if (isNormalized()) {
      const { w, h } = getLastImageSize();
      if (w > 0 && h > 0) {
        const px = normalizedToPixel(x, w);
        const py = normalizedToPixel(y, h);
        const pToX = typeof toX === 'number' ? normalizedToPixel(toX, w) : undefined;
        const pToY = typeof toY === 'number' ? normalizedToPixel(toY, h) : undefined;
        return { x: px, y: py, toX: pToX, toY: pToY };
      }
    }
    return { x: x as number, y: y as number, toX: typeof toX === 'number' ? toX : undefined, toY: typeof toY === 'number' ? toY : undefined };
  }
  return undefined;
}

/** 构建标记 SVG（按动作类型生成不同可视化） */
function buildMarkerSvg(
  tool: string,
  args: Record<string, unknown>,
  coords?: PredictedCoords,
): string | null {
  if (!coords?.x || !coords?.y) {
    // 无坐标但有文本的动作（key_type / hotkey）：画纯文字标签
    if (tool === 'key_type' || tool === 'type_text') {
      const text = String(args.text ?? args.content ?? '').slice(0, 30);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60" viewBox="0 0 300 60">
        <rect x="0" y="0" width="300" height="60" rx="8" fill="rgba(0,0,0,0.75)"/>
        <text x="150" y="36" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif"
              font-size="14" fill="#FFD60A" text-anchor="middle" dominant-baseline="middle">
          ⌨ 输入: "${escapeXml(text)}"
        </text>
      </svg>`;
    }
    if (tool === 'hotkey' || tool === 'key_combo') {
      const key = String(args.key ?? args.keys ?? '').slice(0, 40);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="60" viewBox="0 0 250 60">
        <rect x="0" y="0" width="250" height="60" rx="8" fill="rgba(0,0,0,0.75)"/>
        <text x="125" y="36" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif"
              font-size="14" fill="#FFD60A" text-anchor="middle" dominant-baseline="middle">
          ⌘ 快捷键: ${escapeXml(key)}
        </text>
      </svg>`;
    }
    return null; // 无坐标无文本的动作不画标记
  }

  const cx = 150; // SVG 中心
  const cy = 60;
  const label = toolLabel(tool);

  // 拖拽：画箭头
  if (tool === 'drag' || tool === 'mouse_drag') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120">
      <circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#FF3B30" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="3" fill="#FF3B30"/>
      <text x="${cx + 70}" y="${cy + 5}" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif"
            font-size="13" fill="#FF3B30" text-anchor="middle" dominant-baseline="middle">
        ${escapeXml(label)} →
      </text>
    </svg>`;
  }

  // 点击类：旋转圆圈 + 动作文字
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120">
    <circle cx="${cx}" cy="${cy}" r="16" fill="none" stroke="#FF3B30" stroke-width="3"
            stroke-dasharray="80 20" stroke-linecap="round">
      <animateTransform attributeName="transform" type="rotate"
        from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="1s" repeatCount="indefinite"/>
    </circle>
    <circle cx="${cx}" cy="${cy}" r="3" fill="#FF3B30"/>
    <text x="${cx + 65}" y="${cy + 5}" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif"
          font-size="14" fill="#FF3B30" text-anchor="middle" dominant-baseline="middle">
      ${escapeXml(label)}
    </text>
  </svg>`;
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    mouse_click: '点击',
    mouse_double_click: '双击',
    mouse_right_click: '右键',
    drag: '拖拽',
    mouse_drag: '拖拽',
    scroll: '滚轮',
    key_type: '输入',
    type_text: '输入',
    hotkey: '快捷键',
    key_combo: '快捷键',
  };
  return labels[tool] ?? tool;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
