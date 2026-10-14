import { describe, expect, it } from "vitest";
import { evaluateQualityGate, finalizeQualityGate } from "../src/core/quality-gate.js";
import type { AgentRunResult } from '../src/core/types.js'
import type { FailedCaseRecord, DiagnosisCategory } from "../src/core/types.js";
import type { FlakyRecord } from "../src/core/flaky.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeFailedCase(name: string, category: DiagnosisCategory = "real-bug"): FailedCaseRecord {
  return {
    name,
    layer: "unit",
    error: `error for ${name}`,
    category,
    confidence: "low",
    evidence: "test evidence",
  };
}

function makeFlakyRecord(caseId: string, caseTitle: string, isFlaky: boolean): FlakyRecord {
  return {
    caseId,
    caseTitle,
    isFlaky,
    reason: isFlaky ? "5 次重跑 2 过 3 失" : "not flaky",
    rerunResults: isFlaky ? [true, false, true, false, false] : [true, true, true, true, true],
    rerunPassRate: isFlaky ? 0.4 : 1.0,
    historyPassRate: 0.7,
    historyCount: 10,
    suspiciousReasons: ["诊断标记 flaky"],
  };
}

// ---------------------------------------------------------------------------
// evaluateQualityGate — PRD 6.5 场景 C
// ---------------------------------------------------------------------------

describe("evaluateQualityGate", () => {
  it("场景C（精确）: 50 用例，3 flaky（1 失败），无其他失败 → 门禁通过", () => {
  const totalCases = 50;
  // 只有 1 个失败，且是 flaky 用例
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("flaky-case-1", "flaky"),
  ];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "flaky-case-1", true),
    makeFlakyRecord("id-2", "flaky-case-2", true),
    makeFlakyRecord("id-3", "flaky-case-3", true),
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("passed");
  expect(result.flakyIsolated).toBe(3);
  expect(result.flakyFailed).toBe(1);
  expect(result.failed).toBe(0); // 非 flaky 失败 = 0
  // passed = 50 - 0 (non-flaky fail) - 3 (flaky isolated) = 47
  expect(result.passed).toBe(47);
  expect(result.summary).toContain("门禁通过");
  expect(result.summary).toContain("3 flaky 隔离");
  expect(result.summary).toContain("1 flaky 失败不计入");
  });

  it("场景C: flaky 隔离但有非 flaky 失败 → 门禁失败", () => {
  const totalCases = 50;
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("flaky-case-1", "flaky"),  // flaky 失败
    makeFailedCase("real-bug-1"),              // 非 flaky 失败
  ];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "flaky-case-1", true),
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("failed");
  expect(result.failed).toBe(1); // 1 非 flaky 失败
  expect(result.flakyFailed).toBe(1);
  expect(result.flakyIsolated).toBe(1);
  });

  it("无 flaky 用例 → 门禁按常规判定", () => {
  const totalCases = 10;
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("case-1"),
    makeFailedCase("case-2"),
  ];
  const flakyRecords: FlakyRecord[] = [];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("failed");
  expect(result.failed).toBe(2);
  expect(result.flakyIsolated).toBe(0);
  expect(result.flakyFailed).toBe(0);
  expect(result.passed).toBe(8); // 10 - 2 - 0 = 8
  });

  it("无失败 → 门禁通过", () => {
  const totalCases = 10;
  const failedCases: FailedCaseRecord[] = [];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "flaky-passed", true),
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("passed");
  expect(result.failed).toBe(0);
  expect(result.flakyIsolated).toBe(1);
  expect(result.flakyFailed).toBe(0);
  expect(result.passed).toBe(9); // 10 - 0 - 1 = 9
  });

  it("flaky 用例通过（不失败）→ 隔离但不计入 flaky 失败", () => {
  const totalCases = 10;
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("real-bug-1"),
  ];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "flaky-passed", true), // flaky 但本次通过
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("failed");
  expect(result.failed).toBe(1);
  expect(result.flakyIsolated).toBe(1);
  expect(result.flakyFailed).toBe(0); // flaky 用例本次没失败
  });

  it("flakyRecords 中非 flaky 的记录不计入隔离", () => {
  const totalCases = 10;
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("case-1"),
  ];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "case-1", false), // isFlaky=false → 不隔离
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.flakyIsolated).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.status).toBe("failed");
  });

  it("多个 flaky 失败都被隔离", () => {
  const totalCases = 20;
  const failedCases: FailedCaseRecord[] = [
    makeFailedCase("flaky-1", "flaky"),
    makeFailedCase("flaky-2", "flaky"),
    makeFailedCase("flaky-3", "flaky"),
    makeFailedCase("real-bug-1"),
  ];
  const flakyRecords: FlakyRecord[] = [
    makeFlakyRecord("id-1", "flaky-1", true),
    makeFlakyRecord("id-2", "flaky-2", true),
    makeFlakyRecord("id-3", "flaky-3", true),
  ];

  const result = evaluateQualityGate(totalCases, failedCases, flakyRecords);

  expect(result.status).toBe("failed"); // 1 非 flaky 失败
  expect(result.failed).toBe(1);
  expect(result.flakyIsolated).toBe(3);
  expect(result.flakyFailed).toBe(3);
  expect(result.passed).toBe(16); // 20 - 1 - 3 = 16
  });
});

