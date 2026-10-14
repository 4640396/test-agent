import { describe, expect, it } from "vitest";
import {
  isParallelizable,
  splitShards,
  shardBalanceVariance,
  aggregateShardResults,
  type ShardAssignment,
  type ShardExecutionResult,
} from "../src/core/shard.js";
import type { TestCase } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeCase(title: string, parallelizable?: boolean): TestCase {
  return {
    id: `id-${title}`,
    title,
    scenario: `测试 ${title}`,
    steps: ["步骤1"],
    expected: "预期结果",
    priority: "medium",
    layer: "unit",
    ...(parallelizable !== undefined ? { parallelizable } : {}),
  };
}

function makeCases(count: number): TestCase[] {
  return Array.from({ length: count }, (_, i) => makeCase(`用例${i + 1}`));
}

function makeShardResult(
  shardIndex: number,
  caseCount: number,
  passed: number,
  failed: number,
  serial = false,
  error?: string,
): ShardExecutionResult {
  return { shardIndex, caseCount, passed, failed, serial, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// isParallelizable
// ---------------------------------------------------------------------------

describe("isParallelizable", () => {
  it("无标记默认可并行", () => {
    expect(isParallelizable(makeCase("A"))).toBe(true);
  });

  it("parallelizable=true 可并行", () => {
    expect(isParallelizable(makeCase("A", true))).toBe(true);
  });

  it("parallelizable=false 不可并行（依赖组/共享状态）", () => {
    expect(isParallelizable(makeCase("A", false))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// splitShards — PRD 8.5 场景 A：分片并行加速
// ---------------------------------------------------------------------------

describe("splitShards", () => {
  it("场景A: 200 用例 4 Worker → 均分 4 片各 50，均衡差 ≤1", () => {
    const cases = makeCases(200);
    const shards = splitShards(cases, { shardCount: 4 });

    expect(shards).toHaveLength(4);
    // 各片 50 用例
    for (const s of shards) {
      expect(s.cases).toHaveLength(50);
      expect(s.serial).toBe(false);
    }
    // 均衡差 ≤1（PRD 8.6：各片用例数差 ≤10%）
    expect(shardBalanceVariance(shards)).toBe(0);
    // 不丢用例
    const total = shards.reduce((sum, s) => sum + s.cases.length, 0);
    expect(total).toBe(200);
  });

  it("场景A: 非均分时差 ≤1（201 用例 4 片 → 51/50/50/50）", () => {
    const cases = makeCases(201);
    const shards = splitShards(cases, { shardCount: 4 });

    expect(shards).toHaveLength(4);
    expect(shardBalanceVariance(shards)).toBe(1);
    const total = shards.reduce((sum, s) => sum + s.cases.length, 0);
    expect(total).toBe(201);
  });

  it("片索引从 0 连续递增", () => {
    const shards = splitShards(makeCases(100), { shardCount: 5 });
    expect(shards.map((s) => s.shardIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("分片间无重叠用例（每条用例只出现一次）", () => {
    const cases = makeCases(100);
    const shards = splitShards(cases, { shardCount: 4 });
    const allTitles = shards.flatMap((s) => s.cases.map((c) => c.title));
    const unique = new Set(allTitles);
    expect(unique.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// splitShards — PRD 8.5 场景 C：Worker 不足降级
// ---------------------------------------------------------------------------

describe("splitShards 降级", () => {
  it("场景C: 1 Worker → 退化为串行，所有用例一片", () => {
    const cases = makeCases(200);
    const shards = splitShards(cases, { shardCount: 1 });

    expect(shards).toHaveLength(1);
    expect(shards[0].cases).toHaveLength(200);
    expect(shards[0].serial).toBe(false);
    expect(shards[0].shardIndex).toBe(0);
  });

  it("shardCount=0 当 1 处理（下限保护）", () => {
    const shards = splitShards(makeCases(10), { shardCount: 0 });
    expect(shards).toHaveLength(1);
    expect(shards[0].cases).toHaveLength(10);
  });

  it("shardCount 负数当 1 处理", () => {
    const shards = splitShards(makeCases(10), { shardCount: -3 });
    expect(shards).toHaveLength(1);
  });

  it("shardCount > 用例数 → 实际片数 = 用例数，不产出空片", () => {
    const shards = splitShards(makeCases(3), { shardCount: 10 });
    expect(shards).toHaveLength(3);
    for (const s of shards) {
      expect(s.cases.length).toBe(1);
      expect(s.serial).toBe(false);
    }
  });

  it("0 用例 → 返回单个空片（保证调用方拿到结构）", () => {
    const shards = splitShards([], { shardCount: 4 });
    expect(shards).toHaveLength(1);
    expect(shards[0].cases).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// splitShards — 依赖隔离（PRD 8.8 风险退路）
// ---------------------------------------------------------------------------

describe("splitShards 依赖隔离", () => {
  it("parallelizable=false 用例进串行片，不参与并行分片", () => {
    const cases = [
      makeCase("并行1"),
      makeCase("并行2"),
      makeCase("依赖A", false),
      makeCase("依赖B", false),
      makeCase("并行3"),
      makeCase("并行4"),
    ];
    const shards = splitShards(cases, { shardCount: 2 });

    // 4 并行 → 2 片各 2，2 依赖 → 1 串行片
    expect(shards).toHaveLength(3);
    const parallelShards = shards.filter((s) => !s.serial);
    const serialShards = shards.filter((s) => s.serial);

    expect(parallelShards).toHaveLength(2);
    expect(parallelShards[0].cases).toHaveLength(2);
    expect(parallelShards[1].cases).toHaveLength(2);

    expect(serialShards).toHaveLength(1);
    expect(serialShards[0].cases).toHaveLength(2);
    expect(serialShards[0].cases.map((c) => c.title)).toEqual(["依赖A", "依赖B"]);
  });

  it("全部不可并行 → 单个串行片", () => {
    const cases = [makeCase("A", false), makeCase("B", false), makeCase("C", false)];
    const shards = splitShards(cases, { shardCount: 4 });

    expect(shards).toHaveLength(1);
    expect(shards[0].serial).toBe(true);
    expect(shards[0].cases).toHaveLength(3);
  });

  it("串行片索引接在并行片之后", () => {
    const cases = [
      ...makeCases(10),
      makeCase("依赖1", false),
      makeCase("依赖2", false),
    ];
    const shards = splitShards(cases, { shardCount: 3 });

    const serialShard = shards.find((s) => s.serial);
    expect(serialShard).toBeDefined();
    // 10 并行 / 3 片 → 4+3+3，串行片索引 = 3
    expect(serialShard!.shardIndex).toBe(3);
  });

  it("串行片不参与均衡度计算", () => {
    const cases = [
      ...makeCases(12),
      makeCase("依赖1", false),
    ];
    const shards = splitShards(cases, { shardCount: 3 });
    // 12 并行 / 3 片 = 各 4，1 串行片有 1 用例
    const variance = shardBalanceVariance(shards);
    expect(variance).toBe(0); // 并行片均衡，串行片不计入
  });
});

// ---------------------------------------------------------------------------
// aggregateShardResults — PRD 8.5 场景 B：分片失败隔离
// ---------------------------------------------------------------------------

describe("aggregateShardResults", () => {
  it("场景B: 4 片各 50，片2 有 5 失败 → 聚合 195 过 5 失", () => {
    const results: ShardExecutionResult[] = [
      makeShardResult(0, 50, 50, 0),
      makeShardResult(1, 50, 45, 5),
      makeShardResult(2, 50, 50, 0),
      makeShardResult(3, 50, 50, 0),
    ];

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(200);
    expect(report.passed).toBe(195);
    expect(report.failed).toBe(5);
    expect(report.shardCount).toBe(4);
    expect(report.serialShardCount).toBe(0);
    expect(report.parallelShardCount).toBe(4);
    expect(report.hasShardErrors).toBe(false);
    expect(report.summary).toContain("195");
    expect(report.summary).toContain("5 失败");
  });

  it("失败隔离: 片2 崩溃 → 该片 50 全计失败，其他片正常", () => {
    const results: ShardExecutionResult[] = [
      makeShardResult(0, 50, 50, 0),
      makeShardResult(1, 50, 0, 0, false, "Worker OOM"),
      makeShardResult(2, 50, 50, 0),
      makeShardResult(3, 50, 50, 0),
    ];

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(200);
    expect(report.passed).toBe(150);
    expect(report.failed).toBe(50);
    expect(report.hasShardErrors).toBe(true);
    expect(report.summary).toContain("崩溃片");
  });

  it("含串行片: 3 并行 + 1 串行，聚合正确统计", () => {
    const results: ShardExecutionResult[] = [
      makeShardResult(0, 40, 40, 0),
      makeShardResult(1, 40, 38, 2),
      makeShardResult(2, 40, 40, 0),
      makeShardResult(3, 10, 10, 0, true),
    ];

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(130);
    expect(report.passed).toBe(128);
    expect(report.failed).toBe(2);
    expect(report.shardCount).toBe(4);
    expect(report.serialShardCount).toBe(1);
    expect(report.parallelShardCount).toBe(3);
    expect(report.hasShardErrors).toBe(false);
  });

  it("串行片崩溃也隔离", () => {
    const results: ShardExecutionResult[] = [
      makeShardResult(0, 50, 50, 0),
      makeShardResult(1, 5, 0, 0, true, "串行片超时"),
    ];

    const report = aggregateShardResults(results);

    expect(report.passed).toBe(50);
    expect(report.failed).toBe(5);
    expect(report.hasShardErrors).toBe(true);
    expect(report.serialShardCount).toBe(1);
  });

  it("空结果 → 全零报告", () => {
    const report = aggregateShardResults([]);

    expect(report.totalCases).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.shardCount).toBe(0);
  });

  it("所有片全过 → failed=0，hasShardErrors=false", () => {
    const results: ShardExecutionResult[] = [
      makeShardResult(0, 50, 50, 0),
      makeShardResult(1, 50, 50, 0),
    ];

    const report = aggregateShardResults(results);

    expect(report.passed).toBe(100);
    expect(report.failed).toBe(0);
    expect(report.hasShardErrors).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shardBalanceVariance
// ---------------------------------------------------------------------------

describe("shardBalanceVariance", () => {
  it("完全均衡 → 0", () => {
    const shards: ShardAssignment[] = [
      { shardIndex: 0, cases: makeCases(50), serial: false },
      { shardIndex: 1, cases: makeCases(50), serial: false },
      { shardIndex: 2, cases: makeCases(50), serial: false },
    ];
    expect(shardBalanceVariance(shards)).toBe(0);
  });

  it("差 1 → 返回 1", () => {
    const shards: ShardAssignment[] = [
      { shardIndex: 0, cases: makeCases(51), serial: false },
      { shardIndex: 1, cases: makeCases(50), serial: false },
      { shardIndex: 2, cases: makeCases(50), serial: false },
    ];
    expect(shardBalanceVariance(shards)).toBe(1);
  });

  it("单并行片 → 0", () => {
    const shards: ShardAssignment[] = [
      { shardIndex: 0, cases: makeCases(100), serial: false },
    ];
    expect(shardBalanceVariance(shards)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 端到端：split → 模拟执行 → aggregate
// ---------------------------------------------------------------------------

describe("分片端到端", () => {
  it("200 用例 4 片：split → 模拟执行 → aggregate = 195 过 5 失", () => {
    const cases = makeCases(200);
    const shards = splitShards(cases, { shardCount: 4 });

    // 模拟执行：片 2 有 5 个失败
    const results: ShardExecutionResult[] = shards.map((s, i) => ({
      shardIndex: i,
      caseCount: s.cases.length,
      passed: i === 2 ? s.cases.length - 5 : s.cases.length,
      failed: i === 2 ? 5 : 0,
      serial: s.serial,
    }));

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(200);
    expect(report.passed).toBe(195);
    expect(report.failed).toBe(5);
    expect(report.shardCount).toBe(4);
  });

  it("混合用例（并行+依赖）：split → 执行 → aggregate 不丢用例", () => {
    const cases = [
      ...makeCases(12),
      makeCase("依赖1", false),
      makeCase("依赖2", false),
    ];
    const shards = splitShards(cases, { shardCount: 3 });

    // 模拟全过
    const results: ShardExecutionResult[] = shards.map((s, i) => ({
      shardIndex: i,
      caseCount: s.cases.length,
      passed: s.cases.length,
      failed: 0,
      serial: s.serial,
    }));

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(14);
    expect(report.passed).toBe(14);
    expect(report.failed).toBe(0);
    expect(report.serialShardCount).toBe(1);
  });

  it("1 Worker 退化：split → 执行 → aggregate 等价串行", () => {
    const cases = makeCases(50);
    const shards = splitShards(cases, { shardCount: 1 });

    expect(shards).toHaveLength(1);

    const results: ShardExecutionResult[] = shards.map((s, i) => ({
      shardIndex: i,
      caseCount: s.cases.length,
      passed: 48,
      failed: 2,
      serial: s.serial,
    }));

    const report = aggregateShardResults(results);

    expect(report.totalCases).toBe(50);
    expect(report.passed).toBe(48);
    expect(report.failed).toBe(2);
    expect(report.shardCount).toBe(1);
  });
});
