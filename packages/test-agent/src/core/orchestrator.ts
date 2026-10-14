/**
 * Orchestrator — 失败诊断编排。
 *
 * execute 阶段结束后，若 report.failed > 0，由 runner 调用 runDiagnosis：
 * 构造 read-only Agent（只有 read 工具），喂入失败用例 + 错误输出 + 代码路径，
 * 解析 LLM 输出为结构化 FailedCaseRecord[]（带 category/evidence/suggestion）。
 *
 * 设计参考 runner.ts runPlan/runExecute 的 Agent 构造模式（new Agent → subscribe →
 * prompt → waitForIdle），以及 parseCasesFromResponse 的 JSON 提取+容错模式。
 *
 * read-only 硬约束：只注入 createReadTool，不注入 write/edit/bash/任何测试工具。
 * 场景 E 验收：诊断 Agent 跑完后 git diff 必须为空。
 */

import {
  Agent,
  createReadTool,
  type AgentTool,
  type StreamFn,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@cxmt/agent-core";
import type { Model, Message, TextContent } from "@cxmt/ai";
import { extractAssistantText } from "./assistant-text.js";
import {
  appendTurnBudgetSystemPrompt,
  turnBudgetDecision,
  turnBudgetExceededMessage,
  snapshotTrackedMutations,
  collectTrackedMutationEvidence,
  registerSubagentCapabilityCeiling,
  resolveSubagentCapabilityCeiling,
  assertAgentAllowedByCapabilityCeiling,
  validateImplementationToolContract,
} from "@cxmt/sub";
import { randomUUID } from "node:crypto";
import { getScenario } from "./scenarios.js";
import type { FailedCaseRecord, DiagnosisResult, DiagnosisCategory, AgentEvent } from "./types.js";
import { createEscalateTool } from "./tools/escalate.js";
import type { EscalationHandler } from "./escalation-handler.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 诊断所需的外部依赖（由 runner 在接线时传入）。 */
export interface DiagnosisDeps {
  streamFn: StreamFn;
  model: Model<"openai-completions">;
  apiKey: string;
  /** 工具执行上下文（bindToolContext 用，提供 cwd 等）。 */
  execContext: ExecutionToolContext;
  /** 项目根路径。 */
  projectPath: string;
  /** 轮次预算（默认 { maxTurns: 8, graceTurns: 1 }）。 */
  turnBudget?: { maxTurns: number; graceTurns: number };
  /** 会话 ID（capability-ceiling 隔离用，默认随机生成）。 */
  sessionId?: string;
  /** Escalation handler（角色配 escalation:true 时注入 escalate 工具）。 */
  escalationHandler?: EscalationHandler;
  /** 片C：是否开启 steer（role.escalationSteer=true 时传 true）。 */
  escalationSteer?: boolean;
  /** 角色是否配 escalation:true（接线层双守卫，照抄 runner.ts runExecute 的 role?.escalation && handler 模式）。 */
  roleEscalation?: boolean;
  /** 事件转发（供 GUI 可视化角色事件，转发时加 role="result-reviewer"）。 */
  emit?: (event: AgentEvent) => void;
}

/** 失败用例的 raw 事实（来自 validator 的 parseNodeFailures）。 */
export interface FailedCaseInput {
  name: string;
  layer: string;
  error: string;
  /** P1-5：关联的用例 id（TestCase.id，来自 executionCases 匹配），端到端透传到 FailedCaseRecord.caseId。 */
  caseId?: string;
}

/** Enough evidence for each failure without allowing repository-wide browsing. */
export function diagnosisReadBudget(failedCaseCount: number): number {
  return Math.min(16, Math.max(6, failedCaseCount * 2));
}

// ---------------------------------------------------------------------------
// 本地 bindToolContext（复制自 runner.ts:194，该函数未导出）
// ---------------------------------------------------------------------------

function bindToolContext<TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, any, TDetails>,
  context: ExecutionToolContext,
): AgentTool<any, TDetails> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    async execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

// ---------------------------------------------------------------------------
// 诊断 prompt 构造
// ---------------------------------------------------------------------------

