/**
 * Flaky 检测与隔离 — PRD 功能二。
 *
 * 核心能力：
 * 1. 用例执行历史：每次 run 追加 pass/fail/timestamp 到 runs.jsonl
 * 2. 可疑用例识别：诊断标 flaky 或 近 N 次通过率 < 阈值
 * 3. 重跑判定：对可疑用例重跑 N 次，通过率 < 阈值判 flaky
 * 4. 历史不足（< minHistory）不判 flaky，靠诊断+重跑双保险
 *
 * 存储布局（控制面零改动，纯文件系统）：
 *   .test-agent/cases/<projectHash>/<caseId>/runs.jsonl
 *
 * 依赖片1：用例 ID = projectHash + title 的稳定 hash（cases.ts computeCaseId）。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosisCategory } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单次执行记录（runs.jsonl 每行一条）。 */
export interface CaseRun {
  passed: boolean;
  timestamp: string;
}

/** Flaky 检测结果。 */
export interface FlakyRecord {
  caseId: string;
  caseTitle: string;
  /** 是否判定为 flaky。 */
  isFlaky: boolean;
  /** 判定依据描述（含客观数据，PRD 6.5 场景A 验收点）。 */
  reason: string;
  /** 重跑结果序列（每次 true=通过 false=失败）。 */
  rerunResults?: boolean[];
  /** 重跑通过率（0-1）。 */
  rerunPassRate?: number;
  /** 历史通过率（近 N 次，0-1）。 */
  historyPassRate?: number;
  /** 历史记录数。 */
  historyCount: number;
  /** 触发可疑的原因列表。 */
  suspiciousReasons: string[];
}

/** Flaky 检测配置。 */
export interface FlakyConfig {
  /** 历史通过率阈值，低于此值判可疑（默认 0.9 = 90%）。 */
  historyPassRateThreshold: number;
  /** 历史最少记录数，不足不判（默认 3）。 */
  minHistoryForJudgment: number;
  /** 重跑次数（默认 5）。 */
  rerunCount: number;
  /** 重跑通过率阈值，低于此值判 flaky（默认 0.8 = 80%）。 */
  rerunPassRateThreshold: number;
  /** 历史窗口大小（默认 10，取最近 N 次）。 */
  historyWindowSize: number;
}

