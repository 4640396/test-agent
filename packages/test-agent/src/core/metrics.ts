/**
 * 质量趋势看板 — PRD 功能二（片3）。
 *
 * 核心能力：
 * 1. Worker 本地按周预聚合 5 维度质量指标（通过率 / 失败分类占比 / flaky 率 / 平均执行时长 / token 成本）
 * 2. 持久化到 .test-agent/metrics/<projectHash>/weekly.jsonl
 * 3. 查询接口 queryMetrics 供 GUI 看板调用
 * 4. 突变检测 detectAnomalies（周环比突变告警）
 *
 * 存储布局（控制面零改动，纯文件系统）：
 *   .test-agent/metrics/<projectHash>/weekly.jsonl（每行一周点）
 *
 * 数据源：
 * - P0 用例执行历史（runs.jsonl）
 * - 任务结果（AgentRunResult.report，含 passed/failed/coverage/failedCases/flakyCases/durationMs/timeline）
 * - 片1 fitness 报告（report.fitness.tokenCost）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 失败分类（与 DiagnosisCategory 一致）。 */
export type FailCategory = "real-bug" | "test-defect" | "environment" | "flaky";

/** 5 维度指标。 */
export interface MetricsDimensions {
  /** 通过率（0-1）。 */
  passRate: number;
  /** 失败分类占比（各分类失败数 / 总失败数，无失败时全 0）。 */
  failCategoryRatio: Record<FailCategory, number>;
  /** Flaky 率（flaky 用例数 / 总用例数，0-1）。 */
  flakyRate: number;
  /** 平均执行时长（毫秒，从 timeline 或 durationMs 取）。null = 无数据。 */
  avgDurationMs: number | null;
  /** Token 成本（从 fitness.tokenCost.total 取）。null = 数据积累中。 */
  tokenCost: number | null;
}

/** 周点（weekly.jsonl 每行一条）。 */
export interface WeeklyPoint {
  /** ISO 周起始（周一 00:00:00 UTC，ISO 字符串）。 */
  weekStart: string;
  /** 该周的聚合维度值。 */
  dimensions: MetricsDimensions;
  /** 该周聚合的任务数（用于调试/展示）。 */
  taskCount: number;
  /** 原始聚合数据（供精确增量合并，旧文件可能缺失）。 */
  totals?: WeeklyTotals;
}

/** 周点原始聚合数据（供 mergeWeekPoint 精确合并）。 */
export interface WeeklyTotals {
  totalPassed: number;
  totalFailed: number;
  totalCases: number;
  totalFlaky: number;
  failCounts: Record<FailCategory, number>;
  durationSum: number;
  durationCount: number;
  tokenCostSum: number;
  tokenCostCount: number;
}

/** 单条任务结果输入（供聚合使用，从 AgentRunResult 提取）。 */
export interface MetricsTaskInput {
  /** 任务完成时间（ISO 字符串，用于确定归属周）。 */
  timestamp: string;
  /** 通过数。 */
  passed: number;
  /** 失败数。 */
  failed: number;
  /** 失败用例诊断列表（含 category）。 */
  failedCases?: Array<{ category: FailCategory }>;
  /** Flaky 用例列表。 */
  flakyCases?: Array<{ isFlaky: boolean }>;
  /** 总用例数（若未提供则用 passed+failed 估算）。 */
  totalCases?: number;
  /** 执行时长（毫秒，从 timeline.durationMs 求和或直接取 report.durationMs）。 */
  durationMs?: number | null;
  /** Fitness token 成本。 */
  tokenCost?: { input: number; output: number; total: number } | null;
}

/** 突变告警。 */
export interface AnomalyAlert {
  /** 发生突变的维度名。 */
  dimension: string;
  /** 上周值。 */
  from: number;
  /** 本周值。 */
  to: number;
  /** 人类可读告警描述。 */
  message: string;
  /** 周起始（突变发生的周）。 */
  weekStart: string;
}

/** 突变检测阈值配置。 */
export interface AnomalyThresholds {
  /** flaky 率周环比上升超过此值（百分点）触发告警。默认 10。 */
  flakyRateIncreasePP: number;
  /** 通过率周环比下降超过此值（百分点）触发告警。默认 10。 */
  passRateDecreasePP: number;
}

/** 查询时间窗口。 */
export interface MetricsTimeRange {
  /** 起始时间（ISO 字符串，含）。 */
  start: string;
  /** 结束时间（ISO 字符串，含）。 */
  end: string;
}

// ---------------------------------------------------------------------------
// ISO 周工具
// ---------------------------------------------------------------------------

