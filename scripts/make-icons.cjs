// 图标生成工具：logo.jpg → 圆角三件套（tray.png / icon.png / build/icon.ico）
// 用法：`electron scripts/make-icons.cjs`（需要 electron 的 nativeImage 解码/缩放/编码）
// 圆角半径 = 尺寸 × 22%（iOS 风格）；边缘 1px 平滑抗锯齿（圆角矩形 SDF）。
const path = require('node:path');
const fs = require('node:fs');
const { app, nativeImage } = require('electron');

const here = path.dirname(__filename);
const repoRoot = path.resolve(here, '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const logoPath = path.join(repoRoot, 'logo.jpg');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZE = 32;

// 给 BGRA 位图施加圆角透明遮罩（圆角矩形 SDF，1px 软边）
function applyRoundedMask(bgra, w, h, radius) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.min(Math.max(x, radius), w - radius - 1);
      const cy = Math.min(Math.max(y, radius), h - radius - 1);
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 1) continue; // 内部不动
      const i = (y * w + x) * 4 + 3;
      const alpha = Math.max(0, Math.min(1, radius - dist + 0.5)); // 1px 软边
      bgra[i] = Math.round(bgra[i] * alpha);
    }
  }
}

function roundedPng(src, size) {
  const img = src.resize({ width: size, height: size, quality: 'best' });
  const bgra = Buffer.from(img.toBitmap());
  applyRoundedMask(bgra, size, size, Math.round(size * 0.22));
  return nativeImage.createFromBitmap(bgra, { width: size, height: size }).toPNG();
}

// ICO 容器：全 PNG 条目（Vista+ 支持；256 条目为 Windows 规范要求）
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  pngs.forEach((p, i) => {
    const e = i * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e); // 256 写 0
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1);
    entries.writeUInt8(0, e + 2); // 调色板色数
    entries.writeUInt8(0, e + 3); // 保留
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bpp
    entries.writeUInt32LE(p.data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += p.data.length;
    datas.push(p.data);
  });
  return Buffer.concat([header, entries, ...datas]);
}

void app.whenReady().then(() => {
  const src = nativeImage.createFromPath(logoPath);
  if (src.isEmpty() || src.getSize().width < 256) throw new Error(`logo 解析失败: ${logoPath}`);

  fs.mkdirSync(path.join(desktopRoot, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(desktopRoot, 'build'), { recursive: true });

  fs.writeFileSync(path.join(desktopRoot, 'resources', 'tray.png'), roundedPng(src, TRAY_SIZE));
  fs.writeFileSync(path.join(desktopRoot, 'resources', 'icon.png'), roundedPng(src, 256));
  const ico = buildIco(SIZES.map((s) => ({ size: s, data: roundedPng(src, s) })));
  fs.writeFileSync(path.join(desktopRoot, 'build', 'icon.ico'), ico);

  console.log(`icons generated: tray(${TRAY_SIZE}), icon(256), ico(${SIZES.join(',')}) total=${ico.length}B`);
  app.exit(0);
});
