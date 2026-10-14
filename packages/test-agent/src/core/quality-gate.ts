/**
 * 质量门禁 — PRD 功能二 场景 C：flaky 隔离不阻断门禁。
 *
 * 门禁逻辑识别 flaky 标记，将 flaky 失败从主门禁隔离：
 * - 非 flaky 失败 → 计入主门禁，决定门禁 pass/fail
 * - flaky 失败 → 隔离不计入主门禁，报告单独列出
 * - flaky 通过 → 标记为 flaky 但不阻断
 *
 * 控制面零改动：门禁评估在 Worker/Agent 层完成，不依赖 Java 控制面。
 */

import type { FailedCaseRecord } from "./types.js";
import type { FlakyRecord } from "./flaky.js";
import type { TaskInput } from '@cxmt/protocol'
import type { AgentRunResult } from './types.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 质量门禁评估结果。 */
export interface QualityGateResult {
  /** 主门禁状态：passed（无非 flaky 失败）/ failed（有非 flaky 失败）。 */
  status: "passed" | "failed";
  /** 主门禁通过数（不含 flaky 隔离）。 */
  passed: number;
  /** 主门禁失败数（非 flaky 失败）。 */
  failed: number;
  /** flaky 隔离用例数（已标记 flaky 的用例总数）。 */
  flakyIsolated: number;
  /** flaky 失败数（flaky 用例中失败的，隔离不计入门禁）。 */
  flakyFailed: number;
  /** flaky 用例详情（报告单独列）。 */
  flakyCases: Array<Pick<FlakyRecord, "caseId" | "caseTitle" | "isFlaky" | "reason">>;
  /** 阻止发布的确定性原因。 */
  blockingReasons?: string[];
  /** 本次任务实际采用的覆盖率目标。 */
  coverageTarget?: number;
  /** 门禁评估时使用的覆盖率。 */
  coverage?: number | null;
  /** 门禁摘要文本。 */
  summary: string;
}

// ---------------------------------------------------------------------------
// 门禁评估
// ---------------------------------------------------------------------------

/**
 * 评估质量门禁，隔离 flaky 失败。
 *
 * PRD 6.5 场景 C：门禁跑 50 用例，3 个是已标记 flaky，其中 1 个失败。
 * 期望：门禁判定为"通过（3 flaky 隔离，1 失败不计入）"，报告单独列出 flaky 失败。
 *
 * @param totalCases 总用例数
 * @param failedCases 诊断产出的失败用例列表（含 name/category）
 * @param flakyRecords Flaky 检测结果
 * @returns 门禁评估结果
 */
export function evaluateQualityGate(
  totalCases: number,
  failedCases: FailedCaseRecord[],
  flakyRecords: FlakyRecord[],
): QualityGateResult {
  // 已标记 flaky 的用例标题集合
  const flakyTitles = new Set(
    flakyRecords.filter((r) => r.isFlaky).map((r) => r.caseTitle),
  );

  // 将失败用例分为 flaky 失败和非 flaky 失败
  const flakyFailedCases = failedCases.filter((c) => flakyTitles.has(c.name));
  const nonFlakyFailedCases = failedCases.filter((c) => !flakyTitles.has(c.name));

  const flakyFailed = flakyFailedCases.length;
  const nonFlakyFailed = nonFlakyFailedCases.length;
  const flakyIsolated = flakyRecords.filter((r) => r.isFlaky).length;

  // 主门禁通过数 = 总用例 - 非 flaky 失败 - flaky 隔离
  // flaky 用例隔离后不计入通过也不计入失败
  const mainGatePassed = Math.max(0, totalCases - nonFlakyFailed - flakyIsolated);
  const mainGateFailed = nonFlakyFailed;

  const status: "passed" | "failed" = mainGateFailed === 0 ? "passed" : "failed";

  const summary = status === "passed"
    ? `门禁通过（${mainGatePassed} 通过${flakyIsolated > 0 ? `，${flakyIsolated} flaky 隔离` : ""}${flakyFailed > 0 ? `，${flakyFailed} flaky 失败不计入` : ""}）`
    : `门禁失败（${mainGateFailed} 非 flaky 失败${mainGatePassed > 0 ? `，${mainGatePassed} 通过` : ""}${flakyIsolated > 0 ? `，${flakyIsolated} flaky 隔离` : ""}${flakyFailed > 0 ? `，${flakyFailed} flaky 失败不计入` : ""}）`;

  return {
    status,
    passed: mainGatePassed,
    failed: mainGateFailed,
    flakyIsolated,
    flakyFailed,
    flakyCases: flakyRecords.filter((r) => r.isFlaky),
    summary,
  };
}

/** Apply one deterministic final gate to every report, including coverage policy. */
export function finalizeQualityGate(input: TaskInput, result: AgentRunResult): QualityGateResult {
  const existing = result.report.qualityGate
  let gate: QualityGateResult = existing ?? {
    status: result.report.failed === 0 ? 'passed' : 'failed',
    passed: result.report.passed,
    failed: result.report.failed,
    flakyIsolated: 0,
    flakyFailed: 0,
    flakyCases: [],
    summary: result.report.failed === 0
      ? `门禁通过（${result.report.passed} 通过，0 失败）`
      : `门禁失败（${result.report.failed} 失败，${result.report.passed} 通过）`
  }
  const target = typeof input.coverageTarget === 'number' && Number.isFinite(input.coverageTarget)
    ? Math.max(0, Math.min(100, input.coverageTarget))
    : 0
  const blockingReasons: string[] = []
  if (target > 0) {
    const coverage = result.report.coverage
    const coverageFailure = coverage === null
      ? `覆盖率不可用，目标 ${target}%`
      : coverage < target ? `覆盖率 ${coverage}% 低于目标 ${target}%` : null
    if (coverageFailure) blockingReasons.push(coverageFailure)
    else gate = { ...gate, summary: `${gate.summary}；覆盖率 ${coverage}% 达到目标 ${target}%` }
  }
  if (result.report.readOnlyViolation?.changedFiles.length) {
    blockingReasons.push(`诊断阶段越权修改了 ${result.report.readOnlyViolation.changedFiles.length} 个项目文件`)
  }
  if (result.fixDecision?.action === 'needs-confirm') {
    blockingReasons.push(`修复决策仍需确认：${result.fixDecision.reason}`)
  }
  if (result.report.fitness && !result.report.fitness.converged) {
    blockingReasons.push(`自动修复未收敛：${result.report.fitness.message}`)
  }
  const latestEscalations = new Map<string, NonNullable<AgentRunResult['report']['escalations']>[number]>()
  for (const record of result.report.escalations ?? []) latestEscalations.set(record.escalationId, record)
  const unresolvedEscalations = [...latestEscalations.values()].filter((record) => record.degraded || !record.resolved)
  if (unresolvedEscalations.length > 0) {
    blockingReasons.push(`${unresolvedEscalations.length} 项执行决策未获得有效答复或已降级`)
  }
  if (blockingReasons.length > 0) {
    gate = {
      ...gate,
      status: 'failed',
      blockingReasons,
      summary: `${gate.summary}；发布阻断：${blockingReasons.join('；')}`
    }
  } else if (gate.blockingReasons?.length) {
    gate = { ...gate, blockingReasons: undefined }
  }
  gate = { ...gate, coverageTarget: target, coverage: result.report.coverage }
  result.report.qualityGate = gate
  return gate
}
