import { describe, expect, it } from "vitest";
import { decideFixAction } from "../src/core/fix-decision.js";
import type { DiagnosisResult, FailedCaseRecord } from "../src/core/types.js";

function makeCase(
  category: FailedCaseRecord["category"],
  confidence: FailedCaseRecord["confidence"],
  name = "TC001",
): FailedCaseRecord {
  return { name, layer: "unit", error: "err", category, confidence };
}

function makeDiagnosis(failedCases: FailedCaseRecord[]): DiagnosisResult {
  return { failedCases };
}

describe("decideFixAction", () => {
  it("全是 test-defect → auto-fix", () => {
    const d = makeDiagnosis([
      makeCase("test-defect", "high"),
      makeCase("test-defect", "low"),
    ]);
    const r = decideFixAction(d);
    expect(r.action).toBe("auto-fix");
  });

  it("全是高置信 real-bug → auto-fix", () => {
    const d = makeDiagnosis([
      makeCase("real-bug", "high"),
      makeCase("real-bug", "high"),
    ]);
    const r = decideFixAction(d);
    expect(r.action).toBe("auto-fix");
  });

  it("有低置信 real-bug（混合高置信）→ needs-confirm", () => {
    const d = makeDiagnosis([
      makeCase("real-bug", "high"),
      makeCase("real-bug", "low"),
      makeCase("test-defect", "high"),
    ]);
    const r = decideFixAction(d);
    expect(r.action).toBe("needs-confirm");
  });

  it("全是 environment/flaky → no-fix", () => {
    const d = makeDiagnosis([
      makeCase("environment", "low"),
      makeCase("flaky", "low"),
    ]);
    const r = decideFixAction(d);
    expect(r.action).toBe("no-fix");
  });

  it("混合 test-defect + environment（无 real-bug）→ auto-fix", () => {
    const d = makeDiagnosis([
      makeCase("test-defect", "high"),
      makeCase("environment", "low"),
    ]);
    const r = decideFixAction(d);
    expect(r.action).toBe("auto-fix");
  });

  it("空 failedCases → no-fix", () => {
    const d = makeDiagnosis([]);
    const r = decideFixAction(d);
    expect(r.action).toBe("no-fix");
  });
});
