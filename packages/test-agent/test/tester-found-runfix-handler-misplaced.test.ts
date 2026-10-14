/**
 * tester-found bug 复现测试：runFix 用 this.escalationHandler（过期/undefined），
 * host-mode 分阶段 fixer escalate handler 错位/失效
 *
 * 发现者：tester（持续 bug 修复循环第 7 轮）
 * 模块：packages/test-agent/src/core/runner.ts runFix（line 1535, 1574）
 *
 * bug 描述：
 *   runFix 无 context 参数，line 1574 用 this.escalationHandler。
 *   - 调用点 2（auto-fix，host-mode line 204，execute runSession 内）：同 Runner 实例，
 *     this.escalationHandler = handler_design（runCaseDesign 设的旧 handler），但 GUI 答复走
 *     escalationHandlers[execId] = handler_exec（execute 当前 runSession 的）。fixer escalate 记到
 *     handler_design，GUI 答复到 handler_exec → 找不到 pending → 答复丢失（bug #5 修复后返回 false）。
 *   - 调用点 1（独立 fix，host-mode line 169，新 executionId）：新 Runner 实例，this.escalationHandler
 *     = undefined → fixer 无 escalate 工具（line 1574 undefined）+ escalation 完全失效。
 *
 *   根因：runFix 不接收 context，无法拿到当前 runSession 的 handler，只能用 this.escalationHandler
 *   （过期或 undefined）。
 *
 * 严重性建议：P1——fixer escalate 答复丢失或完全失效，fix 阶段人工干预失效。
 *
 * 复现策略：vi.mock fix-orchestrator 的 runFixByDiagnosis 捕获传入的 deps.escalationHandler，
 * 验证它是 this.escalationHandler（旧/undefined）而非当前应传的 handler。
 * 调用点 2 场景：先 mock runScout/runCaseDesign 设 this.escalationHandler=handler_design，
 * 再调 runFix 验证 deps.escalationHandler === handler_design（应等于当前 context handler）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runFixByDiagnosis 捕获 deps.escalationHandler
let capturedFixDeps: { escalationHandler?: unknown } = {};
vi.mock("../src/core/fix-orchestrator.js", () => ({
  runFixByDiagnosis: async (deps: { escalationHandler?: unknown }) => {
    capturedFixDeps = deps;
    return { fixActions: [], finalReport: { passed: 0, failed: 0, coverage: null } };
  },
}));

// mock agent-loader（loadRoles 返回 fixer 配 escalation:true）
vi.mock("../src/core/agent-loader.js", () => ({
  resolveAgentsDir: () => "/mock/agents",
  loadRoles: () => ({
    fixer: {
      name: "fixer",
      tools: ["read", "edit"],
      systemPrompt: "fixer",
      escalation: true,
    },
  }),
}));

// mock scenarios
vi.mock("../src/core/scenarios.js", () => ({
  getScenario: () => ({ name: "fix-by-diagnosis", systemPrompt: "", tools: [], providerId: "p", modelId: "m" }),
}));

describe("[tester-found] runFix 用 this.escalationHandler（过期/undefined）handler 错位", () => {
  it("调用点 2（auto-fix）：runFix 传 context handler 优先于 this.escalationHandler（旧），修复后回归守卫", async () => {
    // 动态 import（vi.mock 生效）
    const { Runner } = await import("../src/core/runner.js");
    const { EscalationHandler } = await import("../src/core/escalation-handler.js");

    // 构造 Runner（mock config，不真跑 LLM）
    const runner = new Runner({ providers: { p: { baseUrl: "", apiKey: "k", models: [{ id: "m" }] } }, defaultProvider: "p", defaultModel: "m" } as any, "p", "m");

    // 模拟 runCaseDesign 设 this.escalationHandler = handler_design（旧）
    const handlerDesign = new EscalationHandler();
    // 通过反射设 private 字段（模拟 runCaseDesign 的 this.escalationHandler = context.escalationHandler）
    (runner as unknown as { escalationHandler: EscalationHandler }).escalationHandler = handlerDesign;

    // 模拟 execute runSession 的当前 handler（handler_exec）——应传给 runFix 但 runFix 不接收
    const handlerExec = new EscalationHandler();

    // 调 runFix（修复后传 context 含当前 handler_exec）
    const input = {
      projectPath: ".",
      systemName: "test",
      version: "1.0",
      testTypes: ["unit" as const],
      diagnosis: { failedCases: [{ name: "TC1", layer: "unit", error: "err", category: "real-bug" as const }] },
    } as any;

    await runner.runFix(input, () => {}, undefined as any, { escalationHandler: handlerExec });

    // 捕获 runFixByDiagnosis 收到的 escalationHandler
    const passedHandler = capturedFixDeps.escalationHandler;

    // 修复后：runFix 传当前 context handler（handlerExec），不传 this.escalationHandler（旧 handlerDesign）
    expect(passedHandler).toBe(handlerExec);
    expect(passedHandler).not.toBe(handlerDesign);
  }, 60000);

  it("调用点 1（独立 fix）：新 Runner this.escalationHandler=undefined，runFix 传 context handler 优先（fixer 有 escalate），修复后回归守卫", async () => {
    const { Runner } = await import("../src/core/runner.js");

    // 新 Runner 实例（模拟 host-mode 独立 fix 阶段新 executionId 新 provider）
    const runner = new Runner({ providers: { p: { baseUrl: "", apiKey: "k", models: [{ id: "m" }] } }, defaultProvider: "p", defaultModel: "m" } as any, "p", "m");

    // this.escalationHandler 未设（新实例 = undefined）
    expect((runner as unknown as { escalationHandler?: unknown }).escalationHandler).toBeUndefined();

    // host-mode 新 runSession 的 handler（应传给 runFix 但 runFix 不接收）
    const { EscalationHandler } = await import("../src/core/escalation-handler.js");
    const handlerFix = new EscalationHandler();

    const input = {
      projectPath: ".",
      systemName: "test",
      version: "1.0",
      testTypes: ["unit" as const],
      diagnosis: { failedCases: [{ name: "TC1", layer: "unit", error: "err", category: "real-bug" as const }] },
    } as any;

    await runner.runFix(input, () => {}, undefined as any, { escalationHandler: handlerFix });

    // 捕获的 handler
    const passedHandler = capturedFixDeps.escalationHandler;

    // 修复后：runFix 传当前 context handler（handlerFix），不传 this.escalationHandler（undefined）
    expect(passedHandler).toBe(handlerFix);
    expect(passedHandler).toBeDefined(); // fixer 应有 escalate 能力
  }, 60000);
});
