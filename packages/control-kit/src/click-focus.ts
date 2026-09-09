// 点击落点保证：让点击真正作用到模型"在截图里看到的那个窗口"
//
// 两件事：
//   1) 目标点所属窗口不在前台 → 先激活（否则点击被前台窗口接收，模型却以为点过了）
//   2) 目标点被本应用自己的窗口（灵动岛/边框，且不进截图）遮挡 → 临时穿透后点击，再恢复
//      —— 截图里没有自家窗口，所以模型点这里时意图必然是"点它下面的东西"
import { getHost } from './host';
import { mouseClick, screenshotToPhysical, type MouseButton } from './win32';
import { activateWindow, getForegroundWindow, windowAtPoint } from './win32-window';

/** 穿透生效等待：setIgnoreMouseEvents 经 IPC 到窗口线程，给一拍再点 */
const PASSTHROUGH_SETTLE_MS = 40;
/** 桌面/任务栏类窗口：不作为"可激活目标"（抢前台会把桌面提到最上层） */
const SHELL_WINDOW_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

export interface ClickFocus {
  /** 追加到工具 summary 的说明（空字符串 = 无需处理） */
  note: string;
  /** 目标点被本应用自己的窗口遮挡（调用方应临时穿透后再点） */
  selfOccluded: boolean;
}

/** 点击前确保坐标所属窗口在前台，并识别自家窗口遮挡 */
export async function ensureTargetForeground(x: number, y: number): Promise<ClickFocus> {
  try {
    const phys = screenshotToPhysical(x, y);
    const at = windowAtPoint(phys.x, phys.y);
    if (!at) return { note: '', selfOccluded: false };
    if (SHELL_WINDOW_CLASSES.has(at.className)) return { note: '', selfOccluded: false };
    if (at.pid === process.pid) {
      return {
        note: `；该坐标落在本应用自己的窗口「${at.title || at.className}」上（该窗口不进截图）——已临时穿透点击下层目标`,
        selfOccluded: true,
      };
    }
    const fg = await getForegroundWindow();
    if (fg.hwnd === at.hwnd) return { note: '', selfOccluded: false };
    if (activateWindow(at.hwnd)) return { note: `；已先激活目标窗口「${at.title}」`, selfOccluded: false };
    return {
      note: `；目标点属于窗口「${at.title}」，但激活失败（当前前台「${fg.title}」）——点击可能被其他窗口接收`,
      selfOccluded: false,
    };
  } catch {
    return { note: '', selfOccluded: false };
  }
}

/** 执行点击：被自家窗口遮挡时临时让自家窗口鼠标穿透，点完恢复 */
export async function clickWithSelfPassthrough(
  x: number, y: number, button: MouseButton, times: number, selfOccluded: boolean,
): Promise<void> {
  if (!selfOccluded) {
    await mouseClick(x, y, button, times);
    return;
  }
  const host = getHost();
  await host.setSelfWindowsPassthrough?.(true);
  await sleep(PASSTHROUGH_SETTLE_MS);
  try {
    await mouseClick(x, y, button, times);
  } finally {
    // 必须恢复：否则岛永久失去点击能力（用户点不动）
    await host.setSelfWindowsPassthrough?.(false);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
