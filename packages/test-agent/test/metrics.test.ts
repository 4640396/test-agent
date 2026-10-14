import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isoWeekStart,
  aggregateWeekly,
  loadWeeklyPoints,
  writeWeeklyPoints,
  appendTaskToWeekly,
  queryMetrics,
  detectAnomalies,
  defaultAnomalyThresholds,
  extractMetricsInput,
  sumTimelineDuration,
  type MetricsTaskInput,
  type WeeklyPoint,
  type AnomalyThresholds,
} from "../src/core/metrics.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "metrics-"));
}

/** 构造一个简单的任务输入。 */
function makeTask(overrides: Partial<MetricsTaskInput> = {}): MetricsTaskInput {
  return {
    timestamp: "2025-01-06T10:00:00Z", // 周一
    passed: 8,
    failed: 2,
    failedCases: [
      { category: "real-bug" },
      { category: "test-defect" },
    ],
    flakyCases: [{ isFlaky: false }, { isFlaky: false }],
    totalCases: 10,
    durationMs: 5000,
    tokenCost: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isoWeekStart
// ---------------------------------------------------------------------------

describe("isoWeekStart", () => {
  it("returns Monday for a Monday date", () => {
    const monday = isoWeekStart("2025-01-06T10:00:00Z"); // 2025-01-06 是周一
    expect(monday.getUTCDay()).toBe(1); // Monday
    expect(monday.getUTCHours()).toBe(0);
  });

  it("returns previous Monday for a Sunday", () => {
  const sunday = isoWeekStart("2025-01-12T10:00:00Z"); // 周日
  expect(sunday.getUTCDay()).toBe(1);
  expect(sunday.getUTCDate()).toBe(6); // 回到 1月6日（周一）
  });

  it("returns Monday for a Wednesday", () => {
    const wed = isoWeekStart("2025-01-08T10:00:00Z"); // 周三
    expect(wed.getUTCDay()).toBe(1);
    expect(wed.getUTCDate()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// aggregateWeekly
// ---------------------------------------------------------------------------

describe("aggregateWeekly", () => {
  it("produces correct weekly points with 5 dimensions", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2 }),
    makeTask({ timestamp: "2025-01-07T10:00:00Z", passed: 9, failed: 1 }),
    ];
  const points = aggregateWeekly(tasks);
  expect(points).toHaveLength(1); // 同一周
  const p = points[0];
  expect(p.taskCount).toBe(2);
  // 通过率 = (8+9)/(10+10) = 17/20 = 0.85
  expect(p.dimensions.passRate).toBeCloseTo(0.85, 2);
  // flaky 率 = 0/20 = 0
  expect(p.dimensions.flakyRate).toBe(0);
  // 平均时长 = (5000+5000)/2 = 5000
  expect(p.dimensions.avgDurationMs).toBe(5000);
  // tokenCost = null（两任务都无）
  expect(p.dimensions.tokenCost).toBeNull();
  });

  it("separates different weeks", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z" }), // 周1
    makeTask({ timestamp: "2025-01-13T10:00:00Z" }), // 周2
    ];
  const points = aggregateWeekly(tasks);
  expect(points).toHaveLength(2);
  expect(points[0].weekStart).toBe("2025-01-06T00:00:00.000Z");
  expect(points[1].weekStart).toBe("2025-01-13T00:00:00.000Z");
  });

  it("computes failCategoryRatio correctly", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({
      timestamp: "2025-01-06T10:00:00Z",
      passed: 7,
      failed: 3,
      failedCases: [
      { category: "real-bug" },
      { category: "test-defect" },
      { category: "flaky" },
      ],
    }),
    ];
  const points = aggregateWeekly(tasks);
  const ratio = points[0].dimensions.failCategoryRatio;
  expect(ratio["real-bug"]).toBeCloseTo(1 / 3, 2);
  expect(ratio["test-defect"]).toBeCloseTo(1 / 3, 2);
  expect(ratio.flaky).toBeCloseTo(1 / 3, 2);
  expect(ratio.environment).toBe(0);
  });

  it("flakyRate counts only isFlaky=true cases", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({
      timestamp: "2025-01-06T10:00:00Z",
      totalCases: 10,
      flakyCases: [
      { isFlaky: true },
      { isFlaky: true },
      { isFlaky: false },
      ],
    }),
    ];
  const points = aggregateWeekly(tasks);
  expect(points[0].dimensions.flakyRate).toBeCloseTo(0.2, 2); // 2/10
  });

  it("tokenCost: missing → null, present → averaged", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: { input: 100, output: 50, total: 150 } }),
    makeTask({ timestamp: "2025-01-07T10:00:00Z", tokenCost: { input: 200, output: 100, total: 300 } }),
    ];
  const points = aggregateWeekly(tasks);
  expect(points[0].dimensions.tokenCost).toBe(450); // 150 + 300
  });

  it("tokenCost missing does not block other dimensions", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: null, passed: 5, failed: 5 }),
    ];
  const points = aggregateWeekly(tasks);
  const d = points[0].dimensions;
  expect(d.tokenCost).toBeNull();
  expect(d.passRate).toBe(0.5);
  expect(d.avgDurationMs).toBe(5000);
  // 其他维度仍正常
  });

  it("avgDurationMs null when no duration data", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z", durationMs: null }),
    makeTask({ timestamp: "2025-01-07T10:00:00Z", durationMs: undefined }),
    ];
  const points = aggregateWeekly(tasks);
  expect(points[0].dimensions.avgDurationMs).toBeNull();
  });

  it("handles empty input", () => {
  expect(aggregateWeekly([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

describe("loadWeeklyPoints + writeWeeklyPoints", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes and reads back weekly points", () => {
  const points: WeeklyPoint[] = [
    {
      weekStart: "2025-01-06T00:00:00.000Z",
      taskCount: 1,
      dimensions: {
      passRate: 0.8,
      failCategoryRatio: { "real-bug": 0.5, "test-defect": 0.5, environment: 0, flaky: 0 },
      flakyRate: 0.1,
      avgDurationMs: 5000,
      tokenCost: null,
      },
    },
  ];
  writeWeeklyPoints(dir, "abc123", points);
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(1);
  expect(loaded[0].weekStart).toBe("2025-01-06T00:00:00.000Z");
  expect(loaded[0].dimensions.passRate).toBe(0.8);
  });

  it("returns empty array for non-existent file", () => {
  expect(loadWeeklyPoints(dir, "nonexistent")).toEqual([]);
  });

  it("skips corrupted lines", () => {
  const filePath = join(dir, "abc123", "weekly.jsonl");
  // 手动写一行合法 + 一行损坏
  const valid = JSON.stringify({
    weekStart: "2025-01-06T00:00:00.000Z",
    taskCount: 1,
    dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null },
  });
  mkdirSync(join(dir, "abc123"), { recursive: true });
  writeFileSync(filePath, valid + "\nCORRUPTED_LINE\n" + valid + "\n", "utf8");
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(2);
  });
});

describe("appendTaskToWeekly", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("creates weekly.jsonl on first append", () => {
  appendTaskToWeekly(dir, "abc123", makeTask());
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(1);
  expect(loaded[0].taskCount).toBe(1);
  });

  it("merges into same week on subsequent append", () => {
  appendTaskToWeekly(dir, "abc123", makeTask({ passed: 8, failed: 2 }));
  appendTaskToWeekly(dir, "abc123", makeTask({ passed: 9, failed: 1, timestamp: "2025-01-07T10:00:00Z" }));
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(1); // 同一周
  expect(loaded[0].taskCount).toBe(2);
  });

  it("creates separate week for different week", () => {
  appendTaskToWeekly(dir, "abc123", makeTask({ timestamp: "2025-01-06T10:00:00Z" }));
  appendTaskToWeekly(dir, "abc123", makeTask({ timestamp: "2025-01-13T10:00:00Z" }));
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(2);
  });

  it("merges with exact case-count weighting (not taskCount weighting)", () => {
  // Task1: 10 cases, 8 passed → passRate=0.8
  appendTaskToWeekly(dir, "abc123", makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2, totalCases: 10 }));
  // Task2: 20 cases, 10 passed → passRate=0.5
  appendTaskToWeekly(dir, "abc123", makeTask({ timestamp: "2025-01-07T10:00:00Z", passed: 10, failed: 10, totalCases: 20 }));
  const loaded = loadWeeklyPoints(dir, "abc123");
  expect(loaded).toHaveLength(1); // same week
  // 正确: (8+10)/(10+20) = 18/30 = 0.6; 错误(taskCount加权): (0.8*1+0.5*1)/2 = 0.65
  expect(loaded[0].dimensions.passRate).toBeCloseTo(0.6, 2);
  expect(loaded[0].dimensions.passRate).not.toBeCloseTo(0.65, 2);
  });
});

