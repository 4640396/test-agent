/**
 * Coordinator tester fan-out 测试（切片 2：tester 内部 pi-subagents runs.all fan-out）。
 *
 * 照 pi-subagents runs.all fanout（SKILL.md:35/42/97）：多 testTypes 时 Promise.all 并行子代理，
 * 单 testTypes 向后兼容走现有 runExecute。
 *
 * 用 mock adapter 验证：
 * 1. 多 testTypes → runExecute 被调用 N 次（每 testType 一次），Promise.all 并行
 * 2. 单 testTypes → runExecute 被调用 1 次（向后兼容）
 * 3. 并行隔离：每子代理独立 outputDirectorySuffix（testType 后缀）
 * 4. cases 按 layer 过滤（regression 跑全部）
 * 5. aggregateTesterResults 合并 pass/fail/coverage/lanes/cases/artifacts
 */

import { describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/core/coordinator.js";
import type { AgentAdapter, AgentEvent, AgentRunContext, AgentRunResult, PlanResult, ScoutResult, TestCase } from "../src/core/types.js";
import type { TaskInput, TestType } from "@cxmt/protocol";

/** mock adapter：记录 runExecute 调用参数，返回可控结果。 */
function createMockAdapter(
  runExecuteImpl?: (input: TaskInput, cases: TestCase[], context?: AgentRunContext) => AgentRunResult,
): AgentAdapter & { runExecuteCalls: Array<{ input: TaskInput; cases: TestCase[]; context?: AgentRunContext }> } {
  const runExecuteCalls: Array<{ input: TaskInput; cases: TestCase[]; context?: AgentRunContext }> = [];
  const adapter: AgentAdapter = {
    name: "mock",
    async run(_input, emit) {
      emit({ type: "log", level: "info", message: "mock run" });
      return { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] };
    },
    async runScout(_input): Promise<ScoutResult> {
      return { report: "mock scout report", artifacts: [] };
    },
    async runCaseDesign(_input, _scoutReport): Promise<PlanResult> {
      return {
        phase: "plan",
        cases: [
          { id: "c1", title: "unit test 1", scenario: "unit", steps: [], expected: "", priority: "medium", layer: "unit" },
          { id: "c2", title: "api test 1", scenario: "api", steps: [], expected: "", priority: "medium", layer: "api" },
          { id: "c3", title: "ui test 1", scenario: "ui", steps: [], expected: "", priority: "medium", layer: "ui" },
        ],
        artifacts: [],
      };
    },
    async runExecute(input, cases, _emit, _signal, context): Promise<AgentRunResult> {
      runExecuteCalls.push({ input, cases, context });
      if (runExecuteImpl) return runExecuteImpl(input, cases, context);
      return { phase: "execute", lanes: [], report: { passed: 1, failed: 0, coverage: 80 }, artifacts: [], cases };
    },
  };
  return Object.assign(adapter, { runExecuteCalls });
}

function makeInput(testTypes: TestType[]): TaskInput {
  return {
    projectPath: "/tmp/mock-project",
    systemName: "test-sys",
    version: "1.0.0",
    testTypes,
  };
}

function emit(_event: AgentEvent) {
  // no-op
}

