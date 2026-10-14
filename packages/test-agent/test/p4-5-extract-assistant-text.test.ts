import { describe, expect, it } from "vitest";
import type { Message, TextContent, ThinkingContent } from "@cxmt/ai";
import { extractAssistantText } from "../src/core/assistant-text.js";

function makeTextMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text } as TextContent] } as Message;
}
function makeThinkingMsg(thinking: string, redacted = false): Message {
  return { role: "assistant", content: [{ type: "thinking", thinking, redacted } as ThinkingContent] } as Message;
}
function makeMixedMsg(text: string, thinking: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking } as ThinkingContent,
      { type: "text", text } as TextContent,
    ],
  } as Message;
}

describe("P4-5 extractAssistantText", () => {
  it("text-only：返回 text content", () => {
    const msg = makeTextMsg("侦察报告内容");
    expect(extractAssistantText([msg])).toBe("侦察报告内容");
  });

  it("thinking-only：fallback 返回 thinking content", () => {
    const msg = makeThinkingMsg("推理过程内容");
    expect(extractAssistantText([msg])).toBe("推理过程内容");
  });

  it("text+thinking：优先返回 text content", () => {
    const msg = makeMixedMsg("格式化报告", "推理过程");
    expect(extractAssistantText([msg])).toBe("格式化报告");
  });

  it("都空：返回空字符串", () => {
    const msg: Message = { role: "assistant", content: [] } as Message;
    expect(extractAssistantText([msg])).toBe("");
  });

  it("redacted thinking：跳过 redacted，返回空", () => {
    const msg = makeThinkingMsg("安全过滤内容", true);
    expect(extractAssistantText([msg])).toBe("");
  });

  it("多条消息：取最后一条 assistant", () => {
    const msgs = [makeTextMsg("旧消息"), makeTextMsg("最新消息")];
    expect(extractAssistantText(msgs)).toBe("最新消息");
  });

  it("无 assistant 消息：返回空", () => {
    expect(extractAssistantText([{ role: "user", content: [] } as Message])).toBe("");
  });
});
