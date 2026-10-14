import { describe, expect, it } from "vitest";
import type { Message } from "@cxmt/ai";
import {
  buildTransientExecutionRecoveryPrompt,
  getLastAssistantMessage,
  shouldRecoverTransientExecution,
} from "../src/core/execution-recovery.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(stopReason: "error" | "stop", errorMessage?: string): Message {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("transient execution recovery", () => {
  it("recovers one interrupted model turn before any test result exists", () => {
    const messages: Message[] = [{ role: "user", content: "run", timestamp: Date.now() }, assistant("error", "terminated")];
    expect(shouldRecoverTransientExecution(messages, 0, 0)).toBe(true);
    expect(getLastAssistantMessage(messages)?.errorMessage).toBe("terminated");
  });

  it("does not recover non-transient errors, completed test calls, or a second interruption", () => {
    expect(shouldRecoverTransientExecution([assistant("error", "invalid api key")], 0, 0)).toBe(false);
    expect(shouldRecoverTransientExecution([assistant("error", "terminated")], 1, 0)).toBe(false);
    expect(shouldRecoverTransientExecution([assistant("error", "terminated")], 0, 1)).toBe(false);
  });

  it("tells the model to continue from context and execute a real test tool", () => {
    const prompt = buildTransientExecutionRecoveryPrompt("terminated");
    expect(prompt).toContain("terminated");
    expect(prompt).toContain("不要重新开始项目分析");
    expect(prompt).toContain("测试工具");
  });
});
