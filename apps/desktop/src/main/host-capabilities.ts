// Electron 宿主能力实现：截屏(desktopCapturer) / 剪贴板 / 前台窗口 / 打开应用
import { desktopCapturer, clipboard, shell, screen } from 'electron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getForegroundWindowInfo } from './foreground';
import { ocrImage } from './ocr';
import type { HostCapabilities, BrowserHostCapabilities } from '@desktop-agi/control-kit';

const execAsync = promisify(exec);

export function createHostCapabilities(browser?: BrowserHostCapabilities): HostCapabilities {
  return {
    async captureScreen(): Promise<Buffer> {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 3840, height: 2160 },
        fetchWindowIcons: false,
      });
      if (sources.length === 0) throw new Error('no screen source');
      // 主屏优先
      const primary = sources.find((s) => s.display_id === String(1));
      const source = primary ?? sources[0];
      if (!source) throw new Error('no screen source');
      const img = source.thumbnail;
      return img.toPNG();
    },

    async readClipboard(): Promise<string> {
      return clipboard.readText();
    },

    async writeClipboard(text: string): Promise<void> {
      clipboard.writeText(text);
    },

    async getForegroundInfo() {
      return getForegroundWindowInfo();
    },

    async openApp(nameOrPath: string): Promise<void> {
      // 先尝试按名字调用（start 规避shell路径解析）；PATH 找不到时回退绝对路径
      try {
        await execAsync(`start "" "${nameOrPath}"`, { shell: 'cmd.exe' });
      } catch {
        shell.openPath(nameOrPath);
      }
    },

    async ocrRegion(): Promise<string> {
      // 整屏识别（区域裁剪后续通过屏幕坐标换算增强）
      const buf = await this.captureScreen();
      return ocrImage(buf);
    },

    browser,
  };
}