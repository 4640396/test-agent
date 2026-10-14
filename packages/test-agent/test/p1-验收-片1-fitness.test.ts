/**
 * P1 片1 独立验收 — Fitness-driven 失败重试（PRD 5.5 三场景 + 边界探针）
 *
 * 独立视角：不照抄 worker 内置 reviewer 的 fitness.test.ts 结论，自建场景构造
 * 与边界探针。重点验证：
 * 1. PRD 5.5 场景 A/B/C 的 PRD 原意（含多轮 0→40→80→100 收敛序列，非 worker 的单轮跳跃）
 * 2. 边界探针：K 可配、空/单点曲线、双指标方向相反、passRate 100% 后覆盖率仍提升、
 *    max-iterations、tokenCost=null、runFix 异常降级、abort
 * 3. 独立判断点：fitness 真在 agent loop 之外（runFitnessDrivenExecute 只外层编排，
 *    不改 runExecute/runFix 内部；runFix 异常被捕获降级，不破坏 loop）
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  evaluateFitness,
  makeCurvePoint,
  buildFitnessReport,
  type FitnessDecision,
} from "../src/core/fitness.js";
import type { FitnessCurvePoint, FitnessReport } from "../src/core/types.js";
import { Runner } from "../src/core/runner.js";
import type { AgentRunResult, AgentEvent, TestCase } from "../src/core/types.js";
import type { TaskInput } from "@cxmt/protocol";

// ---------------------------------------------------------------------------
// 纯函数边界探针：evaluateFitness / makeCurvePoint / buildFitnessReport
// ---------------------------------------------------------------------------

describe("[片1-验收] 纯函数边界探针", () => {
  it("K=1：单轮无正提升即停", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 3, 4, 50, p0); // improvement=false
    const d = evaluateFitness([p0, p1], 1);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(false);
    expect(d.stoppedReason).toBe("no-improvement");
  });

  it("K=5：需连续 5 轮无正提升才停（4 轮仍继续）", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const flats = [p0];
    let prev: FitnessCurvePoint = p0;
    for (let i = 1; i <= 4; i++) {
      const p = makeCurvePoint(i, 3, 4, 50, prev);
      flats.push(p);
      prev = p;
    }
    // 4 轮无正提升，K=5 → 继续
    expect(evaluateFitness(flats, 5).shouldStop).toBe(false);
    // 补第 5 轮 → 停
    const p5 = makeCurvePoint(5, 3, 4, 50, prev);
    flats.push(p5);
    const d = evaluateFitness(flats, 5);
    expect(d.shouldStop).toBe(true);
    expect(d.stoppedReason).toBe("no-improvement");
  });

  it("空 curve → shouldStop=false（无观测数据继续执行）", () => {
    const d = evaluateFitness([], 3);
    expect(d.shouldStop).toBe(false);
    expect(d.converged).toBe(false);
  });

  it("单点曲线（仅基线 iter=0，failed>0）→ 继续（不误判收敛）", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const d = evaluateFitness([p0], 3);
    expect(d.shouldStop).toBe(false);
    expect(d.converged).toBe(false);
  });

  it("双指标方向相反：passRate 升 + coverage 降 → improvement=true（任一正提升即继续）", () => {
    const p0 = makeCurvePoint(0, 3, 7, 80); // passRate≈30, coverage=80
    const p1 = makeCurvePoint(1, 5, 5, 70, p0); // passRate≈50(+20), coverage=70(-10)
    expect(p1.passRateDelta).toBeGreaterThan(0);
    expect(p1.coverageDelta).toBeLessThan(0);
    expect(p1.improvement).toBe(true);
    // 未收敛（failed>0），K=3，仅 1 轮 → 继续
    expect(evaluateFitness([p0, p1], 3).shouldStop).toBe(false);
  });

  it("双指标方向相反：passRate 降 + coverage 升 → improvement=true", () => {
    const p0 = makeCurvePoint(0, 5, 2, 50); // passRate≈71, coverage=50
    const p1 = makeCurvePoint(1, 4, 3, 65, p0); // passRate≈57(-14), coverage=65(+15)
    expect(p1.passRateDelta).toBeLessThan(0);
    expect(p1.coverageDelta).toBeGreaterThan(0);
    expect(p1.improvement).toBe(true);
  });

  it("双指标全降（passRate 降 + coverage 降）→ improvement=false", () => {
    const p0 = makeCurvePoint(0, 5, 2, 80);
    const p1 = makeCurvePoint(1, 4, 3, 70, p0);
    expect(p1.passRateDelta).toBeLessThan(0);
    expect(p1.coverageDelta).toBeLessThan(0);
    expect(p1.improvement).toBe(false);
  });

  it("边界探针-passRate100%后覆盖率仍提升：达标即停（PRD 场景A 权威，no-failures）", () => {
    // failed=0 即 passRate=100%。PRD 场景A「达标即停，不多跑」为权威，
    // 实现在 failed<=0 时立即停（no-failures），不因覆盖率仍可提升而继续。
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 7, 0, 60, p0); // 全过，覆盖率 60（未达任意 target）
    const p2 = makeCurvePoint(2, 7, 0, 90, p1); // 假设继续，覆盖率仍提升
    // 第 1 轮已 failed=0 → 立即停
    const d1 = evaluateFitness([p0, p1], 3);
    expect(d1.shouldStop).toBe(true);
    expect(d1.converged).toBe(true);
    expect(d1.stoppedReason).toBe("no-failures");
    // 即便强行喂到第 2 轮，依然 no-failures（不会因覆盖率提升而"继续"）
    const d2 = evaluateFitness([p0, p1, p2], 3);
    expect(d2.shouldStop).toBe(true);
    expect(d2.stoppedReason).toBe("no-failures");
  });

  it("基线 iter=0 的 improvement=false 不计入连续无提升轮数", () => {
    // 基线无 prev → delta=0 → improvement=false，但 iter=0 应被跳过
    const p0 = makeCurvePoint(0, 3, 4, 50); // improvement=false（基线）
    const p1 = makeCurvePoint(1, 4, 3, 55, p0); // improvement=true
    const p2 = makeCurvePoint(2, 4, 3, 55, p1); // improvement=false（1 轮）
    // K=1：仅 1 轮无正提升 → 停（基线不算）
    const d = evaluateFitness([p0, p1, p2], 1);
    expect(d.shouldStop).toBe(true);
    expect(d.stoppedReason).toBe("no-improvement");
  });

  it("buildFitnessReport：tokenCost=null 路径显式写入 null", () => {
    const curve = [makeCurvePoint(0, 5, 0, 100)];
    const decision = evaluateFitness(curve, 3);
    const report = buildFitnessReport(curve, 3, 0, decision, null);
    expect(report.tokenCost).toBeNull();
    expect(report.converged).toBe(true);
  });

  it("buildFitnessReport：tokenCost=undefined 时字段缺省（不出现 null）", () => {
    const curve = [makeCurvePoint(0, 5, 0, 100)];
    const decision = evaluateFitness(curve, 3);
    const report = buildFitnessReport(curve, 3, 0, decision);
    expect(report.tokenCost).toBeUndefined();
  });

  it("判停优先级：no-failures > converged(coverage达标)", () => {
    // failed=0 且 coverage 也达标 → 应取 no-failures（优先级更高）
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 7, 0, 90, p0);
    const d = evaluateFitness([p0, p1], 3, 80);
    expect(d.stoppedReason).toBe("no-failures");
  });

  it("判停优先级：coverage 达标（failed>0）→ converged", () => {
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 4, 3, 85, p0); // failed=3 仍 >0，但 coverage≥80
    const d = evaluateFitness([p0, p1], 3, 80);
    expect(d.shouldStop).toBe(true);
    expect(d.converged).toBe(true);
    expect(d.stoppedReason).toBe("converged");
  });
});

// ---------------------------------------------------------------------------
// runFitnessDrivenExecute — 独立 mock 测试（验证外层编排 + loop 之外）
// ---------------------------------------------------------------------------

interface MockRunnerHarness {
  runner: Runner;
  setFixThrowAt(iter: number): void;
}

function createMockRunner(executeSequence: AgentRunResult[]): MockRunnerHarness {
  const runner = new Runner({ providers: {} } as never, undefined, undefined, undefined);
  let executeCall = 0;
  let fixCall = 0;
  let fixThrowAt: number | undefined;
  runner.runExecute = async function (
    _input: TaskInput,
    _cases: TestCase[],
    _emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
    _context?: unknown,
  ): Promise<AgentRunResult> {
    executeCall++;
    const result = executeSequence[executeCall - 1] ?? executeSequence[executeSequence.length - 1];
    return { ...result };
  };
  runner.runFix = async function (
    _input: TaskInput,
    _emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    fixCall++;
    if (fixThrowAt !== undefined && fixCall === fixThrowAt) {
      throw new Error("模拟修复工具异常");
    }
    return { phase: "fix", report: { passed: 0, failed: 0, coverage: null }, lanes: [], artifacts: [] };
  };
  return {
    runner,
    setFixThrowAt(iter: number) {
      fixThrowAt = iter;
    },
  };
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

function failedCase(category = "test-defect"): unknown {
  return { name: "c1", layer: "unit", error: "err", category, confidence: "low" };
}

describe("[片1-验收] runFitnessDrivenExecute — PRD 5.5 场景（独立构造）", () => {
  beforeEach(() => {
    delete process.env.TEST_AGENT_FITNESS_K;
    delete process.env.TEST_AGENT_FITNESS_MAX_ITER;
  });
  afterEach(() => {
    delete process.env.TEST_AGENT_FITNESS_K;
    delete process.env.TEST_AGENT_FITNESS_MAX_ITER;
  });

  it("场景A：0→40→80→100 多轮收敛，达标即停不多跑（PRD 原意）", async () => {
    // 基线 0% → 43% → 86% → 100%（7 用例）
    const { runner } = createMockRunner([
      makeResult(0, 7, 30, [failedCase()]),
      makeResult(3, 4, 45, [failedCase()]),  // iter1: +43% passRate
      makeResult(6, 1, 70, [failedCase()]),  // iter2: +43% passRate
      makeResult(7, 0, 85),                   // iter3: 全过 → no-failures 停
    ]);
    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.converged).toBe(true);
    expect(f.stoppedReason).toBe("no-failures");
    expect(f.iterations).toBe(3);
    expect(f.curve).toHaveLength(4); // 基线 + 3 轮
    expect(f.message).toContain("收敛");
    // 收敛后不多跑：最终通过率 100%
    expect(result.report.passed).toBe(7);
    expect(result.report.failed).toBe(0);
  });

  it("场景B：0→10→10→10→10 连续 K=3 无正提升即停，诚实标记需人工", async () => {
    // 基线 10% → 3 轮均 10% 无提升
    const { runner } = createMockRunner([
      makeResult(1, 9, 40, [failedCase()]),
      makeResult(1, 9, 40, [failedCase()]),
      makeResult(1, 9, 40, [failedCase()]),
      makeResult(1, 9, 40, [failedCase()]),
    ]);
    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.converged).toBe(false);
    expect(f.stoppedReason).toBe("no-improvement");
    expect(f.message).toContain("需人工");
    expect(f.iterations).toBe(3);
    expect(f.curve).toHaveLength(4);
    // 诚实标记：不假装成功（converged=false，message 不是"成功"）
    expect(f.message).not.toMatch(/成功/);
    // 曲线完整可见
    expect(f.curve.every((p) => typeof p.passRate === "number")).toBe(true);
  });

  it("场景C：fitness 报告结构完整（迭代轮次 + 目标函数曲线 + 全字段）", async () => {
    const { runner } = createMockRunner([
      makeResult(5, 2, 70, [failedCase()]),
      makeResult(7, 0, 90),
    ]);
    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    // FitnessReport 顶层字段
    expect(typeof f.iterations).toBe("number");
    expect(typeof f.k).toBe("number");
    expect(typeof f.converged).toBe("boolean");
    expect(["converged", "no-improvement", "max-iterations", "no-failures"]).toContain(f.stoppedReason);
    expect(typeof f.message).toBe("string");
    expect(Array.isArray(f.curve)).toBe(true);
    // FitnessCurvePoint 每个字段
    for (const pt of f.curve) {
      expect(typeof pt.iter).toBe("number");
      expect(typeof pt.passed).toBe("number");
      expect(typeof pt.failed).toBe("number");
      expect(pt.coverage === null || typeof pt.coverage === "number").toBe(true);
      expect(typeof pt.passRate).toBe("number");
      expect(typeof pt.passRateDelta).toBe("number");
      expect(typeof pt.coverageDelta).toBe("number");
      expect(typeof pt.improvement).toBe("boolean");
    }
  });
});

describe("[片1-验收] runFitnessDrivenExecute — 边界探针", () => {
  beforeEach(() => {
    delete process.env.TEST_AGENT_FITNESS_K;
    delete process.env.TEST_AGENT_FITNESS_MAX_ITER;
  });
  afterEach(() => {
    delete process.env.TEST_AGENT_FITNESS_K;
    delete process.env.TEST_AGENT_FITNESS_MAX_ITER;
  });

  it("max-iterations 边界：每轮覆盖率提升但永不收敛 → max-iterations 停", async () => {
    process.env.TEST_AGENT_FITNESS_MAX_ITER = "2";
    process.env.TEST_AGENT_FITNESS_K = "20"; // 拉高 K 确保不是 no-improvement 先触发
    // 每轮 coverage 微升但 failed 恒 >0，永不收敛
    const seq: AgentRunResult[] = [];
    for (let i = 0; i <= 5; i++) {
      seq.push(makeResult(3, 4, 50 + i, [failedCase()]));
    }
    const { runner } = createMockRunner(seq);
    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.stoppedReason).toBe("max-iterations");
    expect(f.converged).toBe(false);
    expect(f.message).toContain("需人工");
    expect(f.iterations).toBe(2);
  });

  it("K=1：单轮无正提升即停（环境变量可配）", async () => {
    process.env.TEST_AGENT_FITNESS_K = "1";
    const { runner } = createMockRunner([
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]), // iter1 无提升 → K=1 停
    ]);
    const result = await runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.stoppedReason).toBe("no-improvement");
    expect(f.iterations).toBe(1);
  });

  it("独立判断点：runFix 异常被捕获降级，不破坏 loop，仍产出 fitness 报告", async () => {
    // 第 1 轮 runFix 抛错 → 应被捕获，继续 retest；retest 仍失败 → 后续无提升停
    const harness = createMockRunner([
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]),
    ]);
    harness.setFixThrowAt(1);
    // 不应抛错
    const result = await harness.runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f).toBeDefined();
    expect(f.converged).toBe(false);
    expect(f.curve.length).toBeGreaterThanOrEqual(2);
  });

  it("独立判断点：abort 信号 → 抛『任务已取消』", async () => {
    const { runner } = createMockRunner([
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]),
    ]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit, ac.signal),
    ).rejects.toThrow(/已取消/);
  });

  it("独立判断点：基线无失败 → 直接收敛，不进 fix 循环（iterations=0）", async () => {
    const harness = createMockRunner([makeResult(7, 0, 90)]);
    const result = await harness.runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.converged).toBe(true);
    expect(f.stoppedReason).toBe("no-failures");
    expect(f.iterations).toBe(0);
    expect(f.curve).toHaveLength(1); // 仅基线
  });

  it("coverageTarget 来自 input.coverageTarget：覆盖率达标即收敛", async () => {
    const input: TaskInput = { ...baseInput, coverageTarget: 75 };
    // 基线 coverage=50, iter1 coverage=80 ≥75 但 failed 仍 >0 → converged(coverage)
    const { runner } = createMockRunner([
      makeResult(4, 3, 50, [failedCase()]),
      makeResult(5, 2, 80, [failedCase()]),
    ]);
    const result = await runner.runFitnessDrivenExecute!(input, mockCases, noopEmit);
    const f = result.report.fitness!;
    expect(f.converged).toBe(true);
    expect(f.stoppedReason).toBe("converged");
    expect(f.iterations).toBe(1);
  });

  it("诚实标记：未收敛时 message 含『需人工』且 converged=false（三种未收敛原因）", async () => {
    // no-improvement
    process.env.TEST_AGENT_FITNESS_K = "1";
    const r1 = createMockRunner([
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 50, [failedCase()]),
    ]);
    const f1 = (await r1.runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit)).report.fitness!;
    expect(f1.converged).toBe(false);
    expect(f1.message).toContain("需人工");

    // max-iterations
    process.env.TEST_AGENT_FITNESS_K = "20";
    process.env.TEST_AGENT_FITNESS_MAX_ITER = "1";
    const r2 = createMockRunner([
      makeResult(3, 4, 50, [failedCase()]),
      makeResult(3, 4, 51, [failedCase()]), // 覆盖率提升，improvement=true，但未收敛
    ]);
    const f2 = (await r2.runner.runFitnessDrivenExecute!(baseInput, mockCases, noopEmit)).report.fitness!;
    expect(f2.converged).toBe(false);
    expect(f2.message).toContain("需人工");
  });
});

// ---------------------------------------------------------------------------
// GUI 侧数据契约（片1 场景C：fitness 报告 GUI 可见）
// ---------------------------------------------------------------------------

describe("[片1-验收] GUI 数据契约（types 对齐）", () => {
  it("FitnessReport 结构满足 GUI 渲染所需（迭代轮次 + 曲线 + 收敛标记）", () => {
    // 构造一个典型未收敛报告，校验 GUI 侧可读字段齐备
    const p0 = makeCurvePoint(0, 3, 4, 50);
    const p1 = makeCurvePoint(1, 3, 4, 50, p0);
    const decision: FitnessDecision = evaluateFitness([p0, p1], 1);
    const report: FitnessReport = buildFitnessReport([p0, p1], 1, 1, decision, null);
    // GUI 需要的关键字段
    expect(report).toHaveProperty("iterations");
    expect(report).toHaveProperty("converged");
    expect(report).toHaveProperty("stoppedReason");
    expect(report).toHaveProperty("message");
    expect(report).toHaveProperty("curve");
    expect(report).toHaveProperty("tokenCost");
    // 曲线点 GUI 画趋势需要：iter + passRate + coverage
    expect(report.curve[1]).toHaveProperty("iter");
    expect(report.curve[1]).toHaveProperty("passRate");
    expect(report.curve[1]).toHaveProperty("coverage");
  });
});
