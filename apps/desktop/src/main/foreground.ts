// 前台窗口信息（通过 control-kit win32 getForegroundWindow + Electron screen 取 DPI）
import { getForegroundWindow } from '@desktop-agi/control-kit';
import { screen } from 'electron';

export async function getForegroundWindowInfo(): Promise<{ title: string; className: string }> {
  try {
    const win = await getForegroundWindow();
    return { title: win.title, className: '' };
  } catch {
    return { title: '', className: '' };
  }
}

export function getMonitorsPhysical(): Array<{
  index: number;
  rect: { left: number; top: number; width: number; height: number };
  scale: number;
  isPrimary: boolean;
}> {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => {
    const bounds = d.bounds;
    return {
      index: i,
      rect: { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height },
      scale: d.scaleFactor,
      isPrimary: d.id === primary.id,
    };
  });
}