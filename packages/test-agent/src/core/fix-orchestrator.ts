/**
 * Fix Orchestrator — 诊断先行架构的修复编排。
 *
 * 诊断阶段产出 FailedCaseRecord[]（含 category + confidence）后，
 * 由 runner/host-mode 调用 runFixByDiagnosis：
 * 构造修复 Agent（read + edit + 测试工具），喂入诊断结果，
 * LLM 按诊断分类修复（real-bug→生产代码，test-defect→测试），
 * 修完重跑验证，产出可追溯可回滚的 FixAction[]。
 *
 * 设计参考 orchestrator.ts runDiagnosis 的 sub 接线模式（capability-ceiling /
 * turn-budget / mutation-evidence），以及 runner.ts runExecute 的 Agent 构造模式。
 *
 * 修复对象限定（PRD「不碰生产代码」）：本期靠 prompt 约束 + mutation-evidence
 * 事后追踪。路径级 capability-ceiling 限定留二期——当前 capability-ceiling 只
 * 限定工具不限定路径，强行路径限定需扩展 sub 源码（PRD 非目标）。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  Agent,
  createReadTool,
  createWriteTool,
  createEditTool,
  type AgentTool,
  type StreamFn,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@cxmt/agent-core";
import type { Model } from "@cxmt/ai";
import {
  appendTurnBudgetSystemPrompt,
  turnBudgetDecision,
  turnBudgetExceededMessage,
  snapshotTrackedMutations,
  collectTrackedMutationEvidence,
  registerSubagentCapabilityCeiling,
  resolveSubagentCapabilityCeiling,
  assertAgentAllowedByCapabilityCeiling,
} from "@cxmt/sub";
import { getScenario } from "./scenarios.js";
import { createTestTools, type TestToolContext, type TestToolDetails } from "./tools/index.js";
import type { DiagnosisResult, FixAction, DiagnosisCategory, AgentEvent } from "./types.js";
import { createEscalateTool } from "./tools/escalate.js";
import type { EscalationHandler } from "./escalation-handler.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface FixDeps {
  /** LLM stream 函数。 */
  streamFn: StreamFn;
  /** 模型配置。 */
  model: Model<"openai-completions">;
  /** API key。 */
  apiKey: string;
  /** 工具执行上下文（bindToolContext 用，提供 cwd 等）。 */
  execContext: ExecutionToolContext;
  /** 测试工具上下文（createTestTools 用，提供 projectPath）。 */
  testToolContext: TestToolContext;
  /** 项目根路径。 */
  projectPath: string;
  /** 诊断结果（驱动修复决策）。 */
  diagnosis: DiagnosisResult;
  /** 轮次预算（默认 { maxTurns: 8, graceTurns: 1 }）。 */
  turnBudget?: { maxTurns: number; graceTurns: number };
  /** 会话 ID（capability-ceiling 隔离用）。 */
  sessionId?: string;
  /** Escalation handler（角色配 escalation:true 时注入 escalate 工具）。 */
  escalationHandler?: EscalationHandler;
  /** 片C：是否开启 steer（role.escalationSteer=true 时传 true）。 */
  escalationSteer?: boolean;
  /** 角色是否配 escalation:true（接线层双守卫，照抄 runner.ts runExecute 的 role?.escalation && handler 模式）。 */
  roleEscalation?: boolean;
  /** 事件转发（供 GUI 可视化角色事件，转发时加 role="fixer"）。 */
  emit?: (event: AgentEvent) => void;
}

// ---------------------------------------------------------------------------
// 本地 bindToolContext（复制自 runner.ts:194/orchestrator.ts:63，该函数未导出）
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
// 回滚 patch 捕获
// ---------------------------------------------------------------------------

/**
 * 捕获修复后的 workspace 改动（git diff HEAD）作为回滚 patch。
 * 在修复 Agent 跑完之后调用——此时 workspace 含修复改动，diff 相对 committed baseline。
 * 回滚时 `git apply -R` 逆向应用此 patch 恢复到修复前。
 * 无 git / 无改动时返回空字符串（回滚降级为不可用，不报错）。
 */
