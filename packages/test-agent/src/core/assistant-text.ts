import type { Message, TextContent, ThinkingContent } from "@cxmt/ai";

/**
 * 从 LLM 回复提取文本产出。优先取 text content block，
 * text 为空时 fallback 取 thinking content block（reasoning 模型兼容）。
 * 跳过 redacted 的 thinking block（安全过滤的推理内容不可用）。
 *
 * @param messages Agent 的完整消息列表
 * @returns 提取的文本（trim 后），可能为空字符串
 */
export function extractAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return "";

  const content = lastAssistant.content ?? [];

  // 优先取 text content block
  const textParts = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text);
  const text = textParts.join("").trim();
  if (text) return text;

  // Fallback：取 thinking content block（reasoning 模型兼容）
  // 跳过 redacted（安全过滤的推理内容不可用）
  const thinkingParts = content
    .filter((c): c is ThinkingContent => c.type === "thinking" && !c.redacted)
    .map((c) => c.thinking);
  return thinkingParts.join("").trim();
}