function buildDiagnosisPrompt(
  failedCases: FailedCaseInput[],
  rawOutput: string,
  testCodePaths?: string[],
): string {
  const caseList = failedCases
    .map((c, i) => `${i + 1}. ${c.name} [${c.layer}]${c.caseId ? ` caseId: ${c.caseId}` : " caseId: -"}\n   错误：${c.error}`)
    .join("\n\n");

  const pathInfo = testCodePaths?.length
    ? `\n\n## 代码路径（请用 read 工具查看）\n\n${testCodePaths.map((p) => `- ${p}`).join("\n")}`
    : "";

  return `请对以下 ${failedCases.length} 个失败用例进行诊断。

## 失败用例列表

${caseList}

## 完整错误输出

${rawOutput}${pathInfo}

优先使用错误输出和 Surefire 报告，只读取直接相关的失败测试与生产源码；不要遍历项目。证据足够后立即停止读取。
请对每个失败用例判断分类（real-bug/test-defect/environment/flaky），附证据和修复建议，然后输出 JSON 数组。对每条诊断输出 caseId 字段（原样回填失败用例列表的 caseId，无则省略）。`;
}

// ---------------------------------------------------------------------------
// 输出解析（参考 runner.ts parseCasesFromResponse 模式）
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<DiagnosisCategory>([
  "real-bug",
  "test-defect",
  "environment",
  "flaky",
]);