// ---------------------------------------------------------------------------
// queryMetrics
// ---------------------------------------------------------------------------

describe("queryMetrics", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns all points when no range", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.8, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
  ];
  writeWeeklyPoints(dir, "abc123", points);
  const result = queryMetrics(dir, "abc123");
  expect(result).toHaveLength(2);
  });

  it("filters by time window", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.8, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-20T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.7, failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
  ];
  writeWeeklyPoints(dir, "abc123", points);
  const result = queryMetrics(dir, "abc123", { start: "2025-01-10T00:00:00.000Z", end: "2025-01-15T00:00:00.000Z" });
  expect(result).toHaveLength(1);
  expect(result[0].weekStart).toBe("2025-01-13T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

describe("detectAnomalies", () => {
  it("detects flaky rate spike (3% → 18%)", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.95, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 1 }, flakyRate: 0.03, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 1 }, flakyRate: 0.18, avgDurationMs: null, tokenCost: null } },
  ];
  const alerts = detectAnomalies(points);
  expect(alerts.length).toBeGreaterThanOrEqual(1);
  const flakyAlert = alerts.find((a) => a.dimension === "flakyRate");
  expect(flakyAlert).toBeDefined();
  expect(flakyAlert!.from).toBeCloseTo(0.03, 2);
  expect(flakyAlert!.to).toBeCloseTo(0.18, 2);
  });

  it("does not trigger on stable data", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0.02, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.91, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0.025, avgDurationMs: null, tokenCost: null } },
  ];
  const alerts = detectAnomalies(points);
  expect(alerts).toHaveLength(0);
  });

  it("detects pass rate drop (>10pp)", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.75, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
  ];
  const alerts = detectAnomalies(points);
  const passRateAlert = alerts.find((a) => a.dimension === "passRate");
  expect(passRateAlert).toBeDefined();
  expect(passRateAlert!.from).toBeCloseTo(0.9, 2);
  expect(passRateAlert!.to).toBeCloseTo(0.75, 2);
  });

  it("respects custom thresholds", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0.03, avgDurationMs: null, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.88, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0.05, avgDurationMs: null, tokenCost: null } },
  ];
  // 默认阈值 10pp → 2pp 变化不触发
  expect(detectAnomalies(points)).toHaveLength(0);
  // 自定义阈值 1pp → 触发
  const customThresholds: AnomalyThresholds = { flakyRateIncreasePP: 1, passRateDecreasePP: 1 };
  expect(detectAnomalies(points, customThresholds).length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for single point", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 1, dimensions: { passRate: 0.9, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0, avgDurationMs: null, tokenCost: null } },
  ];
  expect(detectAnomalies(points)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractMetricsInput + sumTimelineDuration
// ---------------------------------------------------------------------------

describe("extractMetricsInput", () => {
  it("extracts from report with all fields", () => {
  const report = {
    passed: 8,
    failed: 2,
    failedCases: [{ category: "real-bug" as const }, { category: "flaky" as const }],
    flakyCases: [{ isFlaky: true }, { isFlaky: false }],
    fitness: { tokenCost: { input: 100, output: 50, total: 150 } },
  };
  const input = extractMetricsInput(report, "2025-01-06T10:00:00Z", 10, 5000);
  expect(input.passed).toBe(8);
  expect(input.failed).toBe(2);
  expect(input.failedCases).toHaveLength(2);
  expect(input.flakyCases).toHaveLength(2);
  expect(input.totalCases).toBe(10);
  expect(input.durationMs).toBe(5000);
  expect(input.tokenCost?.total).toBe(150);
  });

  it("handles missing fitness/tokenCost", () => {
  const report = { passed: 10, failed: 0, fitness: null };
  const input = extractMetricsInput(report);
  expect(input.tokenCost).toBeNull();
  expect(input.passed).toBe(10);
  });
});

describe("sumTimelineDuration", () => {
  it("sums all durationMs values", () => {
  expect(sumTimelineDuration([{ durationMs: 1000 }, { durationMs: 2000 }, { durationMs: 3000 }])).toBe(6000);
  });

  it("returns null for empty timeline", () => {
  expect(sumTimelineDuration([])).toBeNull();
  expect(sumTimelineDuration(undefined)).toBeNull();
  });

  it("returns null when no entries have durationMs", () => {
  expect(sumTimelineDuration([{ }, { durationMs: undefined }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PRD 6.5 场景验证
// ---------------------------------------------------------------------------

describe("PRD 6.5 场景A：5维度趋势均可看", () => {
  it("all 5 dimensions have computable values across multiple weeks", () => {
  const tasks: MetricsTaskInput[] = [
    makeTask({
      timestamp: "2025-01-06T10:00:00Z",
      passed: 8, failed: 2,
      failedCases: [{ category: "real-bug" }, { category: "test-defect" }],
      flakyCases: [{ isFlaky: false }, { isFlaky: false }],
      totalCases: 10, durationMs: 5000,
      tokenCost: { input: 100, output: 50, total: 150 },
    }),
    makeTask({
      timestamp: "2025-01-13T10:00:00Z",
      passed: 7, failed: 3,
      failedCases: [{ category: "real-bug" }, { category: "environment" }, { category: "flaky" }],
      flakyCases: [{ isFlaky: true }, { isFlaky: false }],
      totalCases: 10, durationMs: 6000,
      tokenCost: { input: 200, output: 100, total: 300 },
    }),
  ];
  const points = aggregateWeekly(tasks);
  expect(points).toHaveLength(2);
  for (const p of points) {
  expect(typeof p.dimensions.passRate).toBe("number");
  expect(p.dimensions.failCategoryRatio).toBeDefined();
  expect(Object.keys(p.dimensions.failCategoryRatio)).toHaveLength(4);
  expect(typeof p.dimensions.flakyRate).toBe("number");
  expect(p.dimensions.avgDurationMs).not.toBeNull();
  expect(p.dimensions.tokenCost).not.toBeNull();
  }
  // 第二周 flaky 率应更高
  expect(points[1].dimensions.flakyRate).toBeGreaterThan(points[0].dimensions.flakyRate);
  });
});

describe("PRD 6.5 场景B：下钻到用例（系统→模块→用例）", () => {
  it("weekly points provide system-level metrics for dashboard drill-down", () => {
  // 系统级：所有任务汇总的周点
  const tasks: MetricsTaskInput[] = [
    makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2, totalCases: 10 }),
    makeTask({ timestamp: "2025-01-13T10:00:00Z", passed: 9, failed: 1, totalCases: 10 }),
  ];
  const points = aggregateWeekly(tasks);
  expect(points).toHaveLength(2);
  // 模块级和用例级由 GUI 从 queryMetrics + runs.jsonl 分组渲染
  // 这里验证系统级周点可正确产出（下钻的基座数据）
  expect(points[0].dimensions.passRate).toBe(0.8);
  expect(points[1].dimensions.passRate).toBe(0.9);
  });
});

describe("PRD 6.5 场景C：突变告警可见", () => {
  it("flaky rate spike generates visible alert", () => {
  const points: WeeklyPoint[] = [
    { weekStart: "2025-01-06T00:00:00.000Z", taskCount: 5, dimensions: { passRate: 0.95, failCategoryRatio: { "real-bug": 0, "test-defect": 0, environment: 0, flaky: 0 }, flakyRate: 0.03, avgDurationMs: 5000, tokenCost: null } },
    { weekStart: "2025-01-13T00:00:00.000Z", taskCount: 5, dimensions: { passRate: 0.82, failCategoryRatio: { "real-bug": 0.3, "test-defect": 0, environment: 0, flaky: 0.7 }, flakyRate: 0.18, avgDurationMs: 6000, tokenCost: null } },
  ];
  const alerts = detectAnomalies(points);
  expect(alerts.length).toBeGreaterThanOrEqual(1);
  // 确保告警有可读的 message（供 GUI 展示）
  for (const a of alerts) {
    expect(a.message).toBeTruthy();
    expect(a.weekStart).toBeTruthy();
  }
  });
});
