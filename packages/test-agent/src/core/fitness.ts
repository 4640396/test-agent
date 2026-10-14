/**
 * Fitness-driven 重试判停纯函数（PRD 功能一）。
 *
 * 纯函数，无 LLM 依赖，可独立单测。runFitnessDrivenExecute 每轮 fix+retest 后
 * 追加一个观测点到 curve，再调用 evaluateFitness 判断是否应停。
 *
 * 判停规则：
 * - passRateDelta>0 或 coverageDelta>0 任一为正 → improvement=true
 * - 连续 k 轮 improvement=false → 停（stoppedReason='no-improvement', converged=false）
 * - 通过率达 100% → converged=true, stoppedReason='converged'
 * - coverage 达 coverageTarget → converged=true, stoppedReason='converged'
 * - 无失败用例 → converged=true, stoppedReason='no-failures'
 */

import type { FitnessCurvePoint, FitnessReport } from "./types.js";

/** 停止决策结果（evaluateFitness 返回）。 */
export interface FitnessDecision {
  /** 是否应停止迭代。 */
  shouldStop: boolean;
  /** 是否收敛（达标或无失败）。 */
  converged: boolean;
  /** 停止原因。 */
  stoppedReason: FitnessReport["stoppedReason"];
  /** 人类可读停止说明。 */
  message: string;
}

/** 计算通过率百分比（0-100）。passed/total，total=0 时返回 0。 */
function computePassRate(passed: number, failed: number): number {
  const total = passed + failed;
  if (total === 0) return 0;
  return Math.round((passed / total) * 1000) / 10;
}

/**
 * 构造一个观测点（计算 passRate/delta/improvement）。
 *
 * @param iter 轮次
 * @param passed 通过数
 * @param failed 失败数
 * @param coverage 覆盖率（null = 无数据）
 * @param prev 上一个观测点（无则 delta=0）
 */
export function makeCurvePoint(
  iter: number,
  passed: number,
  failed: number,
  coverage: number | null,
  prev?: FitnessCurvePoint,
): FitnessCurvePoint {
  const passRate = computePassRate(passed, failed);
  const passRateDelta = prev ? Math.round((passRate - prev.passRate) * 10) / 10 : 0;
  const coverageDelta =
    prev && coverage !== null && prev.coverage !== null
      ? Math.round((coverage - prev.coverage) * 10) / 10
      : 0;
  const improvement = passRateDelta > 0 || coverageDelta > 0;
  return { iter, passed, failed, coverage, passRate, passRateDelta, coverageDelta, improvement };
}

/**
 * 判断 fitness 循环是否应停止。
 *
 * 判停优先级：
 * 1. 无失败用例 → no-failures（converged）
 * 2. 通过率 100% 或 coverage 达标 → converged
 * 3. 连续 k 轮无正提升 → no-improvement（未收敛，需人工）
 * 4. 否则继续
 *
 * @param curve 已有的观测曲线（含基线点 + 每轮观测点）
 * @param k 判停阈值（连续 k 轮无正提升即停）
 * @param coverageTarget 覆盖率达标目标（可选，undefined 时不按覆盖率收敛）
 */
export function evaluateFitness(
  curve: FitnessCurvePoint[],
  k: number,
  coverageTarget?: number,
): FitnessDecision {
  if (curve.length === 0) {
    return {
      shouldStop: false,
      converged: false,
      stoppedReason: "no-improvement",
      message: "无观测数据，继续执行",
    };
  }

  const latest = curve[curve.length - 1];

  // 1. 无失败用例
  if (latest.failed <= 0) {
    return {
      shouldStop: true,
      converged: true,
      stoppedReason: "no-failures",
      message: `自修复收敛：第 ${latest.iter} 轮无失败用例，全部通过`,
    };
  }

  // 2. 通过率达 100% 或覆盖率达标
  if (latest.passRate >= 100 && latest.failed <= 0) {
    return {
      shouldStop: true,
      converged: true,
      stoppedReason: "converged",
      message: `自修复收敛：第 ${latest.iter} 轮通过率达 100%`,
    };
  }
  if (coverageTarget !== undefined && latest.coverage !== null && latest.coverage >= coverageTarget) {
    return {
      shouldStop: true,
      converged: true,
      stoppedReason: "converged",
      message: `自修复收敛：第 ${latest.iter} 轮覆盖率达标 ${latest.coverage}% ≥ ${coverageTarget}%`,
    };
  }

  // 3. 连续 k 轮无正提升
  // 从最新点往前数连续 improvement=false 的轮数（跳过 iter=0 基线，基线不是迭代轮）
  let consecutiveNoImprove = 0;
  for (let i = curve.length - 1; i >= 0; i--) {
    if (curve[i].iter === 0) break;
    if (curve[i].improvement) break;
    consecutiveNoImprove++;
  }
  if (consecutiveNoImprove >= k) {
    return {
      shouldStop: true,
      converged: false,
      stoppedReason: "no-improvement",
      message: `自修复未收敛，需人工：连续 ${consecutiveNoImprove} 轮无正提升（通过率 ${latest.passRate}%，覆盖率 ${latest.coverage ?? "N/A"}%）`,
    };
  }

  return {
    shouldStop: false,
    converged: false,
    stoppedReason: "no-improvement",
    message: `继续迭代：第 ${latest.iter} 轮，通过率 ${latest.passRate}%`,
  };
}

/**
 * 构造完整的 FitnessReport（迭代结束后调用）。
 *
 * @param curve 观测曲线
 * @param k 判停阈值
 * @param iterations 实际迭代轮次
 * @param decision 最终判停决策
 * @param tokenCost token 用量（可选）
 */
export function buildFitnessReport(
  curve: FitnessCurvePoint[],
  k: number,
  iterations: number,
  decision: FitnessDecision,
  tokenCost?: { input: number; output: number; total: number } | null,
): FitnessReport {
  return {
    iterations,
    k,
    converged: decision.converged,
    stoppedReason: decision.stoppedReason,
    message: decision.message,
    curve,
    ...(tokenCost !== undefined ? { tokenCost } : {}),
  };
}
