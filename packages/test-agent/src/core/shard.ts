/**
 * 并行执行与测试分片 — PRD 功能四（第 8 节）。
 *
 * 核心能力：
 * 1. 用例级分片：一个任务的用例集切分为 N 片，按用例数均分
 * 2. 依赖隔离：标记不可并行的用例（依赖组/共享状态）强制串行片
 * 3. 失败隔离：一片失败不影响其他片，聚合时合并
 * 4. 降级正确：Worker 不足时分片数 = Worker 数，1 Worker 退化为串行
 *
 * 控制面零改动：分片与聚合在 Worker 层完成，不依赖 Java 控制面/MySQL/Flyway。
 *
 * 依赖片1：用例库提供稳定用例 ID（cases.ts computeCaseId）。
 */

import type { TestCase } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 分片配置。 */
export interface ShardConfig {
  /** 分片数（= 可用 Worker 数，最小 1）。 */
  shardCount: number;
}

/** 单片用例分配（splitShards 产出，执行方据此跑测）。 */
export interface ShardAssignment {
  /** 片索引（0-based，并行片在前，串行片在后）。 */
  shardIndex: number;
  /** 该片的用例集。 */
  cases: TestCase[];
  /** 该片是否为串行片（依赖组/共享状态，不并行）。 */
  serial: boolean;
}

/** 单片执行结果（执行方跑完每片后回传，aggregateShardResults 聚合）。 */
export interface ShardExecutionResult {
  /** 对应的片索引。 */
  shardIndex: number;
  /** 该片用例数。 */
  caseCount: number;
  /** 通过数。 */
  passed: number;
  /** 失败数。 */
  failed: number;
  /** 该片是否为串行片。 */
  serial: boolean;
  /** 执行错误（单片崩溃，失败隔离：该片用例全计失败，不影响其他片）。 */
  error?: string;
}

/** 聚合后的分片报告（PRD 8.5 场景 B：各片结果合并为完整报告）。 */
export interface AggregatedShardReport {
  /** 总用例数。 */
  totalCases: number;
  /** 总通过数（各片之和）。 */
  passed: number;
  /** 总失败数（各片之和，含崩溃片的失败）。 */
  failed: number;
  /** 分片数（含串行片）。 */
  shardCount: number;
  /** 串行片数。 */
  serialShardCount: number;
  /** 并行片数。 */
  parallelShardCount: number;
  /** 各片结果明细。 */
  shards: ShardExecutionResult[];
  /** 是否有片崩溃（失败隔离标记）。 */
  hasShardErrors: boolean;
  /** 摘要文本。 */
  summary: string;
}

// ---------------------------------------------------------------------------
// 可并行判定
// ---------------------------------------------------------------------------

/**
 * 判定用例是否可并行分片。
 *
 * 默认 true（无标记即可并行）。`parallelizable: false` 表示该用例属依赖组或
 * 共享状态，强制放入串行片，不与其他用例并行（PRD 8.8 风险退路）。
 */
export function isParallelizable(c: TestCase): boolean {
  return c.parallelizable !== false;
}

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

/**
 * 将用例集切分为 N 片，按用例数均分。
 *
 * 策略（PRD 8.3 + 8.8）：
 * - 可并行用例 → 均分到 `shardCount` 个并行片（各片用例数差 ≤1）
 * - 不可并行用例（parallelizable=false）→ 合并为一个串行片（追加在并行片之后）
 * - shardCount ≤ 1 → 退化为串行：所有用例一片，不分片（PRD 8.5 场景 C）
 * - 无可并行用例 → 全部进串行片
 * - shardCount > 可并行用例数 → 实际并行片数 = 用例数，不产出空片
 *
 * @param cases 用例集
 * @param config 分片配置（shardCount = 可用 Worker 数）
 * @returns 分片分配列表（并行片在前，串行片在后）
 */
