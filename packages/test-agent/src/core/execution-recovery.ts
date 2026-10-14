import { isRetryableAssistantError, type AssistantMessage, type Message } from "@cxmt/ai";

export const MAX_TRANSIENT_EXECUTION_RECOVERIES = 1;

export function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
}

export function shouldRecoverTransientExecution(
  messages: Message[],
  testResultCount: number,
  recoveryCount: number,
): boolean {
  if (testResultCount > 0 || recoveryCount >= MAX_TRANSIENT_EXECUTION_RECOVERIES) return false;
  const lastAssistant = getLastAssistantMessage(messages);
  return lastAssistant !== undefined && isRetryableAssistantError(lastAssistant);
}

export function buildTransientExecutionRecoveryPrompt(errorMessage?: string): string {
  return [
    `上一轮模型输出因临时传输错误中断${errorMessage ? `（${errorMessage}）` : ""}。`,
    "继续当前测试任务，不要重新开始项目分析。利用已经读取的内容，立即写入所需测试文件并调用与项目匹配的测试工具；最终必须产生真实、可核验的测试结果。",
  ].join("");
}