/**
 * 获取某日期所属 ISO 周的周一 00:00:00 UTC。
 *
 * ISO 周：周一为一周起始。如果当前是周一，直接取当天 00:00。
 */
export function isoWeekStart(date: Date | string): Date {
  const d = typeof date === "string" ? new Date(date) : new Date(date);
  const day = d.getUTCDay(); // 0=Sunday, 1=Monday, ...
  const diff = day === 0 ? 6 : day - 1; // 距离周一的天数
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

export function defaultAnomalyThresholds(): AnomalyThresholds {
  return {
    flakyRateIncreasePP: Number(process.env.TEST_AGENT_ANOMALY_FLAKY_PP ?? 10),
    passRateDecreasePP: Number(process.env.TEST_AGENT_ANOMALY_PASSRATE_PP ?? 10),
  };
}

// ---------------------------------------------------------------------------
// 聚合纯函数
// ---------------------------------------------------------------------------

/**
 * 将多条任务结果聚合为周点序列。
 *
 * 按 ISO 周分组，每维度在该周内取加权平均或汇总：
 * - passRate: 该周所有任务的 passed 总和 / (passed+failed) 总和
 * - failCategoryRatio: 该周各 category 失败数 / 该周总失败数
 * - flakyRate: 该周 flaky 用例数 / 该周总用例数
 * - avgDurationMs: 该周所有任务 durationMs 的算术平均
 * - tokenCost: 该周所有有 tokenCost 的任务的 tokenCost.total 总和（全为 null → null）
 *
 * @param inputs 任务结果数组
 * @returns 按 weekStart 排序的周点数组
 */
export function aggregateWeekly(inputs: MetricsTaskInput[]): WeeklyPoint[] {
  // 按 ISO 周分组
  const weekMap = new Map<string, MetricsTaskInput[]>();
  for (const input of inputs) {
    const ws = isoWeekStart(input.timestamp).toISOString();
    if (!weekMap.has(ws)) weekMap.set(ws, []);
    weekMap.get(ws)!.push(input);
  }

  const points: WeeklyPoint[] = [];
  for (const [weekStart, weekInputs] of weekMap) {
    points.push(aggregateSingleWeek(weekStart, weekInputs));
  }

  // 按 weekStart 排序
  points.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return points;
}

/** 聚合单周的多条任务结果为一个周点。 */
function aggregateSingleWeek(weekStart: string, inputs: MetricsTaskInput[]): WeeklyPoint {
  let totalPassed = 0;
  let totalFailed = 0;
  const failCounts: Record<FailCategory, number> = { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 };
  let totalFlaky = 0;
  let totalCases = 0;
  const durations: number[] = [];
  const tokenCosts: number[] = [];

  for (const input of inputs) {
    totalPassed += input.passed;
    totalFailed += input.failed;

    // 失败分类
    if (input.failedCases) {
      for (const fc of input.failedCases) {
        if (fc.category in failCounts) {
          failCounts[fc.category]++;
        }
      }
    }

    // Flaky 用例数
    if (input.flakyCases) {
      for (const fc of input.flakyCases) {
        if (fc.isFlaky) totalFlaky++;
      }
    }

    // 总用例数
    totalCases += input.totalCases ?? (input.passed + input.failed);

    // 执行时长
    if (input.durationMs !== null && input.durationMs !== undefined) {
      durations.push(input.durationMs);
    }

    // Token 成本
    if (input.tokenCost && typeof input.tokenCost.total === "number") {
      tokenCosts.push(input.tokenCost.total);
    }
  }

  const totalRun = totalPassed + totalFailed;
  const totalFailures = failCounts["real-bug"] + failCounts["test-defect"] + failCounts.environment + failCounts.flaky;

  const dimensions: MetricsDimensions = {
    passRate: totalRun > 0 ? totalPassed / totalRun : 1.0,
    failCategoryRatio: {
      "real-bug": totalFailures > 0 ? failCounts["real-bug"] / totalFailures : 0,
      "test-defect": totalFailures > 0 ? failCounts["test-defect"] / totalFailures : 0,
      environment: totalFailures > 0 ? failCounts.environment / totalFailures : 0,
      flaky: totalFailures > 0 ? failCounts.flaky / totalFailures : 0,
    },
    flakyRate: totalCases > 0 ? totalFlaky / totalCases : 0,
    avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    tokenCost: tokenCosts.length > 0 ? tokenCosts.reduce((a, b) => a + b, 0) : null,
  };

  return {
    weekStart,
    dimensions,
    taskCount: inputs.length,
    totals: {
      totalPassed,
      totalFailed,
      totalCases,
      totalFlaky,
      failCounts: { ...failCounts },
      durationSum: durations.reduce((a, b) => a + b, 0),
      durationCount: durations.length,
      tokenCostSum: tokenCosts.reduce((a, b) => a + b, 0),
      tokenCostCount: tokenCosts.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 持久化（weekly.jsonl 读写）
// ---------------------------------------------------------------------------

/** metrics 目录：.test-agent/metrics/<projectHash>/ */
export function metricsDir(baseDir: string, projectHash: string): string {
  return join(baseDir, projectHash);
}

/** weekly.jsonl 文件路径。 */
function weeklyFilePath(baseDir: string, projectHash: string): string {
  return join(metricsDir(baseDir, projectHash), "weekly.jsonl");
}

/**
 * 从 weekly.jsonl 读取全部周点。
 *
 * @param baseDir metrics 根目录（.test-agent/metrics/）
 * @param projectHash 项目 hash
 * @returns 按 weekStart 排序的周点数组
 */
export function loadWeeklyPoints(baseDir: string, projectHash: string): WeeklyPoint[] {
  const filePath = weeklyFilePath(baseDir, projectHash);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const points: WeeklyPoint[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as WeeklyPoint;
        if (parsed.weekStart && parsed.dimensions) {
          points.push(parsed);
        }
      } catch {
        // 跳过损坏行
      }
    }
    points.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    return points;
  } catch {
    return [];
  }
}

/**
 * 将完整周点序列写入 weekly.jsonl（覆盖写）。
 *
 * 用于全量重建或测试。
 */
export function writeWeeklyPoints(baseDir: string, projectHash: string, points: WeeklyPoint[]): void {
  const dir = metricsDir(baseDir, projectHash);
  mkdirSync(dir, { recursive: true });
  const content = points.map((p) => JSON.stringify(p)).join("\n") + (points.length > 0 ? "\n" : "");
  writeFileSync(weeklyFilePath(baseDir, projectHash), content, "utf8");
}

/**
 * 把单条任务结果聚合进 weekly.jsonl。
 *
 * 读取已有周点 → 合并同周数据 → 重写文件。
 * 聚合失败不抛异常（调用方 catch 后 emit warning）。
 *
 * @param baseDir metrics 根目录（.test-agent/metrics/）
 * @param projectHash 项目 hash
 * @param input 本次任务结果
 */
export function appendTaskToWeekly(baseDir: string, projectHash: string, input: MetricsTaskInput): void {
  const existing = loadWeeklyPoints(baseDir, projectHash);
  const ws = isoWeekStart(input.timestamp).toISOString();

  // 找到同周点，合并；否则新建
  const existingIdx = existing.findIndex((p) => p.weekStart === ws);
  if (existingIdx >= 0) {
    // 重新聚合该周：从已有点反推累加数据不够精确，
    // 所以采用"追加 + 重聚合"策略——把新 input 加入该周的任务列表再聚合。
    // 但已有点不保留逐条数据，所以用加权合并。
    existing[existingIdx] = mergeWeekPoint(existing[existingIdx], input);
  } else {
    const newPoint = aggregateSingleWeek(ws, [input]);
    existing.push(newPoint);
  }

  writeWeeklyPoints(baseDir, projectHash, existing);
}

/**
 * 把新任务结果合并进已有周点（精确合并）。
 *
 * 当已有点携带 totals（原始聚合数据）时，用原始计数精确合并。
 * 旧文件无 totals 时降级为按 taskCount 加权近似。
 */
function mergeWeekPoint(existing: WeeklyPoint, input: MetricsTaskInput): WeeklyPoint {
  // 提取新任务的原始数据
  const inputPassed = input.passed;
  const inputFailed = input.failed;
  const inputTotalCases = input.totalCases ?? (input.passed + input.failed);
  let inputFlaky = 0;
  if (input.flakyCases) {
    for (const fc of input.flakyCases) {
      if (fc.isFlaky) inputFlaky++;
    }
  }
  const inputFailCounts: Record<FailCategory, number> = {
    "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0,
  };
  if (input.failedCases) {
    for (const fc of input.failedCases) {
      if (fc.category in inputFailCounts) inputFailCounts[fc.category]++;
    }
  }
  const inputHasDur = input.durationMs !== null && input.durationMs !== undefined;
  const inputDur = inputHasDur ? (input.durationMs as number) : 0;
  const inputHasToken = input.tokenCost && typeof input.tokenCost.total === "number";
  const inputToken = inputHasToken ? input.tokenCost!.total : 0;

  if (existing.totals) {
    // 精确合并：用原始计数直接累加
    const t = existing.totals;
    const mergedPassed = t.totalPassed + inputPassed;
    const mergedFailed = t.totalFailed + inputFailed;
    const mergedTotalCases = t.totalCases + inputTotalCases;
    const mergedFlaky = t.totalFlaky + inputFlaky;
    const mergedFailCounts: Record<FailCategory, number> = {
      "real-bug": t.failCounts["real-bug"] + inputFailCounts["real-bug"],
      "test-defect": t.failCounts["test-defect"] + inputFailCounts["test-defect"],
      environment: t.failCounts.environment + inputFailCounts.environment,
      flaky: t.failCounts.flaky + inputFailCounts.flaky,
    };
    const mergedDurationSum = t.durationSum + (inputHasDur ? inputDur : 0);
    const mergedDurationCount = t.durationCount + (inputHasDur ? 1 : 0);
    const mergedTokenSum = t.tokenCostSum + (inputHasToken ? inputToken : 0);
    const mergedTokenCount = t.tokenCostCount + (inputHasToken ? 1 : 0);

    const mergedRun = mergedPassed + mergedFailed;
    const mergedTotalFailures = mergedFailCounts["real-bug"] + mergedFailCounts["test-defect"] + mergedFailCounts.environment + mergedFailCounts.flaky;

    return {
      weekStart: existing.weekStart,
      taskCount: existing.taskCount + 1,
      dimensions: {
        passRate: mergedRun > 0 ? mergedPassed / mergedRun : 1.0,
        failCategoryRatio: {
          "real-bug": mergedTotalFailures > 0 ? mergedFailCounts["real-bug"] / mergedTotalFailures : 0,
          "test-defect": mergedTotalFailures > 0 ? mergedFailCounts["test-defect"] / mergedTotalFailures : 0,
          environment: mergedTotalFailures > 0 ? mergedFailCounts.environment / mergedTotalFailures : 0,
          flaky: mergedTotalFailures > 0 ? mergedFailCounts.flaky / mergedTotalFailures : 0,
        },
        flakyRate: mergedTotalCases > 0 ? mergedFlaky / mergedTotalCases : 0,
        avgDurationMs: mergedDurationCount > 0 ? Math.round(mergedDurationSum / mergedDurationCount) : null,
        tokenCost: mergedTokenCount > 0 ? mergedTokenSum : null,
      },
      totals: {
        totalPassed: mergedPassed,
        totalFailed: mergedFailed,
        totalCases: mergedTotalCases,
        totalFlaky: mergedFlaky,
        failCounts: mergedFailCounts,
        durationSum: mergedDurationSum,
        durationCount: mergedDurationCount,
        tokenCostSum: mergedTokenSum,
        tokenCostCount: mergedTokenCount,
      },
    };
  }

  // 降级：旧文件无 totals，按 taskCount 加权近似
  const oldCount = existing.taskCount;
  const newCount = oldCount + 1;
  const oldPassRate = existing.dimensions.passRate;
  const newPassRate = inputPassed + inputFailed > 0 ? inputPassed / (inputPassed + inputFailed) : 1.0;
  const mergedPassRate = (oldPassRate * oldCount + newPassRate) / newCount;

  const mergedFailRatio: Record<FailCategory, number> = { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 };
  const inputFailTotal = inputFailed;
  const inputHasFailures = inputFailTotal > 0;
  for (const cat of Object.keys(mergedFailRatio) as FailCategory[]) {
    const oldRatio = existing.dimensions.failCategoryRatio[cat];
    const newRatio = inputHasFailures ? inputFailCounts[cat] / inputFailTotal : 0;
    mergedFailRatio[cat] = (oldRatio * oldCount + newRatio) / newCount;
  }

  const newFlakyRate = inputTotalCases > 0 ? inputFlaky / inputTotalCases : 0;
  const mergedFlakyRate = (existing.dimensions.flakyRate * oldCount + newFlakyRate) / newCount;

  const oldAvg = existing.dimensions.avgDurationMs;
  let mergedAvg: number | null = null;
  if (oldAvg !== null && inputHasDur) {
    mergedAvg = Math.round((oldAvg * oldCount + inputDur) / newCount);
  } else if (oldAvg !== null) {
    mergedAvg = oldAvg;
  } else if (inputHasDur) {
    mergedAvg = inputDur;
  }

  const oldToken = existing.dimensions.tokenCost;
  let mergedToken: number | null = null;
  if (oldToken !== null && inputHasToken) {
    mergedToken = oldToken + inputToken;
  } else if (oldToken !== null) {
    mergedToken = oldToken;
  } else if (inputHasToken) {
    mergedToken = inputToken;
  }

  return {
    weekStart: existing.weekStart,
    taskCount: newCount,
    dimensions: {
      passRate: mergedPassRate,
      failCategoryRatio: mergedFailRatio,
      flakyRate: mergedFlakyRate,
      avgDurationMs: mergedAvg,
      tokenCost: mergedToken,
    },
  };
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 查询指定时间窗口内的周点序列。
 *
 * @param baseDir metrics 根目录
 * @param projectHash 项目 hash
 * @param range 时间窗口（start/end 为 ISO 字符串，按 weekStart 比较）
 * @returns 按 weekStart 排序的周点数组
 */
export function queryMetrics(
  baseDir: string,
  projectHash: string,
  range?: MetricsTimeRange,
): WeeklyPoint[] {
  const all = loadWeeklyPoints(baseDir, projectHash);
  if (!range) return all;
  return all.filter((p) => p.weekStart >= range.start && p.weekStart <= range.end);
}

// ---------------------------------------------------------------------------
// 突变检测
// ---------------------------------------------------------------------------

/**
 * 检测周环比突变，返回告警列表。
 *
 * 对相邻周点比较各维度变化幅度，超过阈值则生成告警。
 *
 * @param weeklyPoints 按 weekStart 排序的周点序列
 * @param thresholds 阈值配置（默认从环境变量或 defaultAnomalyThresholds 取）
 * @returns 告警数组
 */
export function detectAnomalies(
  weeklyPoints: WeeklyPoint[],
  thresholds?: AnomalyThresholds,
): AnomalyAlert[] {
  const cfg = thresholds ?? defaultAnomalyThresholds();
  const alerts: AnomalyAlert[] = [];

  for (let i = 1; i < weeklyPoints.length; i++) {
    const prev = weeklyPoints[i - 1];
    const curr = weeklyPoints[i];

    // flakyRate 环比上升（百分点）
    const flakyDeltaPP = (curr.dimensions.flakyRate - prev.dimensions.flakyRate) * 100;
    if (flakyDeltaPP > cfg.flakyRateIncreasePP) {
      alerts.push({
        dimension: "flakyRate",
        from: prev.dimensions.flakyRate,
        to: curr.dimensions.flakyRate,
        weekStart: curr.weekStart,
        message: `Flaky 率从 ${Math.round(prev.dimensions.flakyRate * 100)}% 升至 ${Math.round(curr.dimensions.flakyRate * 100)}%（+${Math.round(flakyDeltaPP)}pp）`,
      });
    }

    // passRate 环比下降（百分点）
    const passRateDeltaPP = (prev.dimensions.passRate - curr.dimensions.passRate) * 100;
    if (passRateDeltaPP > cfg.passRateDecreasePP) {
      alerts.push({
        dimension: "passRate",
        from: prev.dimensions.passRate,
        to: curr.dimensions.passRate,
        weekStart: curr.weekStart,
        message: `通过率从 ${Math.round(prev.dimensions.passRate * 100)}% 降至 ${Math.round(curr.dimensions.passRate * 100)}%（-${Math.round(passRateDeltaPP)}pp）`,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// 便捷：从 AgentRunResult 提取 MetricsTaskInput
// ---------------------------------------------------------------------------

/**
 * 从 AgentRunResult.report 提取 MetricsTaskInput（供 runner 接线使用）。
 *
 * @param report AgentRunResult.report
 * @param timestamp 任务完成时间（默认 now）
 * @param totalCases 总用例数
 */
export function extractMetricsInput(
  report: {
    passed: number;
    failed: number;
    failedCases?: Array<{ category: FailCategory }>;
    flakyCases?: Array<{ isFlaky: boolean }>;
    fitness?: { tokenCost?: { input: number; output: number; total: number } | null } | null;
  },
  timestamp?: string,
  totalCases?: number,
  durationMs?: number | null,
): MetricsTaskInput {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    passed: report.passed,
    failed: report.failed,
    failedCases: report.failedCases as Array<{ category: FailCategory }> | undefined,
    flakyCases: report.flakyCases as Array<{ isFlaky: boolean }> | undefined,
    totalCases,
    durationMs: durationMs ?? null,
    tokenCost: report.fitness?.tokenCost ?? null,
  };
}

/**
 * 从 timeline 数组计算总执行时长（毫秒）。
 *
 * 汇总各阶段 durationMs。
 */
export function sumTimelineDuration(timeline?: Array<{ durationMs?: number }>): number | null {
  if (!timeline || timeline.length === 0) return null;
  let total = 0;
  let hasValue = false;
  for (const entry of timeline) {
    if (typeof entry.durationMs === "number") {
      total += entry.durationMs;
      hasValue = true;
    }
  }
  return hasValue ? total : null;
}