export function splitShards(cases: TestCase[], config: ShardConfig): ShardAssignment[] {
  const shardCount = Math.max(1, Math.floor(config.shardCount));

  // 场景 C 降级：shardCount = 1 → 退化为串行，所有用例一片
  if (shardCount === 1) {
    return [{ shardIndex: 0, cases: [...cases], serial: false }];
  }

  const parallelCases = cases.filter(isParallelizable);
  const serialCases = cases.filter((c) => !isParallelizable(c));

  const assignments: ShardAssignment[] = [];

  // 并行片：按用例数均分（不产出空片，余数均摊到前几片，差 ≤1）
  const parallelShardCount = Math.min(shardCount, parallelCases.length);
  if (parallelShardCount > 0) {
    const baseSize = Math.floor(parallelCases.length / parallelShardCount);
    const remainder = parallelCases.length % parallelShardCount;
    let offset = 0;
    for (let i = 0; i < parallelShardCount; i++) {
      // 前 remainder 片各多 1 条，保证各片差 ≤1
      const size = baseSize + (i < remainder ? 1 : 0);
      assignments.push({
        shardIndex: i,
        cases: parallelCases.slice(offset, offset + size),
        serial: false,
      });
      offset += size;
    }
  }

  // 串行片：依赖组/共享状态用例，单独一片
  if (serialCases.length > 0) {
    assignments.push({
      shardIndex: assignments.length,
      cases: serialCases,
      serial: true,
    });
  }

  // 边界：cases 为空 → 返回单个空片（保证调用方总能拿到分片结构）
  if (assignments.length === 0) {
    return [{ shardIndex: 0, cases: [], serial: false }];
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// 分片均衡度
// ---------------------------------------------------------------------------

/**
 * 计算并行片用例数的最大差值（均衡度指标）。
 *
 * PRD 8.6 成功指标：各片用例数差 ≤10%。此函数返回最大 - 最小，供调用方校验。
 * 仅统计并行片（serial=false），串行片不参与均衡度计算。
 *
 * @param assignments 分片分配列表
 * @returns 最大差值（片数 ≤1 时返回 0）
 */
export function shardBalanceVariance(assignments: ShardAssignment[]): number {
  const parallelSizes = assignments
    .filter((a) => !a.serial)
    .map((a) => a.cases.length);
  if (parallelSizes.length <= 1) return 0;
  return Math.max(...parallelSizes) - Math.min(...parallelSizes);
}

// ---------------------------------------------------------------------------
// 结果聚合
// ---------------------------------------------------------------------------

/**
 * 聚合各片执行结果为完整报告（PRD 8.5 场景 B：失败隔离 + 合并）。
 *
 * - 正常片：累加 passed/failed
 * - 崩溃片（error 非空）：该片用例全计失败，其他片不受影响（失败隔离）
 * - 聚合后 passed + failed = totalCases（含崩溃片的用例）
 *
 * @param results 各片执行结果
 * @returns 聚合报告
 */
export function aggregateShardResults(results: ShardExecutionResult[]): AggregatedShardReport {
  let totalCases = 0;
  let passed = 0;
  let failed = 0;
  let serialShardCount = 0;
  let hasShardErrors = false;

  for (const r of results) {
    totalCases += r.caseCount;
    if (r.serial) serialShardCount++;
    if (r.error) {
      // 失败隔离：单片崩溃，该片用例全计失败，不影响其他片
      hasShardErrors = true;
      failed += r.caseCount;
    } else {
      passed += r.passed;
      failed += r.failed;
    }
  }

  const parallelShardCount = results.length - serialShardCount;

  const summary =
    `${passed} 通过，${failed} 失败` +
    `（${results.length} 片：${parallelShardCount} 并行${serialShardCount > 0 ? ` + ${serialShardCount} 串行` : ""}` +
    `${hasShardErrors ? "，含崩溃片" : ""}）`;

  return {
    totalCases,
    passed,
    failed,
    shardCount: results.length,
    serialShardCount,
    parallelShardCount,
    shards: results,
    hasShardErrors,
    summary,
  };
}
