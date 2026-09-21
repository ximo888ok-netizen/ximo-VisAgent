// 水流光效覆盖层：审批等待时在屏幕四边渲染蓝色渐变 + 缩放动画。
// 设计参考：UI-TARS-desktop ScreenMarker.showScreenWaterFlow()。
// 与 Aura 呼吸光效的分工：Aura 常驻表示 Agent 在场，水流仅在审批等待时触发。
// 关键约束同 screen-marker：不进截图、鼠标穿透、不抢焦点。
import { BrowserWindow, screen } from 'electron';
import { excludeWindowFromCapture } from '../win-effects';

let waterFlowWindow: BrowserWindow | null = null;

/** 显示水流光效（幂等：已显示时不重复创建） */
export function showWaterFlow(): void {
  if (waterFlowWindow) return;

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;

  waterFlowWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
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

  waterFlowWindow.setAlwaysOnTop(true, 'screen-saver');
  waterFlowWindow.setFocusable(false);
  waterFlowWindow.setContentProtection(true);
  excludeWindowFromCapture(waterFlowWindow.getNativeWindowHandle());
  waterFlowWindow.setIgnoreMouseEvents(true, { forward: true });

  waterFlowWindow.loadURL(`data:text/html;charset=UTF-8,
    <html>
      <head>
        <style>
          html::before {
            content: "";
            position: fixed;
            top: 0; right: 0; bottom: 0; left: 0;
            pointer-events: none;
            z-index: 9999;
            background:
              linear-gradient(to right, rgba(30, 144, 255, 0.35), transparent 50%) left,
              linear-gradient(to left, rgba(30, 144, 255, 0.35), transparent 50%) right,
              linear-gradient(to bottom, rgba(30, 144, 255, 0.35), transparent 50%) top,
              linear-gradient(to top, rgba(30, 144, 255, 0.35), transparent 50%) bottom;
            background-repeat: no-repeat;
            background-size: 8% 100%, 8% 100%, 100% 8%, 100% 8%;
            animation: waterflow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            filter: blur(6px);
          }
          @keyframes waterflow {
            0%, 100% { transform: scale(1); opacity: 0.7; }
            50% { transform: scale(1.04); opacity: 1; }
          }
        </style>
      </head>
      <body></body>
    </html>
  `);
}

/** 关闭水流光效 */
export function hideWaterFlow(): void {
  if (!waterFlowWindow) return;
  const win = waterFlowWindow;
  waterFlowWindow = null;
  try {
    if (!win.isDestroyed()) win.close();
  } catch { /* 窗口已销毁 */ }
}
