import { describe, expect, it } from "vitest";
import { evaluateFitness, makeCurvePoint, buildFitnessReport } from "../src/core/fitness.js";
import type { FitnessCurvePoint } from "../src/core/types.js";
import { Runner } from "../src/core/runner.js";
import type { AgentRunResult, AgentEvent, TestCase } from "../src/core/types.js";
import type { TaskInput } from "@cxmt/protocol";

// ---------------------------------------------------------------------------
// evaluateFitness 纯函数单测
// ---------------------------------------------------------------------------

describe("evaluateFitness — 纯函数", () => {
  it("无失败用例时 converged=true, stoppedReason='no-failures'", () => {
  const curve: FitnessCurvePoint[] = [
      makeCurvePoint(0, 5, 2, 60),   // 基线：5 过 2 失
      makeCurvePoint(1, 7, 0, 80, makeCurvePoint(0, 5, 2, 60)),  // 修完：全过
    ];
    const d = evaluateFitness(curve, 3);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(true);
    expect(d.stoppedReason).toBe("no-failures");
  });

  it("通过率达 100% 时 converged=true, stoppedReason='no-failures'（全过即停）", () => {
    const base = makeCurvePoint(0, 3, 4, 50);
    const curve: FitnessCurvePoint[] = [
      base,
      makeCurvePoint(1, 7, 0, 70, base),
    ];
    const d = evaluateFitness(curve, 3);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(true);
    // passRate=100 等价于无失败，优先匹配 no-failures
    expect(d.stoppedReason).toBe("no-failures");
  });

  it("coverage 达 coverageTarget 时 converged=true, stoppedReason='converged'", () => {
    const base = makeCurvePoint(0, 3, 4, 50);
    const curve: FitnessCurvePoint[] = [
      base,
      makeCurvePoint(1, 4, 3, 85, base),
    ];
    const d = evaluateFitness(curve, 3, 80);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(true);
    expect(d.stoppedReason).toBe("converged");
  });

  it("场景B：连续 K 轮无正提升即停，converged=false，message 含『需人工』", () => {
    // 基线 3 过 4 失，之后 3 轮均无正提升（通过率和覆盖率都没变）
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 3, 4, 50, p0);  // improvement=false
    const p2 = makeCurvePoint(2, 3, 4, 50, p1);  // improvement=false
    const p3 = makeCurvePoint(3, 3, 4, 50, p2);  // improvement=false
    const curve = [p0, p1, p2, p3];
    const d = evaluateFitness(curve, 3);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(false);
    expect(d.stoppedReason).toBe("no-improvement");
    expect(d.message).toContain("需人工");
  });

  it("有正提升时继续迭代（shouldStop=false）", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 4, 3, 55, p0);  // improvement=true
    const p2 = makeCurvePoint(2, 4, 3, 55, p1);  // improvement=false (1 轮)
    const curve = [p0, p1, p2];
    const d = evaluateFitness(curve, 3);
    expect(d.shouldStop).toBe(false);
  });

  it("coverage 正提升但 passRate 不变 → improvement=true", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 3, 4, 60, p0);  // passRateDelta=0, coverageDelta=10 → improvement=true
    expect(p1.improvement).toBe(true);
  });

  it("空 curve → shouldStop=false", () => {
    const d = evaluateFitness([], 3);
    expect(d.shouldStop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFitnessReport — 场景C：fitness 报告字段完整可见
// ---------------------------------------------------------------------------

describe("buildFitnessReport — 报告字段完整性", () => {
  it("场景C：产出完整 fitness 字段结构", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 7, 0, 80, p0);
    const curve = [p0, p1];
    const decision = evaluateFitness(curve, 3);
    const report = buildFitnessReport(curve, 3, 1, decision, null);

    expect(report.iterations).toBe(1);
    expect(report.k).toBe(3);
    expect(report.converged).toBe(true);
    expect(report.stoppedReason).toBe("no-failures");
    expect(report.message).toContain("收敛");
    expect(report.curve).toHaveLength(2);
    expect(report.curve[0].iter).toBe(0);
    expect(report.curve[1].iter).toBe(1);
    expect(report.curve[1].improvement).toBe(true);
    expect(report.tokenCost).toBeNull();
  });

  it("带 tokenCost 时正确写入", () => {
    const curve = [makeCurvePoint(0, 5, 0, 100)];
    const decision = evaluateFitness(curve, 3);
    const report = buildFitnessReport(curve, 3, 0, decision, { input: 1000, output: 500, total: 1500 });
    expect(report.tokenCost).toEqual({ input: 1000, output: 500, total: 1500 });
  });
});

// ---------------------------------------------------------------------------
// runFitnessDrivenExecute — mock 测试（mock runExecute/runFix 产出可控通过率序列）
// ---------------------------------------------------------------------------

/** 创建带 mock runExecute/runFix 的 Runner 实例。 */
function createMockRunner(executeSequence: AgentRunResult[], fixResults?: AgentRunResult[]): Runner {
  const runner = new Runner(
    { providers: {} } as never,  // 不实际使用 config——runExecute/runFix 被 mock
    undefined,
    undefined,
    undefined,
  );
  let executeCall = 0;
  let fixCall = 0;
  runner.runExecute = async function (
    _input: TaskInput,
    _cases: TestCase[],
    _emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
    _context?: unknown,
  ): Promise<AgentRunResult> {
    const result = executeSequence[executeCall] ?? executeSequence[executeSequence.length - 1];
    executeCall++;
    return { ...result };
  };
  runner.runFix = async function (
    _input: TaskInput,
    _emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const result = fixResults?.[fixCall] ?? { phase: "fix", report: { passed: 0, failed: 0, coverage: null }, lanes: [], artifacts: [] };
    fixCall++;
    return { ...result };
  };
  return runner;
}

function makeResult(passed: number, failed: number, coverage: number | null, failedCases?: unknown[]): AgentRunResult {
  return {
    lanes: [],
    report: {
      passed,
      failed,
      coverage,
      ...(failedCases ? { failedCases: failedCases as never } : {}),
    },
    artifacts: [],
  };
}

const noopEmit = (_event: AgentEvent): void => {};

const baseInput: TaskInput = {
  projectPath: "/tmp/mock-project",
  systemName: "mock",
  version: "1.0",
  testTypes: ["unit"],
};

const mockCases: TestCase[] = [
  { id: "TC001", title: "case1", scenario: "", steps: [], expected: "", priority: "medium", layer: "unit" },
];

describe("runFitnessDrivenExecute — mock 测试", () => {
  it("场景A：收敛后停止，达标即停不多跑", async () => {
    // execute 序列：基线 3 过 4 失 → 修完后 7 过 0 失（全过收敛）
    const runner = createMockRunner([
      makeResult(3, 4, 50, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]),
      makeResult(7, 0, 80),
    ]);

    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);

    expect(result.report.fitness).toBeDefined();
    expect(result.report.fitness!.converged).toBe(true);
    expect(result.report.fitness!.stoppedReason).toBe("no-failures");
    expect(result.report.fitness!.iterations).toBe(1);
    // 曲线：基线 + 1 轮
    expect(result.report.fitness!.curve).toHaveLength(2);
    // 收敛后不应多跑——execute 只被调 2 次（基线 + 1 轮重测）
    expect(result.report.passed).toBe(7);
    expect(result.report.failed).toBe(0);
  });

  it("场景B：未收敛停止，连续 3 轮无正提升即停，converged=false，message 含『需人工』", async () => {
    // 基线 3 过 4 失，之后 3 轮均无改善（通过率/覆盖率不变）
  const runner = createMockRunner([
      makeResult(3, 4, 50, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]),
      makeResult(3, 4, 50, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]),
      makeResult(3, 4, 50, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]),
      makeResult(3, 4, 50, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]),
    ]);

    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);

    expect(result.report.fitness).toBeDefined();
    expect(result.report.fitness!.converged).toBe(false);
    expect(result.report.fitness!.stoppedReason).toBe("no-improvement");
    expect(result.report.fitness!.message).toContain("需人工");
    // 基线 + 3 轮 = 4 个观测点
    expect(result.report.fitness!.curve).toHaveLength(4);
    expect(result.report.fitness!.iterations).toBe(3);
  });

  it("场景C：fitness 报告字段完整可见", async () => {
  const runner = createMockRunner([
      makeResult(5, 0, 90),
    ]);

    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);

    const fitness = result.report.fitness!;
    expect(fitness).toBeDefined();
    expect(fitness.iterations).toBe(0);
    expect(fitness.k).toBe(3);
    expect(fitness.converged).toBe(true);
    expect(fitness.stoppedReason).toBe("no-failures");
    expect(typeof fitness.message).toBe("string");
    expect(Array.isArray(fitness.curve)).toBe(true);
    expect(fitness.curve.length).toBeGreaterThanOrEqual(1);
    expect(fitness.curve[0]).toHaveProperty("iter");
    expect(fitness.curve[0]).toHaveProperty("passed");
    expect(fitness.curve[0]).toHaveProperty("failed");
    expect(fitness.curve[0]).toHaveProperty("coverage");
    expect(fitness.curve[0]).toHaveProperty("passRate");
    expect(fitness.curve[0]).toHaveProperty("passRateDelta");
    expect(fitness.curve[0]).toHaveProperty("coverageDelta");
    expect(fitness.curve[0]).toHaveProperty("improvement");
  });

  it("maxIterations 上限防失控：未收敛时 stoppedReason='max-iterations'", async () => {
    process.env.TEST_AGENT_FITNESS_MAX_ITER = "2";
    process.env.TEST_AGENT_FITNESS_K = "10"; // 设高 K 确保不是 no-improvement 先触发
    try {
      // 每轮都有微小覆盖率提升（improvement=true），但永远不收敛
      const results: AgentRunResult[] = [];
      for (let i = 0; i <= 5; i++) {
        results.push(makeResult(3, 4, 50 + i, [{ name: "c1", layer: "unit", error: "err", category: "test-defect", confidence: "low" }]));
      }
      const runner = createMockRunner(results);

      const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);

      expect(result.report.fitness!.stoppedReason).toBe("max-iterations");
      expect(result.report.fitness!.converged).toBe(false);
      expect(result.report.fitness!.message).toContain("需人工");
      expect(result.report.fitness!.iterations).toBe(2);
    } finally {
      delete process.env.TEST_AGENT_FITNESS_MAX_ITER;
      delete process.env.TEST_AGENT_FITNESS_K;
    }
  });
});