describe('finalizeQualityGate', () => {
  const report = (passed: number, failed: number, coverage: number | null): AgentRunResult => ({
    lanes: [], artifacts: [], report: { passed, failed, coverage }
  })

  it('always emits a gate and fails real test failures', () => {
    const outcome = report(4, 1, 90)
    expect(finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'] }, outcome)).toMatchObject({ status: 'failed', passed: 4, failed: 1 })
    expect(outcome.report.qualityGate).toBeDefined()
  })

  it('fails when required coverage is missing or below target', () => {
    expect(finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'], coverageTarget: 80 }, report(5, 0, null))).toMatchObject({ status: 'failed', summary: expect.stringContaining('覆盖率不可用') })
    expect(finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'], coverageTarget: 80 }, report(5, 0, 79))).toMatchObject({ status: 'failed', summary: expect.stringContaining('低于目标') })
  })

  it('passes only when tests and coverage policy pass', () => {
    expect(finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'], coverageTarget: 80 }, report(5, 0, 80))).toMatchObject({ status: 'passed', coverageTarget: 80, coverage: 80, summary: expect.stringContaining('达到目标') })
  })

  it('blocks release when a human decision degraded or remains unresolved', () => {
    const outcome = report(5, 0, 90)
    outcome.report.escalations = [
      { timestamp: '2026-01-01T00:00:00Z', escalationId: 'answered', role: 'tester', question: 'q', resolved: false, degraded: false },
      { timestamp: '2026-01-01T00:00:01Z', escalationId: 'answered', role: 'tester', question: 'q', resolved: true, degraded: false, answer: 'ok' },
      { timestamp: '2026-01-01T00:00:02Z', escalationId: 'timeout', role: 'tester', question: 'q2', resolved: false, degraded: true }
    ]
    expect(finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'] }, outcome)).toMatchObject({
      status: 'failed',
      blockingReasons: [expect.stringContaining('1 项执行决策')]
    })
  })

  it('blocks release for unsafe diagnosis, pending fix confirmation, or unconverged repair', () => {
    const outcome = report(5, 0, 90)
    outcome.report.readOnlyViolation = { changedFiles: ['src/a.ts'] }
    outcome.report.fitness = {
      iterations: 2, k: 2, converged: false, stoppedReason: 'no-improvement',
      message: '连续两轮无提升', curve: []
    }
    outcome.fixDecision = { action: 'needs-confirm', reason: '低置信度真缺陷' }
    const gate = finalizeQualityGate({ projectPath: 'x', systemName: 'x', version: '1', testTypes: ['unit'] }, outcome)
    expect(gate.status).toBe('failed')
    expect(gate.blockingReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('越权修改'),
      expect.stringContaining('仍需确认'),
      expect.stringContaining('未收敛')
    ]))
  })
})
