/**
 * 分层自动决策引擎 — 根据诊断结果决定修复动作。
 *
 * PRD 2.2 分层策略（[[诊断先行架构PRD]]）：
 * - test-defect（任意置信）→ auto-fix（低风险，改测试不碰生产代码）
 * - real-bug 高置信 → auto-fix（证据明确，自动改生产代码 + 可回滚）
 * - real-bug 低置信 → needs-confirm（高风险 + 不确定，停下问用户）
 * - environment / flaky → no-fix（agent 改不了环境/隔离 flaky，报告给用户）
 *
 * 决策粒度：整体决策（非单条）。多条失败时按"最高风险"决定：
 * - 有任一 low-confidence real-bug → 整体 needs-confirm
 * - 有任一 environment/flaky 且无 real-bug/test-defect → no-fix
 * - 否则 auto-fix
 */

import type { DiagnosisResult, FixDecision, FailedCaseRecord } from "./types.js";

export type { FixDecision } from "./types.js";

/**
 * 根据诊断结果决定修复动作（整体决策）。
 *
 * 优先级（从高到低）：
 * 1. needs-confirm — 有任一低置信 real-bug
 * 2. no-fix — 全是 environment/flaky（无 real-bug/test-defect）
 * 3. auto-fix — 有 test-defect 或 高置信 real-bug（且无低置信 real-bug）
 */
export function decideFixAction(diagnosis: DiagnosisResult): FixDecision {
  const cases = diagnosis.failedCases;

  // 空诊断 → 不修
  if (!cases || cases.length === 0) {
    return { action: "no-fix", reason: "无失败用例，无需修复" };
  }

  const lowConfidenceRealBugs = cases.filter(
    (c) => c.category === "real-bug" && c.confidence === "low",
  );
  const realBugs = cases.filter((c) => c.category === "real-bug");
  const testDefects = cases.filter((c) => c.category === "test-defect");
  const envOrFlaky = cases.filter(
    (c) => c.category === "environment" || c.category === "flaky",
  );

  // 1. 有任一低置信 real-bug → 停下问
  if (lowConfidenceRealBugs.length > 0) {
    const highCount = realBugs.length - lowConfidenceRealBugs.length;
    const parts = [
      `${lowConfidenceRealBugs.length} 条低置信真bug`,
      highCount > 0 ? `${highCount} 条高置信真bug` : "",
      testDefects.length > 0 ? `${testDefects.length} 条测试缺陷` : "",
      envOrFlaky.length > 0 ? `${envOrFlaky.length} 条环境/flaky` : "",
    ].filter(Boolean);
    return {
      action: "needs-confirm",
      reason: `存在${parts.join("、")}，低置信真bug需人工确认是否修复`,
    };
  }

  // 2. 全是 environment/flaky（无 real-bug/test-defect）→ 不修
  if (envOrFlaky.length === cases.length && realBugs.length === 0 && testDefects.length === 0) {
    return {
      action: "no-fix",
      reason: `失败均为环境/flaky问题（${envOrFlaky.length} 条），不修代码，请用户处理`,
    };
  }

  // 3. 有 test-defect 或 高置信 real-bug，且无低置信 real-bug → 自动修
  const highConfidenceRealBugs = realBugs.filter(
    (c) => c.confidence === "high" || c.confidence === undefined,
  );
  const parts = [
    testDefects.length > 0 ? `${testDefects.length} 条测试缺陷` : "",
    highConfidenceRealBugs.length > 0 ? `${highConfidenceRealBugs.length} 条高置信真bug` : "",
  ].filter(Boolean);
  return {
    action: "auto-fix",
    reason: `可自动修复：${parts.join(" + ") || "可修复的失败"}`,
  };
}