function captureFixPatch(projectPath: string): string {
  try {
    return execFileSync("git", ["diff", "HEAD"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return "";
  }
}

/**
 * 获取指定文件相对 HEAD 的 diff（修复后的改动内容）。
 */
function getFileDiff(projectPath: string, filePath: string): string {
  try {
    return execFileSync("git", ["diff", "HEAD", "--", filePath], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 修复 prompt 构造
// ---------------------------------------------------------------------------

function buildFixPrompt(diagnosis: DiagnosisResult): string {
  const caseList = diagnosis.failedCases
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} [${c.category}] (置信度: ${c.confidence ?? "low"})
   证据：${c.evidence ?? "-"}
   建议：${c.suggestion ?? "-"}`,
    )
    .join("\n\n");

  return `请根据以下诊断结果修复失败用例。

## 诊断结果

${caseList}

## 修复要求

按诊断分类限定修复对象：
- real-bug：只改生产代码（被测代码），不要改测试代码
- test-defect：只改测试代码，不要改生产代码

## 工作流程

1. 用 read 读取诊断指出的代码位置
2. 用 edit 修复（只改该改的文件类别）
3. **必须**用测试工具（node_test/maven_test/playwright_test/api_test）重跑验证——不重跑视为未完成
4. 修完报告改了哪些文件

## 重要约束

- 第 3 步是**必做**的：修完后必须调用测试工具重跑，确认修复是否生效
- 如果重跑仍失败，报告失败原因，不要继续盲目修改
- 只改该改的文件类别，不要碰不该改的代码

现在开始修复。`;
}

// ---------------------------------------------------------------------------
// 测试结果聚合（从修复 Agent 的 toolResults 取最后一次测试工具结果）
// ---------------------------------------------------------------------------

function aggregateRerunResult(toolResults: TestToolDetails[]): { passed: number; failed: number } {
  if (toolResults.length === 0) return { passed: 0, failed: 0 };
  // 取最后一次有测试数据的结果
  const latest = new Map<string, TestToolDetails>();
  for (const r of toolResults) {
    if (r.tests > 0) {
      latest.set(r.tool, r);
    } else if (!latest.has(r.tool)) {
      latest.set(r.tool, r);
    }
  }
  let passed = 0;
  let failed = 0;
  for (const r of latest.values()) {
    passed += r.pass;
    failed += r.fail;
  }
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 运行修复（按诊断分类）。
 *
 * 构造修复 Agent（read + edit + 测试工具），喂入诊断结果，
 * LLM 按分类修复，修完重跑验证，产出 FixAction[]（含回滚 patch）。
 *
 * 不会抛异常——修复失败时降级为空 fixActions + 修复前 report。
 *
 * @param deps 外部依赖 + 诊断结果
 * @returns 修复动作列表 + 重跑后的最终测试结果
 */
export async function runFixByDiagnosis(
  deps: FixDeps,
): Promise<{ fixActions: FixAction[]; finalReport: { passed: number; failed: number; coverage: number | null } }> {
  if (deps.diagnosis.failedCases.length === 0) {
    return { fixActions: [], finalReport: { passed: 0, failed: 0, coverage: null } };
  }

  try {
    const scenario = getScenario("fix-by-diagnosis");
    const prompt = buildFixPrompt(deps.diagnosis);

    // A. turn-budget
    const turnBudget = deps.turnBudget ?? { maxTurns: 8, graceTurns: 1 };
    const systemPrompt = appendTurnBudgetSystemPrompt(scenario.systemPrompt, turnBudget);

    // C. capability-ceiling：声明式 ceiling（限定工具集，路径级限定留二期）
    const sessionId = deps.sessionId ?? randomUUID();
    let ceilingHandle: { dispose(): void } | undefined;
    try {
      ceilingHandle = registerSubagentCapabilityCeiling({
        sessionId,
        source: "test-agent.fix",
        ceiling: { allowedTools: scenario.tools, denyExtensions: true },
      });
      assertAgentAllowedByCapabilityCeiling("fix-by-diagnosis", resolveSubagentCapabilityCeiling(sessionId));
    } catch {
      // ceiling 注册失败不阻断修复，降级继续（仅丢失隔离防护）
      ceilingHandle = undefined;
    }

    // B. mutation-evidence：修复前 baseline 快照
    let baseline: ReturnType<typeof snapshotTrackedMutations> | undefined;
    try {
      baseline = snapshotTrackedMutations(deps.projectPath);
    } catch {
      baseline = undefined;
    }

    // 构造修复 Agent 的工具（read + edit + 测试工具，照 runner.ts buildToolsForScenario 模式）
    const toolSet = new Set(scenario.tools);
    const tools: AgentTool<any>[] = [];
    const allTestTools = createTestTools(deps.testToolContext);
    for (const tool of allTestTools) {
      if (toolSet.has(tool.name)) tools.push(tool);
    }
    if (toolSet.has("read")) tools.push(bindToolContext(createReadTool(), deps.execContext));
    if (toolSet.has("write")) tools.push(bindToolContext(createWriteTool(), deps.execContext));
    if (toolSet.has("edit")) tools.push(bindToolContext(createEditTool(), deps.execContext));

    // escalation 工具注入（fixer 配 escalation:true 且 handler 可用时——接线层双守卫，不假设调用方已守卫）
    if (deps.escalationHandler && deps.roleEscalation) {
      tools.push(createEscalateTool(deps.escalationHandler, "fixer"));
    }

    // 收集测试工具结果（subscribe 拦截 tool_execution_end）+ 转发角色事件（供 GUI 可视化）
    const toolResults: TestToolDetails[] = [];
    let eventTurnCount = 0;
    const handleEvent = (event: any): void => {
      if (event?.type === "tool_execution_end") {
        const det = (event.result as { details?: TestToolDetails })?.details;
        if (det && typeof det.tests === "number") {
          toolResults.push(det);
        }
      }
      if (!deps.emit) return;
      const role = "fixer";
      if (event?.type === "agent_start") deps.emit({ type: "agent_start", role });
      else if (event?.type === "turn_start") { eventTurnCount++; deps.emit({ type: "turn_start", turn: eventTurnCount, role }); }
      else if (event?.type === "turn_end") deps.emit({ type: "turn_end", turn: eventTurnCount, role });
      else if (event?.type === "message_update") deps.emit({ type: "message_update", text: event.assistantMessageEvent?.delta ?? "", role });
      else if (event?.type === "tool_execution_start") deps.emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, role });
      else if (event?.type === "tool_execution_end") deps.emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, role });
    };

    let turnCount = 0;
    const agent = new Agent({
      streamFn: deps.streamFn,
      getApiKey: () => deps.apiKey,
      initialState: {
        systemPrompt,
        model: deps.model,
        tools,
        thinkingLevel: "off",
      },
      shouldStopAfterTurn: (context) => {
        turnCount++;
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
      deps.escalationHandler.registerAgent("fixer", agent);
      // 片C：steer 默认关闭，仅 deps.escalationSteer=true 时开启
      if (deps.escalationSteer) deps.escalationHandler.setSteerEnabled("fixer", true);
    }

    const unsub = agent.subscribe(handleEvent);
    try {
      await agent.prompt(prompt);
      await agent.waitForIdle();
    } catch {
      // Agent 执行异常——降级为空修复
      return { fixActions: [], finalReport: { passed: 0, failed: 0, coverage: null } };
    } finally {
      unsub();
      ceilingHandle?.dispose();
    }

    // A. turn-budget：超预算标注
    try {
      if (
        turnBudgetDecision(turnBudget, turnCount, false, false, true) === "abort" &&
        turnCount >= turnBudget.maxTurns + turnBudget.graceTurns
      ) {
        console.warn(turnBudgetExceededMessage(turnBudget, turnCount));
      }
    } catch {
      // ignore
    }

    // B. mutation-evidence：修复后收集变更证据
    let changedFiles: string[] = [];
    if (baseline) {
      try {
        const evidence = collectTrackedMutationEvidence(baseline);
        changedFiles = evidence.changedFiles;
      } catch {
        // 变更追踪失败不阻断
      }
    }

    // 获取每个改动文件的 diff
    const fileDiffs = changedFiles.map((filePath) => ({
      path: filePath,
      diff: getFileDiff(deps.projectPath, filePath),
    }));

    // 重跑结果（从修复 Agent 的 toolResults 聚合）
    const rerunResult = aggregateRerunResult(toolResults);

    // 回滚 patch：修复后捕获 workspace 改动（相对 committed baseline 的 diff）
    const fixPatch = captureFixPatch(deps.projectPath);

    // 产 FixAction[]：把所有诊断归为一个 FixAction（期1 整体回滚）
    const categories = new Set(deps.diagnosis.failedCases.map((c) => c.category));
    const primaryCategory: DiagnosisCategory = categories.has("real-bug")
      ? "real-bug"
      : (categories.values().next().value ?? "test-defect");
    const primaryConfidence = deps.diagnosis.failedCases.find((c) => c.confidence === "low")
      ? "low"
      : "high";

    const fixActions: FixAction[] = [
      {
        diagnosisName: deps.diagnosis.failedCases.map((c) => c.name).join(", "),
        category: primaryCategory,
        confidence: primaryConfidence,
        files: fileDiffs,
        rerunResult,
        patch: fixPatch,
      },
    ];

    return {
      fixActions,
      finalReport: { passed: rerunResult.passed, failed: rerunResult.failed, coverage: null },
    };
  } catch {
    // 整体异常降级——不 throw，返回空修复
    return { fixActions: [], finalReport: { passed: 0, failed: 0, coverage: null } };
  }
}
