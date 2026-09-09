// 视觉消息工具：截图编码 / MIME 检测 / 供应商 detail 档位适配
// LIB-01 修复：删除错误的降采样逻辑（把压缩字节流当 RGBA 处理），
// 改为透传原图 + 正确 MIME 检测。降采样应由调用方在截图时完成（如 desktopCapturer toJPEG）。
import type { ContentPart } from './types';

/**
 * 按供应商适配 image_url.detail 档位：
 * - DeepSeek：'original'（私有档位，保留原图不降采样——grounding 精度关键）
 * - 其余（Qwen/GLM/Kimi/自定义）：'high'（OpenAI 标准高档位）。
 *   'original' 是 DeepSeek 私有值，发给其他兼容网关可能被拒（400）或忽略，
 *   统一回退标准 'high' 保证截图理解不降级。
 */
export function imageDetailFor(provider: string): 'high' | 'original' {
  return provider === 'deepseek' ? 'original' : 'high';
}

export interface ImageEncodeOptions {
  maxDim?: number; // 保留接口兼容，但不再使用（降采样已移除）
  quality?: number; // 保留接口兼容
}

/**
 * 将图像 Buffer 编码为 LLM 可用的 ContentPart。
 * LIB-01 修复：直接透传原图 base64，不做降采样（降采样需要解码器，
 * 纯 JS 实现会把压缩字节流当 RGBA 处理，输出全黑裸字节）。
 * 截图尺寸控制由调用方在采集时完成（desktopCapturer thumbnailSize / toJPEG quality）。
 */
export function encodeImageForLLM(
  buf: Buffer,
  _opts: ImageEncodeOptions = {},
): ContentPart {
  const mime = detectMime(buf);
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${buf.toString('base64')}` },
  };
}

/** 检测图像 MIME 类型（LIB-01 修复：不再统一标 image/png） */
function detectMime(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  // 默认 PNG（向后兼容）
  return 'image/png';
}

/** 从 PNG/JPEG 头解析尺寸（保留供调用方使用） */
export function readImageSize(buf: Buffer): { width: number; height: number } | null {
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
