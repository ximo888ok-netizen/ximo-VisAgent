// 滑窗视觉记忆：最近 N 步截图保留为 image content，更早的仅保留文本摘要。
// 设计参考：UI-TARS-desktop MessageHistory.maxImagesCount 的滑动图片窗口。
// ximo 的差异：agent-core 不 import electron，截图由 loop 层注入 Buffer，
// buildImagePart 由 loop 层调用（不同供应商 detail 档位不同）。
// 压缩触发时（memory.needsCompression）旧截图自动丢弃——与文本摘要同步。
import type { ChatMessage, ContentPart, ILLMClient } from '@ximo-visagent/llm-providers';

/** 图片滑窗大小：最近 3 步截图保留为 image，更早的丢弃（每帧 ~384 token，3 帧 ≈ 1152 token） */
const IMAGE_WINDOW = 3;

export interface VisualStep {
  /** 本步截图 JPEG（无网格净帧；由 loop 层在压缩前注入） */
  jpeg: Buffer;
}

/**
 * 视觉记忆滑窗：维护最近 IMAGE_WINDOW 步的截图，
 * 在 buildHistoryMessages 返回的纯文本消息上叠加图片 ContentPart。
 */
export class VisualMemory {
  private steps: VisualStep[] = [];

  /** 添加一步截图（超过窗口自动丢弃最旧的） */
  add(step: VisualStep): void {
    this.steps.push(step);
    if (this.steps.length > IMAGE_WINDOW) this.steps.shift();
  }

  /** 压缩触发时清空旧截图（与 memory.compressNow 同步调用） */
  clear(): void {
    this.steps = [];
  }

  get length(): number {
    return this.steps.length;
  }

  /**
   * 把纯文本历史消息的最近 N 条升级为带图片的多模态消息。
   * 策略：从后往前找 assistant 消息（buildHistoryMessages 的滑窗步），
   *        每条注入对应步骤的截图作为 ContentPart[]。
   *
   * @param messages buildHistoryMessages 返回的纯文本消息
   * @param model 当前使用的 LLM 客户端（用于 image detail 档位适配）
   * @returns 升级后的消息数组（原消息不被修改，新数组替换）
   */
  async injectImages(messages: ChatMessage[], model: ILLMClient): Promise<ChatMessage[]> {
    if (this.steps.length === 0) return messages;

    const result = [...messages];
    // 从后往前匹配 assistant 消息（buildHistoryMessages 的滑窗步格式：`${actionName}(...) → result`）
    // 同时从后往前消费截图队列
    const screenshots = [...this.steps]; // 复制，从后往前消费
    let imgIdx = screenshots.length - 1;

    for (let i = result.length - 1; i >= 0 && imgIdx >= 0; i--) {
      const msg = result[i];
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
      // 摘要块/放弃清单是 assistant 角色但不是滑窗步，跳过（它们以 [ 开头）
      if (msg.content.startsWith('[')) continue;

      // 升级为多模态：图片在前，文本在后（模型先看图再读文字）
      const jpeg = screenshots[imgIdx]!.jpeg;
      const imagePart = await buildImagePartInline(model, jpeg);
      result[i] = {
        ...msg,
        content: [imagePart, { type: 'text', text: msg.content }],
      };
      imgIdx--;
    }

    return result;
  }
}

/** 截图 → LLM 图片块（内联 base64；detail 档位按供应商适配） */
async function buildImagePartInline(model: ILLMClient, screenshot: Buffer): Promise<ContentPart> {
  // 复用 llm-providers 的 imageDetailFor 逻辑（不直接 import buildImagePart 以避免循环依赖）
  const { imageDetailFor } = await import('@ximo-visagent/llm-providers');
  const provider = model.config.provider;
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${screenshot.toString('base64')}`,
      detail: imageDetailFor(provider),
    },
  };
}
