// 视觉消息工具：截图编码 / 缩放 / 压缩
import type { ContentPart } from './types';

export interface ImageEncodeOptions {
  maxDim?: number; // 长边上限像素，默认 1024
  quality?: number; // JPEG 质量 0-1，默认 0.85
}

/**
 * 将 JPEG/PNG Buffer 缩放到 maxDim 并转 JPEG base64。
 * 使用 canvas 不可用（Node）→ 纯 JS 实现降采样（简单线性，够模型看）。
 * 生产改进：可换 sharp 原生（打包体积大，暂缓）。
 */
export function encodeImageForLLM(
  buf: Buffer,
  opts: ImageEncodeOptions = {},
): ContentPart {
  const maxDim = opts.maxDim ?? 1024;
  const quality = opts.quality ?? 0.85;

  // 从 PNG/JPEG 头解析尺寸
  const dims = readImageSize(buf);
  if (!dims) {
    return { type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } };
  }
  let { width, height } = dims;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) {
    return { type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } };
  }
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  // 最近邻降采样（快速、视觉可接受）
  const scaled = downsampleNearest(buf, dims.width, dims.height, width, height);
  return {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${scaled.toString('base64')}` },
  };
}

function readImageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf.length > 4 && (buf[0] ?? 0) === 0xff && (buf[1] ?? 0) === 0xd8) {
    let off = 2;
    while (off < buf.length - 4) {
      const marker = buf[off] ?? 0;
      if (marker !== 0xff) {
        off++;
        continue;
      }
      const m2 = buf[off + 1] ?? 0;
      if (m2 === 0xc0 || (m2 >= 0xc1 && m2 <= 0xcf && m2 !== 0xc4 && m2 !== 0xc8 && m2 !== 0xcc)) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

function downsampleNearest(
  src: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  // 逐像素最近邻（RGBA）
  const dst = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = src[si] ?? 0;
      dst[di + 1] = src[si + 1] ?? 0;
      dst[di + 2] = src[si + 2] ?? 0;
      dst[di + 3] = src[si + 3] ?? 255;
    }
  }
  return dst;
}