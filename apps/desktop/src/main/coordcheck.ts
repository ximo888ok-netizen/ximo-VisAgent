/**
 * coordcheck.ts — 坐标链路实机诊断（--coordcheck）
 *
 * 对账三方坐标一致性，全程不点鼠标、不调用模型：
 *   A. 真实屏幕：Electron screen API 的物理尺寸 / scaleFactor
 *   B. 截图产物：host-capabilities 走 desktopCapturer 出的 JPEG 实际尺寸 + setScreenScale 结果
 *      （网格帧/净帧各对账一次：网格只改像素不改尺寸）
 *   C. 注入回读：mouseMoveTo 真实链路（generatePath 轨迹 + screen-scale 换算 + SendInput 归一化）
 *      → GetCursorPos 物理像素回读 → 换算回截图系 → 与目标点比对（容差 2px）
 *
 * 退出码 0 = 全部对上；非 0 = 有失配。每项检查输出 JSON 行（与 selftest 同风格）。
 */
import { screen } from 'electron';
import koffi from 'koffi';
import {
  setScreenScale,
  getScreenScale,
  physicalToScreenshot,
  mouseMoveTo,
} from '@ximo-visagent/control-kit';
import { createHostCapabilities } from './host-capabilities';

/** 九点探测：边角（含 1px 内缩）+ 中心 + 四分点 + 中轴点 */
function probePoints(w: number, h: number): { x: number; y: number }[] {
  return [
    { x: 1, y: 1 },
    { x: Math.floor(w / 2), y: Math.floor(h / 2) },
    { x: w - 2, y: h - 2 },
    { x: Math.floor(w / 4), y: Math.floor(h / 4) },
    { x: Math.floor((w * 3) / 4), y: Math.floor((h * 3) / 4) },
    { x: Math.floor(w / 2), y: 1 },
    { x: 1, y: Math.floor(h / 2) },
    { x: w - 2, y: Math.floor(h / 2) },
    { x: Math.floor(w / 2), y: h - 2 },
  ];
}

/** 解析 JPEG SOF 段取尺寸（不引解码库） */
function readJpegSize(buf: Buffer): { width: number; height: number } {
  let off = 2;
  while (off < buf.length - 9) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === undefined) break;
    // SOF0-SOF15（排除 DHT 0xC4 / JPG 0xC8 / DAC 0xCC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    const len = buf.readUInt16BE(off + 2);
    if (len <= 0) break;
    off += 2 + len;
  }
  return { width: 0, height: 0 };
}

/** GetCursorPos 物理像素回读（与 win32.ts 同款 koffi 绑定） */
function getCursorPosPhys(): { x: number; y: number } {
  const lib = koffi.load('user32.dll');
  const GetCursorPos = lib.func('bool GetCursorPos(_Out_ int64* lpPoint)');
  const buf = new ArrayBuffer(8);
  if (!GetCursorPos(buf)) return { x: -1, y: -1 };
  const v = new DataView(buf);
  return { x: v.getInt32(0, true), y: v.getInt32(4, true) };
}

export async function runCoordCheck(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // ---------- A. 真实屏幕 ----------
  const display = screen.getPrimaryDisplay();
  const phys = {
    w: Math.round(display.bounds.width * display.scaleFactor),
    h: Math.round(display.bounds.height * display.scaleFactor),
  };
  push(
    'A1. 屏幕物理尺寸 (bounds×scaleFactor)',
    phys.w > 0 && phys.h > 0,
    `物理 ${phys.w}x${phys.h} = bounds ${display.bounds.width}x${display.bounds.height} × scaleFactor ${display.scaleFactor}`,
  );

  // ---------- B. 截图产物 ----------
  // 重置 scale 再走 captureScreen：验证宿主每帧自设 scale 的闭环
  setScreenScale(1, 1);
  const host = createHostCapabilities(undefined);
  const shot = await host.captureScreen();
  const dims = readJpegSize(shot);
  push(
    'B1. 感知帧尺寸 = 屏幕物理尺寸',
    dims.width === phys.w && dims.height === phys.h,
    `截图 ${dims.width}x${dims.height} vs 物理 ${phys.w}x${phys.h}`,
  );

  const expectedScale = { x: phys.w / Math.max(1, dims.width), y: phys.h / Math.max(1, dims.height) };
  const actualScale = getScreenScale();
  push(
    'B2. captureScreen 后 setScreenScale 生效值',
    Math.abs(actualScale.x - expectedScale.x) < 0.001 && Math.abs(actualScale.y - expectedScale.y) < 0.001,
    `实际 ${actualScale.x.toFixed(3)}/${actualScale.y.toFixed(3)} vs 期望 ${expectedScale.x.toFixed(3)}/${expectedScale.y.toFixed(3)}（截图即原生分辨率时应为 1.000/1.000）`,
  );

  const clean = await host.captureCleanScreen!();
  const cleanDims = readJpegSize(clean);
  push(
    'B3. 网格帧 vs 净帧尺寸一致',
    cleanDims.width === dims.width && cleanDims.height === dims.height,
    `网格帧 ${dims.width}x${dims.height} vs 净帧 ${cleanDims.width}x${cleanDims.height}`,
  );

  // ---------- C. 注入回读（只移动不点击） ----------
  // mouseMoveTo 输入截图系坐标 → 内部 screenshotToPhysical → 65535 归一化 SendInput
  // 回读 GetCursorPos（物理像素）→ physicalToScreenshot → 与目标比对
  const points = probePoints(dims.width, dims.height);
  let passCount = 0;
  const pointLines: string[] = [];
  for (const p of points) {
    await mouseMoveTo(p.x, p.y);
    await new Promise((r) => setTimeout(r, 60)); // 等光标落定
    const physPos = getCursorPosPhys();
    const shotPos = physicalToScreenshot(physPos.x, physPos.y);
    const dx = Math.abs(shotPos.x - p.x);
    const dy = Math.abs(shotPos.y - p.y);
    const ok = dx <= 2 && dy <= 2;
    if (ok) passCount++;
    pointLines.push(`(${p.x},${p.y})→回读(${Math.round(shotPos.x)},${Math.round(shotPos.y)}) 偏差(${dx.toFixed(1)},${dy.toFixed(1)})${ok ? '✅' : '❌'}`);
  }
  push(
    `C1. 截图系坐标注入→物理回读（${passCount}/${points.length} 点 ≤2px）`,
    passCount === points.length,
    pointLines.join(' | '),
  );

  return checks;
}