export function parseDiagnosisResponse(messages: Message[], failedCases?: FailedCaseInput[]): FailedCaseRecord[] {
  const text = extractAssistantText(messages);
  if (!text) return [];

  // 1. 优先提取 ```json ... ``` 代码块
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  let jsonStr: string | null = null;
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  } else {
    // 2. 回退：匹配第一个 [ 到最后一个 ]
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      jsonStr = text.slice(start, end + 1).trim();
    }
  }
  if (!jsonStr) return [];

  const mapToRecords = (parsed: unknown): FailedCaseRecord[] => {
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => {
        const categoryRaw = String(item.category ?? "");
        const category: DiagnosisCategory = VALID_CATEGORIES.has(categoryRaw as DiagnosisCategory)
          ? (categoryRaw as DiagnosisCategory)
          : "test-defect";
        const evidence = typeof item.evidence === "string" ? item.evidence : "";
        const confidence = item.confidence === "high" || item.confidence === "low" ? item.confidence : "low";
        let suggestion = typeof item.suggestion === "string" ? item.suggestion : "";
        // E. 诊断证据空值检查：evidence 空时追加警示，不丢分类
        if (!evidence) {
          suggestion = suggestion
            ? `${suggestion}（诊断证据缺失，需人工核查）`
            : "诊断证据缺失，需人工核查";
        }
        const name = String(item.name ?? "未知用例");
        // P1-5：caseId 优先 LLM 输出，漏填时按 name 回查原 failedCases inputs 兜底（reviewer 必处理）
        const llmCaseId = typeof item.caseId === "string" && item.caseId ? item.caseId : undefined;
        const fallbackCaseId = failedCases?.find((f) => f.name === name)?.caseId;
        const caseId = llmCaseId ?? fallbackCaseId;
        return {
          name,
          layer: String(item.layer ?? "unit"),
          error: String(item.error ?? ""),
          category,
          confidence,
          ...(evidence ? { evidence } : {}),
          ...(suggestion ? { suggestion } : {}),
          ...(caseId ? { caseId } : {}),
        };
      });
  };

  try {
    return mapToRecords(JSON.parse(jsonStr));
  } catch {
    // JSON 解析失败——尝试修复 LLM 常见的未转义引号问题
    // 修复策略与 parseCasesFromResponse 一致
    try {
      let prev = jsonStr;
      let fixed = jsonStr;
      let pass = 0;
      do {
        prev = fixed;
        fixed = fixed.replace(/([^\s:,\[\]{}\\])"([^\s:,\[\]{}])/g, '$1\\"$2');
        pass++;
      } while (fixed !== prev && pass < 20);
      return mapToRecords(JSON.parse(fixed));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 降级：解析失败时对每个输入 failedCase 产保守诊断
// ---------------------------------------------------------------------------

export function degradeDiagnosis(inputs: FailedCaseInput[]): DiagnosisResult {
  return {
    failedCases: inputs.map((c) => {
      const record: FailedCaseRecord = {
        name: c.name,
        layer: c.layer,
        error: c.error,
        category: "test-defect" as DiagnosisCategory,
        confidence: "low" as const,
        evidence: c.error,
        suggestion: "诊断失败，需人工核查",
      };
      // P1-5 澄清2：条件展开 caseId，不强制填 undefined
      return c.caseId ? { ...record, caseId: c.caseId } : record;
    }),
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 运行失败诊断。
 *
 * 构造 read-only Agent（只有 read 工具），喂入失败用例 + 错误输出 + 代码路径，
 * 解析 LLM 输出为结构化 FailedCaseRecord[]。
 *
 * 不会抛异常——解析失败时降级为保守诊断（category: test-defect）。
 *
 * @param deps 外部依赖（streamFn/model/apiKey/execContext/projectPath）
 * @param failedCases 失败用例 raw 事实（来自 validator）
 * @param rawOutput 完整错误输出
 * @param testCodePaths 测试代码路径（reviewer 用 read 查证据）
 * @returns 诊断结果（failedCases 带 category/evidence/suggestion）
 */
export async function runDiagnosis(
  deps: DiagnosisDeps,
  failedCases: FailedCaseInput[],
  rawOutput: string,
  testCodePaths?: string[],
): Promise<DiagnosisResult> {
  if (failedCases.length === 0) {
    return { failedCases: [] };
  }

  const scenario = getScenario("result-reviewer");
  const prompt = buildDiagnosisPrompt(failedCases, rawOutput, testCodePaths);

  // A. turn-budget：轮次上限（默认 8 轮 + 1 grace）
  const turnBudget = deps.turnBudget ?? { maxTurns: 8, graceTurns: 1 };
  const systemPrompt = appendTurnBudgetSystemPrompt(scenario.systemPrompt, turnBudget);

  // C. capability-ceiling：声明式 ceiling + agent 名门禁
  const sessionId = deps.sessionId ?? randomUUID();
  let ceilingHandle: { dispose(): void } | undefined;
  try {
    ceilingHandle = registerSubagentCapabilityCeiling({
      sessionId,
      source: "test-agent.diagnosis",
      ceiling: { allowedTools: ["read"], denyExtensions: true },
    });
    assertAgentAllowedByCapabilityCeiling("result-reviewer", resolveSubagentCapabilityCeiling(sessionId));
  } catch {
    // ceiling 注册失败不阻断诊断，降级继续（仅丢失隔离防护）
    ceilingHandle = undefined;
  }

  // D. completion-guard：契约校验（read-only agent 不应有 mutation 工具）
  try {
    const contractError = validateImplementationToolContract({
      agent: "result-reviewer",
      task: prompt,
      tools: ["read"],
      completionGuard: true,
    });
    if (contractError) {
      // [需人工复核] 契约校验发现问题——降级为保守诊断，不跑 LLM
      return degradeDiagnosis(failedCases);
    }
  } catch {
    // 契约校验异常不阻断诊断
  }

  // B. mutation-evidence：诊断前 baseline 快照
  let baseline: ReturnType<typeof snapshotTrackedMutations> | undefined;
  try {
    baseline = snapshotTrackedMutations(deps.projectPath);
  } catch {
    // snapshot 失败不阻断诊断（仅丢失变更追踪）
    baseline = undefined;
  }

  // read-only 硬约束：只注入 createReadTool
  const tools: AgentTool<any>[] = [bindToolContext(createReadTool(), deps.execContext)];

  // escalation 工具注入（result-reviewer 配 escalation:true 且 handler 可用时——接线层双守卫，不假设调用方已守卫）
  if (deps.escalationHandler && deps.roleEscalation) {
    tools.push(createEscalateTool(deps.escalationHandler, "result-reviewer"));
  }

  let turnCount = 0;
  let eventTurnCount = 0;
  let readCount = 0;
  const maxReadCalls = diagnosisReadBudget(failedCases.length);
  const agent = new Agent({
    streamFn: deps.streamFn,
    getApiKey: () => deps.apiKey,
    initialState: {
      systemPrompt,
      model: deps.model,
      tools,
      thinkingLevel: "off",
    },
    beforeToolCall: async ({ toolCall }) => {
      if (toolCall.name !== "read") return undefined;
      if (readCount >= maxReadCalls) {
        return {
          block: true,
          reason: `诊断证据读取已达到 ${maxReadCalls} 次上限。请停止继续读取，立即基于现有证据输出每个失败用例的 JSON 诊断。`,
        };
      }
      readCount++;
      return undefined;
    },
    shouldStopAfterTurn: (context) => {
      turnCount++;
      // 判断本轮是否有工具调用（assistant message 里有 toolCall parts）
      const hasToolCalls = context.message.content.some((p: any) => p.type === "toolCall");
      const terminalStop = !hasToolCalls;
      try {
        const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);
        return decision === "abort";
      } catch {
        return false;
      }
    },
  });

  // 注册 Agent 到 escalation handler（供 reply 时 steer，§7 不确定点 5）
  if (deps.escalationHandler && deps.roleEscalation) {
    deps.escalationHandler.registerAgent("result-reviewer", agent);
    // 片C：steer 默认关闭，仅 deps.escalationSteer=true 时开启
    if (deps.escalationSteer) deps.escalationHandler.setSteerEnabled("result-reviewer", true);
  }

  const unsub = agent.subscribe((event: any) => {
    if (!deps.emit) return;
    const role = "result-reviewer";
    if (event.type === "agent_start") deps.emit({ type: "agent_start", role });
    else if (event.type === "turn_start") { eventTurnCount++; deps.emit({ type: "turn_start", turn: eventTurnCount, role }); }
    else if (event.type === "turn_end") deps.emit({ type: "turn_end", turn: eventTurnCount, role });
    else if (event.type === "message_update") deps.emit({ type: "message_update", text: event.assistantMessageEvent?.delta ?? "", role });
    else if (event.type === "tool_execution_start") deps.emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, role });
    else if (event.type === "tool_execution_end") deps.emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, role });
  });
  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } catch {
    // Agent 执行异常——降级
    return degradeDiagnosis(failedCases);
  } finally {
    unsub();
    ceilingHandle?.dispose();
  }

  // A. turn-budget：检查是否超预算
  try {
    if (turnBudgetDecision(turnBudget, turnCount, false, false, true) === "abort" && turnCount >= turnBudget.maxTurns + turnBudget.graceTurns) {
      console.warn(turnBudgetExceededMessage(turnBudget, turnCount));
    }
  } catch {
    // ignore
  }

  let parsed = parseDiagnosisResponse(agent.state.messages as Message[], failedCases);

  // 解析失败或结果不完整时降级
  if (parsed.length === 0) {
    parsed = degradeDiagnosis(failedCases).failedCases;
  } else {
    // 补全：LLM 可能漏掉部分用例，对缺失的用例降级填充
    const parsedNames = new Set(parsed.map((p) => p.name));
    const missing = failedCases.filter((c) => !parsedNames.has(c.name));
    if (missing.length > 0) {
      const degraded = degradeDiagnosis(missing);
      parsed = [...parsed, ...degraded.failedCases];
    }
  }

  // B. mutation-evidence：诊断后收集变更证据
  let readOnlyViolation: { changedFiles: string[]; unavailable?: string } | undefined;
  if (baseline) {
    try {
      const evidence = collectTrackedMutationEvidence(baseline);
      if (evidence.attemptedMutation) {
        readOnlyViolation = { changedFiles: evidence.changedFiles };
      }
      if (evidence.unavailable) {
        readOnlyViolation = { changedFiles: [], unavailable: evidence.unavailable };
      }
    } catch {
      // 变更追踪失败不阻断诊断
    }
  }

  const result: DiagnosisResult = { failedCases: parsed };
  if (readOnlyViolation) {
    result.readOnlyViolation = readOnlyViolation;
  }
  return result;
}