/** 重跑执行器：重跑指定用例，返回 pass/fail。 */
export type RerunExecutor = (caseId: string, caseTitle: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

export function defaultFlakyConfig(): FlakyConfig {
  return {
    historyPassRateThreshold: 0.9,
    minHistoryForJudgment: 3,
    rerunCount: 5,
    rerunPassRateThreshold: 0.8,
    historyWindowSize: 10,
  };
}

// ---------------------------------------------------------------------------
// 执行历史存储（runs.jsonl）
// ---------------------------------------------------------------------------

/** runs.jsonl 所在目录：.test-agent/cases/<projectHash>/<caseId>/ */
function runsDir(runsBaseDir: string, caseId: string): string {
  return join(runsBaseDir, caseId);
}

/** runs.jsonl 文件路径。 */
function runsFilePath(runsBaseDir: string, caseId: string): string {
  return join(runsDir(runsBaseDir, caseId), "runs.jsonl");
}

/**
 * 追加一条执行记录到 runs.jsonl。
 *
 * @param runsBaseDir 用例库根目录（.test-agent/cases/<projectHash>/）
 * @param caseId 用例 ID
 * @param passed 本次是否通过
 */
export function recordRun(runsBaseDir: string, caseId: string, passed: boolean): void {
  const dir = runsDir(runsBaseDir, caseId);
  mkdirSync(dir, { recursive: true });
  const entry: CaseRun = { passed, timestamp: new Date().toISOString() };
  appendFileSync(runsFilePath(runsBaseDir, caseId), JSON.stringify(entry) + "\n", "utf8");
}

/**
 * 加载用例的执行历史（最近 N 条）。
 *
 * @param runsBaseDir 用例库根目录
 * @param caseId 用例 ID
 * @param limit 最多取多少条（默认取全部，调用方可限定窗口大小）
 * @returns 执行记录数组（按时间正序，最近在末尾）
 */
export function loadRuns(runsBaseDir: string, caseId: string, limit?: number): CaseRun[] {
  const filePath = runsFilePath(runsBaseDir, caseId);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const runs: CaseRun[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as CaseRun;
        if (typeof parsed.passed === "boolean" && typeof parsed.timestamp === "string") {
          runs.push(parsed);
        }
      } catch {
        // 跳过损坏行
      }
    }
    // 取最近 limit 条
    if (limit !== undefined && limit > 0 && runs.length > limit) {
      return runs.slice(runs.length - limit);
    }
    return runs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 通过率计算
// ---------------------------------------------------------------------------

/** 计算通过率（通过数 / 总数）。无记录时返回 1.0（保守视为全过）。 */
export function computePassRate(runs: CaseRun[]): number {
  if (runs.length === 0) return 1.0;
  const passed = runs.filter((r) => r.passed).length;
  return passed / runs.length;
}

/** 历史是否充足（>= minHistory）。 */
export function isHistorySufficient(runs: CaseRun[], minHistory: number): boolean {
  return runs.length >= minHistory;
}

// ---------------------------------------------------------------------------
// 可疑用例识别
// ---------------------------------------------------------------------------

/**
 * 按历史通过率判定可疑。
 *
 * 历史不足（< minHistory）→ 不判可疑（PRD 6.8：历史不足靠诊断+重跑双保险）。
 * 历史充足且通过率 < 阈值 → 可疑。
 */
export function isSuspiciousByHistory(runs: CaseRun[], config: FlakyConfig): boolean {
  if (!isHistorySufficient(runs, config.minHistoryForJudgment)) return false;
  const passRate = computePassRate(runs);
  return passRate < config.historyPassRateThreshold;
}

/**
 * 识别可疑用例的原因列表。
 *
 * @returns 可疑原因数组（空数组 = 不可疑）
 */
export function identifySuspiciousReasons(
  runs: CaseRun[],
  diagnosisCategory: DiagnosisCategory | undefined,
  config: FlakyConfig,
): string[] {
  const reasons: string[] = [];
  if (diagnosisCategory === "flaky") {
    reasons.push("诊断标记 flaky");
  }
  if (isSuspiciousByHistory(runs, config)) {
    const passRate = computePassRate(runs);
    reasons.push(`近 ${runs.length} 次通过率 ${Math.round(passRate * 100)}% < ${Math.round(config.historyPassRateThreshold * 100)}%`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Flaky 检测主逻辑
// ---------------------------------------------------------------------------

/**
 * 对单个用例执行 Flaky 检测。
 *
 * 流程（PRD 6.5 场景 A/B）：
 * 1. 读取历史执行记录
 * 2. 识别可疑原因（诊断标 flaky 或 历史通过率 < 阈值）
 * 3. 若可疑且有重跑执行器 → 重跑 N 次
 * 4. 重跑通过率 < 阈值 → 判定 flaky
 * 5. 历史不足（< minHistory）不判 flaky，靠诊断+重跑双保险
 *
 * @param runsBaseDir 用例库根目录
 * @param caseId 用例 ID
 * @param caseTitle 用例标题
 * @param diagnosisCategory 诊断分类（来自 orchestrator FailedCaseRecord.category）
 * @param rerunExecutor 重跑执行器（undefined 时不重跑，仅记录可疑）
 * @param configOverride 配置覆盖
 * @returns Flaky 检测结果
 */
export async function detectFlaky(
  runsBaseDir: string,
  caseId: string,
  caseTitle: string,
  diagnosisCategory: DiagnosisCategory | undefined,
  rerunExecutor: RerunExecutor | undefined,
  configOverride?: Partial<FlakyConfig>,
): Promise<FlakyRecord> {
  const config = { ...defaultFlakyConfig(), ...configOverride };
  const recentRuns = loadRuns(runsBaseDir, caseId, config.historyWindowSize);
  const historyCount = recentRuns.length;
  const historyPassRate = historyCount > 0 ? computePassRate(recentRuns) : 1.0;

  // 识别可疑原因
  const suspiciousReasons = identifySuspiciousReasons(recentRuns, diagnosisCategory, config);
  const isSuspicious = suspiciousReasons.length > 0;

  // 不可疑或无重跑执行器 → 不判 flaky
  if (!isSuspicious || !rerunExecutor) {
    return {
      caseId,
      caseTitle,
      isFlaky: false,
      reason: isSuspicious
        ? `可疑（${suspiciousReasons.join("；")}）但未执行重跑`
        : "不可疑",
      historyPassRate,
      historyCount,
      suspiciousReasons,
    };
  }

  // 重跑 N 次
  const rerunResults: boolean[] = [];
  for (let i = 0; i < config.rerunCount; i++) {
    try {
      const passed = await rerunExecutor(caseId, caseTitle);
      rerunResults.push(passed);
    } catch {
      // 重跑异常计为失败（保守）
      rerunResults.push(false);
    }
  }

  const rerunPassCount = rerunResults.filter((r) => r).length;
  const rerunFailCount = rerunResults.length - rerunPassCount;
  const rerunPassRate = rerunResults.length > 0 ? rerunPassCount / rerunResults.length : 0;
  // P2 修复：0% 通过率 = 持续失败 = 真 bug，不是 flaky。
  // flaky 定义为“时过时不过”，需至少 1 次重跑通过才判 flaky。
  const isFlaky = rerunPassRate > 0 && rerunPassRate < config.rerunPassRateThreshold;

  const reason = isFlaky
    ? `${config.rerunCount} 次重跑 ${rerunPassCount} 过 ${rerunFailCount} 失，通过率 ${Math.round(rerunPassRate * 100)}% < ${Math.round(config.rerunPassRateThreshold * 100)}%（可疑原因：${suspiciousReasons.join("；")}）`
    : rerunPassRate === 0
      ? `${config.rerunCount} 次重跑全失，通过率 0% → 持续失败（真 bug），不判 flaky（可疑原因：${suspiciousReasons.join("；")}）`
      : `${config.rerunCount} 次重跑 ${rerunPassCount} 过 ${rerunFailCount} 失，通过率 ${Math.round(rerunPassRate * 100)}% >= ${Math.round(config.rerunPassRateThreshold * 100)}%（可疑原因：${suspiciousReasons.join("；")}）`;

  return {
    caseId,
    caseTitle,
    isFlaky,
    reason,
    rerunResults,
    rerunPassRate,
    historyPassRate,
    historyCount,
    suspiciousReasons,
  };
}

/**
 * 批量检测 Flaky 用例。
 *
 * 对每个可疑用例执行 detectFlaky，返回所有 FlakyRecord（含非 flaky 的）。
 */
export async function detectFlakyBatch(
  runsBaseDir: string,
  cases: Array<{ id: string; title: string }>,
  diagnosisByTitle: Map<string, DiagnosisCategory>,
  rerunExecutor: RerunExecutor | undefined,
  configOverride?: Partial<FlakyConfig>,
): Promise<FlakyRecord[]> {
  const records: FlakyRecord[] = [];
  for (const c of cases) {
  const diagCat = diagnosisByTitle.get(c.title);
  const record = await detectFlaky(runsBaseDir, c.id, c.title, diagCat, rerunExecutor, configOverride);
  records.push(record);
  }
  return records;
}
