// 滑窗视觉记忆：最近 N 步截图保留为 image content，更早的仅保留文本摘要。
// 设计参考：UI-TARS-desktop MessageHistory.maxImagesCount 的滑动图片窗口。
// ximo 的差异：agent-core 不 import electron，截图由 loop 层注入 Buffer，
// buildImagePart 由 loop 层调用（不同供应商 detail 档位不同）。
// 压缩触发时（memory.needsCompression）保留最近 1 帧截图——完全清空会让模型
// 丢失视觉连续性（压缩后文本摘要只有操作历史，没有"上一步界面长什么样"）。
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

  /** 压缩触发时保留最近 1 帧截图（与 memory.compressNow 同步调用）。
   *  完全清空会导致模型丢失视觉上下文：压缩后的文本摘要只记录了操作历史，
   *  但模型需要看到"上一步界面长什么样"才能判断当前界面是新状态还是回退。
   *  保留最近 1 帧 = 最低成本的视觉连续性保障（1 帧 ≈ 384 token）。 */
  clear(): void {
    if (this.steps.length <= 1) return;
    this.steps = this.steps.slice(-1);
  }

  get length(): number {
    return this.steps.length;
  }

  /**
   * 在纯文本历史消息的最近 N 条 assistant 步前面插入 user 角色的截图消息。
   *
   * 为什么用 user 角色而非升级 assistant 消息：
   * Qwen / 通义千问 OpenAI 兼容 API 不允许 assistant 消息中出现 image_url，
   * 只允许 user 消息包含图片。因此截图作为独立的 user 消息插入到
   * assistant 动作消息之前，模拟「用户给模型看上一步截图」的效果。
   *
   * @param messages buildHistoryMessages 返回的纯文本消息
   * @param model 当前使用的 LLM 客户端（用于 image detail 档位适配）
   * @returns 插入截图后的消息数组（原消息不被修改，新数组替换）
   */
  async injectImages(messages: ChatMessage[], model: ILLMClient): Promise<ChatMessage[]> {
    if (this.steps.length === 0) return messages;

    const result: ChatMessage[] = [];
    const screenshots = [...this.steps]; // 复制，从后往前消费
    let imgIdx = screenshots.length - 1;

    // 从后往前遍历，在匹配的 assistant 步前面插入 user 角色截图消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      // 在 assistant 动作步前面插入截图
      if (imgIdx >= 0 && msg.role === 'assistant' && typeof msg.content === 'string'
          && !msg.content.startsWith('[')) {
        const jpeg = screenshots[imgIdx]!.jpeg;
        const imagePart = await buildImagePartInline(model, jpeg);
        // 插入 user 角色截图消息（在 assistant 消息前面）
        result.unshift({ role: 'user', content: [imagePart] });
        imgIdx--;
      }
      result.unshift(msg);
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