describe("Coordinator tester fan-out（切片 2）", () => {
  it("多 testTypes 时 fan-out：runExecute 被调用 N 次，每 testType 一次", async () => {
    const adapter = createMockAdapter((input, cases) => ({
      phase: "execute",
      lanes: [{ type: input.testTypes[0], status: "passed", summary: `${cases.length} cases` }],
      report: { passed: cases.length, failed: 0, coverage: 80 },
      artifacts: [`art-${input.testTypes[0]}`],
      cases,
    }));
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api", "ui"]);

    const result = await coordinator.run(input, emit);

    // 3 testTypes → 3 runExecute 调用
    expect(adapter.runExecuteCalls).toHaveLength(3);
    // 每 testType 一次
    const calledTestTypes = adapter.runExecuteCalls.map((c) => c.input.testTypes[0]);
    expect(calledTestTypes).toContain("unit");
    expect(calledTestTypes).toContain("api");
    expect(calledTestTypes).toContain("ui");
    // 聚合后 pass = 1 (unit) + 1 (api) + 1 (ui) = 3（每子代理 1 case）
    expect(result.report.passed).toBe(3);
    expect(result.report.failed).toBe(0);
    expect(result.report.coverage).toBe(80);
    expect(result.lanes).toHaveLength(3);
    expect(result.artifacts).toContain("art-unit");
    expect(result.artifacts).toContain("art-api");
    expect(result.artifacts).toContain("art-ui");
  });

  it("多 testTypes 时 cases 按 layer 过滤：每子代理只跑匹配 layer 的用例", async () => {
    const adapter = createMockAdapter((_input, cases) => ({
      phase: "execute",
      lanes: [],
      report: { passed: cases.length, failed: 0, coverage: null },
      artifacts: [],
      cases,
    }));
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api"]);

    await coordinator.run(input, emit);

    expect(adapter.runExecuteCalls).toHaveLength(2);
    const unitCall = adapter.runExecuteCalls.find((c) => c.input.testTypes[0] === "unit");
    const apiCall = adapter.runExecuteCalls.find((c) => c.input.testTypes[0] === "api");
    expect(unitCall?.cases).toHaveLength(1);
    expect(unitCall?.cases[0].layer).toBe("unit");
    expect(apiCall?.cases).toHaveLength(1);
    expect(apiCall?.cases[0].layer).toBe("api");
  });

  it("多 testTypes 时并行隔离：每子代理独立 outputDirectorySuffix", async () => {
    const adapter = createMockAdapter();
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api", "ui"]);

    await coordinator.run(input, emit);

    expect(adapter.runExecuteCalls).toHaveLength(3);
    const suffixes = adapter.runExecuteCalls.map((c) => c.context?.outputDirectorySuffix);
    expect(suffixes).toContain("unit");
    expect(suffixes).toContain("api");
    expect(suffixes).toContain("ui");
    // 所有后缀互不重复
    expect(new Set(suffixes).size).toBe(3);
  });

  it("regression testType 跑全部用例（不按 layer 过滤，含 regression 只跑 regression 子代理不 fan-out）", async () => {
    const adapter = createMockAdapter((_input, cases) => ({
      phase: "execute",
      lanes: [],
      report: { passed: cases.length, failed: 0, coverage: null },
      artifacts: [],
      cases,
    }));
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["regression", "unit"]);

    await coordinator.run(input, emit);

    // 含 regression 时只跑 regression 子代理（跑全部 cases），不 fan-out 其他 testTypes 防用例重复
    expect(adapter.runExecuteCalls).toHaveLength(1);
    const regressionCall = adapter.runExecuteCalls[0];
    expect(regressionCall.input.testTypes[0]).toBe("regression");
    // regression 跑全部 3 条用例
    expect(regressionCall.cases).toHaveLength(3);
  });

  it("单 testTypes 向后兼容：走现有 runExecute（1 次调用，不 fan-out）", async () => {
    const adapter = createMockAdapter((_input, cases) => ({
      phase: "execute",
      lanes: [{ type: "unit", status: "passed", summary: "ok" }],
      report: { passed: 1, failed: 0, coverage: 90 },
      artifacts: ["art"],
      cases,
    }));
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit"]);

    const result = await coordinator.run(input, emit);

    // 单 testTypes → 1 次 runExecute 调用（不 fan-out）
    expect(adapter.runExecuteCalls).toHaveLength(1);
    expect(adapter.runExecuteCalls[0].input.testTypes).toEqual(["unit"]);
    // 无 outputDirectorySuffix（单 testTypes 不需要并行隔离）
    expect(adapter.runExecuteCalls[0].context?.outputDirectorySuffix).toBeUndefined();
    expect(result.report.passed).toBe(1);
    expect(result.report.coverage).toBe(90);
  });

  it("aggregateTesterResults：pass/fail 相加，coverage 取均值", async () => {
    const adapter = createMockAdapter((input, cases) => {
      const tt = input.testTypes[0];
      // unit: pass=2, fail=1, coverage=80
      // api:  pass=1, fail=0, coverage=100
      if (tt === "unit") {
        return { phase: "execute", lanes: [], report: { passed: 2, failed: 1, coverage: 80 }, artifacts: ["a1"], cases };
      }
      return { phase: "execute", lanes: [], report: { passed: 1, failed: 0, coverage: 100 }, artifacts: ["a2"], cases };
    });
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api"]);

    const result = await coordinator.run(input, emit);

    expect(result.report.passed).toBe(3); // 2+1
    expect(result.report.failed).toBe(1); // 1+0
    expect(result.report.coverage).toBe(90); // (80+100)/2
    expect(result.artifacts).toContain("a1");
    expect(result.artifacts).toContain("a2");
  });

  it("aggregateTesterResults：coverage 全 null 时返回 null", async () => {
    const adapter = createMockAdapter((_input, cases) => ({
      phase: "execute",
      lanes: [],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: [],
      cases,
    }));
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api"]);

    const result = await coordinator.run(input, emit);

    expect(result.report.coverage).toBeNull();
  });

  it("aggregateTesterResults：合并 failedCases + escalations", async () => {
    const adapter = createMockAdapter((input, _cases) => {
      const tt = input.testTypes[0];
      if (tt === "unit") {
        return {
          phase: "execute",
          lanes: [],
          report: {
            passed: 0,
            failed: 1,
            coverage: null,
            failedCases: [{ name: "unit fail", layer: "unit", error: "err", category: "real-bug", confidence: "high", evidence: "e", suggestion: "s" }],
            escalations: [{ id: "esc1", role: "tester", question: "q", fallback: "f", timestamp: new Date().toISOString(), status: "replied", answer: "a" }],
          },
          artifacts: [],
          cases: [],
        };
      }
      return { phase: "execute", lanes: [], report: { passed: 1, failed: 0, coverage: null }, artifacts: [], cases: [] };
    });
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api"]);

    const result = await coordinator.run(input, emit);

    expect(result.report.failedCases).toHaveLength(1);
    expect(result.report.failedCases?.[0].name).toBe("unit fail");
    expect(result.report.escalations).toHaveLength(1);
  });

  it("无用例匹配的子代理返回空结果，不阻塞其他子代理", async () => {
    // 只有 unit 用例，但 fan-out 含 api/ui → api/ui 子代理无用例
    const adapter: AgentAdapter & { runExecuteCalls: Array<{ cases: TestCase[] }> } = {
      name: "mock",
      async run() { return { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] }; },
      async runScout() { return { report: "scout", artifacts: [] }; },
      async runCaseDesign(): Promise<PlanResult> {
        return {
          phase: "plan",
          cases: [{ id: "c1", title: "unit only", scenario: "unit", steps: [], expected: "", priority: "medium", layer: "unit" }],
          artifacts: [],
        };
      },
      async runExecute(_input, cases, _emit, _signal, _context): Promise<AgentRunResult> {
        (adapter as any).runExecuteCalls.push({ cases });
        return { phase: "execute", lanes: [], report: { passed: cases.length, failed: 0, coverage: null }, artifacts: [], cases };
      },
      runExecuteCalls: [],
    };
    const coordinator = new Coordinator(adapter);
    const input = makeInput(["unit", "api", "ui"]);

    const result = await coordinator.run(input, emit);

    // 只有 unit 有匹配用例 → 只调用 1 次 runExecute（api/ui 无用例跳过）
    expect(adapter.runExecuteCalls).toHaveLength(1);
    // 聚合后 pass = 1 (unit only)
    expect(result.report.passed).toBe(1);
  });
});
