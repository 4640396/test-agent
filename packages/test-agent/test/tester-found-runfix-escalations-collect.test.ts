/**
 * tester-found bug 复现测试：runFix escalations 收集用 this.escalationHandler（旧），
 * 非 context.escalationHandler（fixer 实际用的），fixer escalation 记录不入报告
 *
 * 发现者：tester（持续 bug 修复循环第 9 轮，bug #7 衍生）
 * 模块：packages/test-agent/src/core/runner.ts runFix line 1596
 *
 * bug 描述：
 *   bug #7 修复（commit 2cb66e1）让 runFix 的 fixer escalationHandler 优先用
 *   context.escalationHandler（line 1582）。但 runFix line 1596 的 escalations 收集
 *   仍用 this.escalationHandler（未跟着改）：
 *     `...(this.escalationHandler && this.escalationHandler.getRecords().length > 0
 *        ? { escalations: [...this.escalationHandler.getRecords()] } : {})`
 *
 *   若 context.escalationHandler ≠ this.escalationHandler（host-mode 分阶段常见）：
 *   - fixer escalate 记到 context.escalationHandler（line 1582 传入的）
 *   - result.report.escalations 从 this.escalationHandler 取（line 1596）→ 不含 fixer 记录
 *   GUI 审计 UI 读 result.report.escalations 显示不全。
 *
 * 严重性建议：P2——fixer escalation 记录不入报告，GUI 审计显示不全。非 P1（答复已对，仅记录收集错）。
 *
 * 修复方向：line 1596 改用 context.escalationHandler ?? this.escalationHandler（与 line 1582 一致）：
 *   `const reportHandler = context?.escalationHandler ?? this.escalationHandler;`
 *   `...(reportHandler && reportHandler.getRecords().length > 0 ? { escalations: [...] } : {})`
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runFixByDiagnosis：往传入的 handler 写一条 escalation 记录（模拟 fixer escalate）
vi.mock("../src/core/fix-orchestrator.js", () => ({
  runFixByDiagnosis: async (deps: { escalationHandler?: { ask: (input: { role: string; question: string; fallback?: string; context?: string }) => Promise<string> } }) => {
    // 模拟 fixer escalate（往 deps.escalationHandler 写记录）
    if (deps.escalationHandler) {
      try { await deps.escalationHandler.ask({ role: "fixer", question: "修复不确定", fallback: "保守" }); } catch { /* 超时降级 */ }
    }
    return { fixActions: [], finalReport: { passed: 0, failed: 0, coverage: null } };
  },
}));

vi.mock("../src/core/agent-loader.js", () => ({
  resolveAgentsDir: () => "/mock/agents",
  loadRoles: () => ({ fixer: { name: "fixer", tools: ["read", "edit"], systemPrompt: "fixer", escalation: true } }),
}));

vi.mock("../src/core/scenarios.js", () => ({
  getScenario: () => ({ name: "fix-by-diagnosis", systemPrompt: "", tools: [], providerId: "p", modelId: "m" }),
}));

describe("[tester-found] runFix escalations 收集用 this.escalationHandler 非 context handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("context handler ≠ this.escalationHandler：fixer escalate 记到 context handler，result.report.escalations 从 context handler 取（修复后回归守卫）", async () => {
    const { Runner } = await import("../src/core/runner.js");
    const { EscalationHandler } = await import("../src/core/escalation-handler.js");

    const runner = new Runner({ providers: { p: { baseUrl: "", apiKey: "k", models: [{ id: "m" }] } }, defaultProvider: "p", defaultModel: "m" } as any, "p", "m");

    // this.escalationHandler = handler_old（空，无记录）
    const handlerOld = new EscalationHandler();
    (runner as unknown as { escalationHandler: EscalationHandler }).escalationHandler = handlerOld;

    // context handler = handler_new（fixer 实际用的，ask 记录写入这里）
    const handlerNew = new EscalationHandler(undefined, undefined, 50, 5);

    const input = {
      projectPath: ".",
      systemName: "test",
      version: "1.0",
      testTypes: ["unit" as const],
      diagnosis: { failedCases: [{ name: "TC1", layer: "unit", error: "err", category: "real-bug" as const }] },
    } as any;

    // 调 runFix 传 context handler = handlerNew
    const result = await runner.runFix(input, () => {}, undefined as any, { escalationHandler: handlerNew });

    // handlerNew 有 fixer escalate 记录（mock 的 runFixByDiagnosis 往 handlerNew 写了一条 ask）
    // 但 ask 可能超时降级（50ms），等一下确保记录写入
    await new Promise((r) => setTimeout(r, 60));
    expect(handlerNew.getRecords().length).toBeGreaterThan(0); // handlerNew 有记录

    // 期望：result.report.escalations 应含 handlerNew 的记录（fixer 实际用的 handler）
    // 实际（bug）：从 this.escalationHandler（handlerOld 空）取 → escalations undefined 或空
    expect(result.report.escalations).toBeDefined(); // ← FAIL：实际 undefined（handlerOld 无记录）
    expect(result.report.escalations?.length).toBeGreaterThan(0); // ← FAIL
  });
});
