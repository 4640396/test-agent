/**
 * P1 片3 独立验收 — 质量趋势看板（PRD 6.5 三场景 + 边界探针）
 *
 * 独立视角：不照抄 worker 内置 metrics.test.ts 结论。重点验证：
 * 1. PRD 6.5 场景 A/B/C 的 PRD 原意
 * 2. 边界探针：ISO 周跨年/跨月、单周单点、空数据、detectAnomalies 阈值等于边界、
 *    tokenCost 混合降级（部分周有/部分无）
 * 3. 独立判断点（KEY，worker 未测）：
 *    · fitness 多轮 retest 不污染聚合——execWithMetrics 在 run() 层而非每轮 runExecute，
 *      用真实 runFitnessDrivenExecute（mock runExecute/runFix）跑 run()，断言 weekly.jsonl
 *      taskCount=1 而 runExecute 被调 3 次（baseline + 2 retest）
 *    · execWithMetrics 异常降级（metrics 写入失败不阻断主流程，返回 result + emit warning）
 *    · 聚合真在 Worker 本地（.test-agent/metrics/，无 services/ 调用）——源码确认写入报告
 * 4. r2/r3 修复独立验证：
 *    · mergeWeekPoint 精确合并（totals 累加 vs 降级 taskCount 加权，多维度）
 *    · GUI dashboardModuleBreakdown 镜像：Set 去重 + passRate<100%（P1-1 修复）
 *    · GUI computeAnomalies 镜像：阈值可配（VITE_ANOMALY env）
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  metricsDir,
  extractMetricsInput,
  sumTimelineDuration,
  type MetricsTaskInput,
  type WeeklyPoint,
  type AnomalyThresholds,
} from "../src/core/metrics.js";
import { computeProjectHash } from "../src/core/cases.js";
import { Runner } from "../src/core/runner.js";
import type { AgentRunResult, AgentEvent, TestCase } from "../src/core/types.js";
import type { TaskInput } from "@cxmt/protocol";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "p1-metrics-"));
}

function makeTask(overrides: Partial<MetricsTaskInput> = {}): MetricsTaskInput {
  return {
    timestamp: "2025-01-06T10:00:00Z",
    passed: 8,
    failed: 2,
    failedCases: [{ category: "real-bug" }, { category: "test-defect" }],
    flakyCases: [{ isFlaky: false }, { isFlaky: false }],
    totalCases: 10,
    durationMs: 5000,
    tokenCost: null,
    ...overrides,
  };
}

function makePoint(weekStart: string, dims: Partial<WeeklyPoint["dimensions"]> = {}, taskCount = 1): WeeklyPoint {
  return {
    weekStart,
    taskCount,
    dimensions: {
      passRate: 0.8,
      failCategoryRatio: { "real-bug": 0.5, "test-defect": 0.5, environment: 0, flaky: 0 },
      flakyRate: 0,
      avgDurationMs: 5000,
      tokenCost: null,
      ...dims,
    },
  };
}

// ---------------------------------------------------------------------------
// PRD 6.5 场景 A：5 维度趋势
// ---------------------------------------------------------------------------

describe("[片3-验收] 场景A：5 维度趋势（独立构造多周序列）", () => {
  it("近 4 周 8 次任务 → 4 个周点，5 维度均可看趋势", () => {
    const tasks: MetricsTaskInput[] = [
      makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 7, failed: 3, totalCases: 10, durationMs: 4000, tokenCost: { input: 100, output: 50, total: 150 }, failedCases: [{ category: "real-bug" }, { category: "real-bug" }, { category: "test-defect" }], flakyCases: [{ isFlaky: false }] }),
      makeTask({ timestamp: "2025-01-08T10:00:00Z", passed: 8, failed: 2, totalCases: 10, durationMs: 5000, tokenCost: { input: 120, output: 60, total: 180 }, failedCases: [{ category: "real-bug" }, { category: "test-defect" }], flakyCases: [{ isFlaky: false }] }),
      makeTask({ timestamp: "2025-01-13T10:00:00Z", passed: 9, failed: 1, totalCases: 10, durationMs: 4500, tokenCost: { input: 90, output: 40, total: 130 }, failedCases: [{ category: "environment" }], flakyCases: [{ isFlaky: true }] }),
      makeTask({ timestamp: "2025-01-15T10:00:00Z", passed: 8, failed: 2, totalCases: 10, durationMs: 5500, tokenCost: { input: 110, output: 50, total: 160 }, failedCases: [{ category: "flaky" }, { category: "test-defect" }], flakyCases: [{ isFlaky: true }, { isFlaky: true }] }),
      makeTask({ timestamp: "2025-01-20T10:00:00Z", passed: 10, failed: 0, totalCases: 10, durationMs: 3000, tokenCost: { input: 80, output: 30, total: 110 }, failedCases: [], flakyCases: [] }),
      makeTask({ timestamp: "2025-01-22T10:00:00Z", passed: 9, failed: 1, totalCases: 10, durationMs: 3500, tokenCost: { input: 70, output: 20, total: 90 }, failedCases: [{ category: "real-bug" }], flakyCases: [{ isFlaky: false }] }),
      makeTask({ timestamp: "2025-01-27T10:00:00Z", passed: 6, failed: 4, totalCases: 10, durationMs: 7000, tokenCost: { input: 200, output: 100, total: 300 }, failedCases: [{ category: "real-bug" }, { category: "real-bug" }, { category: "flaky" }, { category: "environment" }], flakyCases: [{ isFlaky: true }, { isFlaky: true }, { isFlaky: true }] }),
      makeTask({ timestamp: "2025-01-29T10:00:00Z", passed: 7, failed: 3, totalCases: 10, durationMs: 6500, tokenCost: { input: 180, output: 90, total: 270 }, failedCases: [{ category: "real-bug" }, { category: "flaky" }, { category: "test-defect" }], flakyCases: [{ isFlaky: true }, { isFlaky: true }] }),
    ];
    const points = aggregateWeekly(tasks);
    expect(points).toHaveLength(4); // 4 周
    // 5 维度每个周点都有可计算值
    for (const p of points) {
      expect(typeof p.dimensions.passRate).toBe("number");
      expect(p.dimensions.failCategoryRatio).toBeDefined();
      expect(Object.keys(p.dimensions.failCategoryRatio)).toHaveLength(4);
      expect(typeof p.dimensions.flakyRate).toBe("number");
      expect(p.dimensions.avgDurationMs).not.toBeNull();
      expect(p.dimensions.tokenCost).not.toBeNull();
    }
    // 趋势非平：flaky 率第 4 周应高于第 1 周
    expect(points[3].dimensions.flakyRate).toBeGreaterThan(points[0].dimensions.flakyRate);
    // taskCount 累加：第 1 周 2 任务
    expect(points[0].taskCount).toBe(2);
  });

  it("tokenCost=null 的周：该维度标 null 不阻塞其他维度（PRD 降级）", () => {
    const tasks: MetricsTaskInput[] = [
      makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2, totalCases: 10, durationMs: 5000, tokenCost: null }),
    ];
    const points = aggregateWeekly(tasks);
    const d = points[0].dimensions;
    expect(d.tokenCost).toBeNull();
    expect(d.passRate).toBe(0.8);
    expect(d.avgDurationMs).toBe(5000);
    expect(d.flakyRate).toBe(0);
    expect(d.failCategoryRatio["real-bug"]).toBe(0.5);
  });

  it("tokenCost 混合：部分周有、部分无 → 序列非全 null（GUI 仅全 null 才显示『数据积累中』）", () => {
    const tasks: MetricsTaskInput[] = [
      makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: null }),
      makeTask({ timestamp: "2025-01-13T10:00:00Z", tokenCost: { input: 100, output: 50, total: 150 } }),
    ];
    const points = aggregateWeekly(tasks);
    expect(points).toHaveLength(2);
    expect(points[0].dimensions.tokenCost).toBeNull();
    expect(points[1].dimensions.tokenCost).toBe(150);
    // 非全 null → GUI 不会整体降级
    const allNull = points.every((p) => p.dimensions.tokenCost === null);
    expect(allNull).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PRD 6.5 场景 B：下钻到用例（系统→模块→用例）
// ---------------------------------------------------------------------------

/**
 * GUI dashboardModuleBreakdown 镜像（App.vue:132-161）。
 * 独立验证 r2 P1-1 修复：模块下钻加失败用例计数，passRate 不再始终 100%。
 * 独立验证 r3 P2-3 修复：用例 title 跨任务去重（Set）。
 */
function mirrorDashboardModuleBreakdown(history: Array<{
  cases?: Array<{ title: string; layer?: string }>;
  failedCases?: Array<{ layer?: string; category?: string }>;
  routing?: Array<{ layer: string; caseId: string }>;
}>): Array<{ layer: string; passRate: number; flakyRate: number; total: number }> {
  const layerData: Record<string, { titles: Set<string>; failed: number; flaky: number }> = {};
  for (const item of history) {
    const cases = item.cases ?? [];
    for (const c of cases) {
      const layer = c.layer ?? "unknown";
      if (!layerData[layer]) layerData[layer] = { titles: new Set(), failed: 0, flaky: 0 };
      layerData[layer].titles.add(c.title);
    }
    if (item.failedCases) {
      for (const fc of item.failedCases) {
        const layer = fc.layer ?? "unknown";
        if (!layerData[layer]) layerData[layer] = { titles: new Set(), failed: 0, flaky: 0 };
        layerData[layer].failed++;
        if (fc.category === "flaky") layerData[layer].flaky++;
      }
    }
    if (cases.length === 0 && item.routing) {
      for (const route of item.routing) {
        if (!layerData[route.layer]) layerData[route.layer] = { titles: new Set(), failed: 0, flaky: 0 };
        layerData[route.layer].titles.add(`route:${route.layer}:${route.caseId}`);
      }
    }
  }
  return Object.entries(layerData).map(([layer, d]) => {
    const total = d.titles.size;
    const passRate = total > 0 ? Math.round(((total - d.failed) / total) * 100) : 0;
    const flakyRate = total > 0 ? Math.round((d.flaky / total) * 100) : 0;
    return { layer, passRate, flakyRate, total };
  });
}

describe("[片3-验收] 场景B：下钻到用例（GUI 逻辑镜像）", () => {
  it("系统级周点为下钻基座（queryMetrics 返回多周序列）", () => {
    const dir = makeTempDir();
    try {
      writeWeeklyPoints(dir, "sys", [
        makePoint("2025-01-06T00:00:00.000Z", { passRate: 0.9 }),
        makePoint("2025-01-13T00:00:00.000Z", { passRate: 0.85 }),
        makePoint("2025-01-20T00:00:00.000Z", { passRate: 0.7 }),
      ]);
      const pts = queryMetrics(dir, "sys");
      expect(pts).toHaveLength(3);
      expect(pts.map((p) => p.dimensions.passRate)).toEqual([0.9, 0.85, 0.7]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("r2 P1-1 修复验证：模块下钻有失败用例时 passRate<100%（不再恒 100%）", () => {
    const breakdown = mirrorDashboardModuleBreakdown([
      {
        cases: [
          { title: "test_login", layer: "api" },
          { title: "test_logout", layer: "api" },
          { title: "test_unit_x", layer: "unit" },
        ],
        failedCases: [{ layer: "api", category: "real-bug" }],
      },
    ]);
    const apiMod = breakdown.find((m) => m.layer === "api");
    expect(apiMod).toBeDefined();
    expect(apiMod!.total).toBe(2);
    expect(apiMod!.passRate).toBe(50); // (2-1)/2 = 50%，非 100%
    const unitMod = breakdown.find((m) => m.layer === "unit");
    expect(unitMod!.passRate).toBe(100); // 无失败 → 100%
  });

  it("r3 P2-3 修复验证：同名用例跨任务去重（Set），total 不重复计", () => {
    const breakdown = mirrorDashboardModuleBreakdown([
      { cases: [{ title: "test_login", layer: "api" }], failedCases: [] },
      { cases: [{ title: "test_login", layer: "api" }], failedCases: [] }, // 同名同 layer 跨任务
      { cases: [{ title: "test_logout", layer: "api" }], failedCases: [] },
    ]);
    const apiMod = breakdown.find((m) => m.layer === "api");
    expect(apiMod!.total).toBe(2); // Set 去重：test_login + test_logout = 2，非 3
  });

  it("flaky 模块下钻：flakyRate 按 category=flaky 计数", () => {
    const breakdown = mirrorDashboardModuleBreakdown([
      {
        cases: [{ title: "t1", layer: "api" }, { title: "t2", layer: "api" }, { title: "t3", layer: "api" }, { title: "t4", layer: "api" }],
        failedCases: [{ layer: "api", category: "flaky" }, { layer: "api", category: "flaky" }],
      },
    ]);
    const apiMod = breakdown.find((m) => m.layer === "api");
    expect(apiMod!.flakyRate).toBe(50); // 2 flaky / 4 total = 50%
  });

  it("用例级下钻：按 layer 筛选列出具体用例（数据契约）", () => {
    // GUI dashboardCaseBreakdown 镜像：按 dashboardDrillLayer 筛选 cases
    const history = [
      { cases: [{ title: "test_login", layer: "api" }, { title: "test_unit", layer: "unit" }] },
    ];
    const drillLayer = "api";
    const cases: Array<{ title: string; layer: string }> = [];
    for (const item of history) {
      for (const c of item.cases ?? []) {
        if (c.layer === drillLayer) cases.push({ title: c.title, layer: c.layer });
      }
    }
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe("test_login");
  });
});

// ---------------------------------------------------------------------------
// PRD 6.5 场景 C：突变告警
// ---------------------------------------------------------------------------

describe("[片3-验收] 场景C：突变告警（detectAnomalies）", () => {
  it("flaky 率周环比上升 >10pp → 命中告警", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.03, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.18, passRate: 0.85 }),
    ];
    const alerts = detectAnomalies(points);
    const flakyAlert = alerts.find((a) => a.dimension === "flakyRate");
    expect(flakyAlert).toBeDefined();
    expect(flakyAlert!.from).toBeCloseTo(0.03, 2);
    expect(flakyAlert!.to).toBeCloseTo(0.18, 2);
    expect(flakyAlert!.message).toContain("Flaky");
    expect(flakyAlert!.weekStart).toBe("2025-01-13T00:00:00.000Z");
  });

  it("通过率周环比下降 >10pp → 命中告警", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { passRate: 0.9, flakyRate: 0 }),
      makePoint("2025-01-13T00:00:00.000Z", { passRate: 0.75, flakyRate: 0 }),
    ];
    const alerts = detectAnomalies(points);
    const passAlert = alerts.find((a) => a.dimension === "passRate");
    expect(passAlert).toBeDefined();
    expect(passAlert!.from).toBeCloseTo(0.9, 2);
    expect(passAlert!.to).toBeCloseTo(0.75, 2);
  });

  it("阈值可配：改阈值后结果变化（默认 10pp 不触发，1pp 触发）", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.03, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.05, passRate: 0.88 }),
    ];
    expect(detectAnomalies(points)).toHaveLength(0); // 默认 10pp：2pp 不触发
    const custom: AnomalyThresholds = { flakyRateIncreasePP: 1, passRateDecreasePP: 1 };
    expect(detectAnomalies(points, custom).length).toBeGreaterThanOrEqual(1);
  });

  it("边界探针-阈值等于：正好等于阈值不触发（严格 >）", () => {
    // flakyDeltaPP = (0.20 - 0.10)*100 = 10pp，等于阈值 10 → 严格 > 不触发
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.10, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.20, passRate: 0.9 }),
    ];
    const alerts = detectAnomalies(points, { flakyRateIncreasePP: 10, passRateDecreasePP: 10 });
    const flakyAlert = alerts.find((a) => a.dimension === "flakyRate");
    expect(flakyAlert).toBeUndefined(); // 等于不触发
    // 提升 0.01 → 10.0...1pp > 10 → 触发（浮点）
    const points2 = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.10, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.21, passRate: 0.9 }),
    ];
    const alerts2 = detectAnomalies(points2, { flakyRateIncreasePP: 10, passRateDecreasePP: 10 });
    expect(alerts2.find((a) => a.dimension === "flakyRate")).toBeDefined();
  });

  it("通过率上升不算突变（只检测下降）", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { passRate: 0.5, flakyRate: 0 }),
      makePoint("2025-01-13T00:00:00.000Z", { passRate: 0.9, flakyRate: 0 }),
    ];
    const alerts = detectAnomalies(points);
    expect(alerts.find((a) => a.dimension === "passRate")).toBeUndefined();
  });

  it("flaky 率下降不算突变（只检测上升）", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.5, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.1, passRate: 0.9 }),
    ];
    const alerts = detectAnomalies(points);
    expect(alerts.find((a) => a.dimension === "flakyRate")).toBeUndefined();
  });

  it("单点序列不触发（需相邻比较）", () => {
    const points = [makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.5, passRate: 0.1 })];
    expect(detectAnomalies(points)).toHaveLength(0);
  });

  it("默认阈值从环境变量读取（TEST_AGENT_ANOMALY_*_PP）", () => {
    const prevFlaky = process.env.TEST_AGENT_ANOMALY_FLAKY_PP;
    const prevPass = process.env.TEST_AGENT_ANOMALY_PASSRATE_PP;
    try {
      process.env.TEST_AGENT_ANOMALY_FLAKY_PP = "5";
      process.env.TEST_AGENT_ANOMALY_PASSRATE_PP = "5";
      const t = defaultAnomalyThresholds();
      expect(t.flakyRateIncreasePP).toBe(5);
      expect(t.passRateDecreasePP).toBe(5);
    } finally {
      if (prevFlaky === undefined) delete process.env.TEST_AGENT_ANOMALY_FLAKY_PP;
      else process.env.TEST_AGENT_ANOMALY_FLAKY_PP = prevFlaky;
      if (prevPass === undefined) delete process.env.TEST_AGENT_ANOMALY_PASSRATE_PP;
      else process.env.TEST_AGENT_ANOMALY_PASSRATE_PP = prevPass;
    }
  });
});

/**
 * GUI computeAnomalies 镜像（App.vue:295-322）。
 * 验证 GUI 前端突变检测与 Worker 一致，阈值从 VITE_ANOMALY_*_PP 读。
 */
function mirrorComputeAnomalies(points: WeeklyPoint[], flakyPP = 10, passPP = 10): Array<{ dimension: string; from: number; to: number; weekStart: string; message: string }> {
  const alerts: Array<{ dimension: string; from: number; to: number; weekStart: string; message: string }> = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const flakyDelta = (curr.dimensions.flakyRate - prev.dimensions.flakyRate) * 100;
    if (flakyDelta > flakyPP) {
      alerts.push({ dimension: "flakyRate", from: prev.dimensions.flakyRate, to: curr.dimensions.flakyRate, weekStart: curr.weekStart, message: `Flaky 率从 ${Math.round(prev.dimensions.flakyRate * 100)}% 升至 ${Math.round(curr.dimensions.flakyRate * 100)}%` });
    }
    const passDelta = (prev.dimensions.passRate - curr.dimensions.passRate) * 100;
    if (passDelta > passPP) {
      alerts.push({ dimension: "passRate", from: prev.dimensions.passRate, to: curr.dimensions.passRate, weekStart: curr.weekStart, message: `通过率从 ${Math.round(prev.dimensions.passRate * 100)}% 降至 ${Math.round(curr.dimensions.passRate * 100)}%` });
    }
  }
  return alerts;
}

describe("[片3-验收] GUI computeAnomalies 镜像（前端突变检测）", () => {
  it("与 Worker detectAnomalies 同阈值同结果", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.03, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.18, passRate: 0.75 }),
    ];
    const workerAlerts = detectAnomalies(points);
    const guiAlerts = mirrorComputeAnomalies(points);
    expect(guiAlerts.map((a) => a.dimension).sort()).toEqual(workerAlerts.map((a) => a.dimension).sort());
  });

  it("VITE_ANOMALY 阈值可配（GUI 侧）", () => {
    const points = [
      makePoint("2025-01-06T00:00:00.000Z", { flakyRate: 0.03, passRate: 0.9 }),
      makePoint("2025-01-13T00:00:00.000Z", { flakyRate: 0.05, passRate: 0.88 }),
    ];
    expect(mirrorComputeAnomalies(points, 10, 10)).toHaveLength(0);
    expect(mirrorComputeAnomalies(points, 1, 1).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：ISO 周跨年/跨月、单点、空数据
// ---------------------------------------------------------------------------

describe("[片3-验收] 边界探针：ISO 周跨年/跨月", () => {
  it("跨年：2024-12-30(周一) 与 2025-01-01(周三) 同周", () => {
    const ws1 = isoWeekStart("2024-12-30T10:00:00Z");
    const ws2 = isoWeekStart("2025-01-01T10:00:00Z");
    expect(ws1.toISOString()).toBe(ws2.toISOString());
    expect(ws1.toISOString()).toBe("2024-12-30T00:00:00.000Z");
    expect(ws1.getUTCDay()).toBe(1); // 周一
  });

  it("跨年：2025-01-06(周一) 是新周，与 2024-12-30 不同周", () => {
    const ws1 = isoWeekStart("2024-12-30T10:00:00Z");
    const ws3 = isoWeekStart("2025-01-06T10:00:00Z");
    expect(ws1.toISOString()).not.toBe(ws3.toISOString());
  });

  it("跨月（同周跨月）：2025-01-29(周三) 与 2025-02-01(周六) 同周（周一 1/27）", () => {
    const ws1 = isoWeekStart("2025-01-29T10:00:00Z");
    const ws2 = isoWeekStart("2025-02-01T10:00:00Z");
    expect(ws1.toISOString()).toBe(ws2.toISOString());
    expect(ws1.toISOString()).toBe("2025-01-27T00:00:00.000Z");
  });

  it("跨年聚合：2024-12-30 与 2025-01-01 任务归同一周点", () => {
    const tasks = [
      makeTask({ timestamp: "2024-12-30T10:00:00Z", passed: 8, failed: 2 }),
      makeTask({ timestamp: "2025-01-01T10:00:00Z", passed: 9, failed: 1 }),
    ];
    const points = aggregateWeekly(tasks);
    expect(points).toHaveLength(1); // 同周
    expect(points[0].weekStart).toBe("2024-12-30T00:00:00.000Z");
    expect(points[0].taskCount).toBe(2);
    // passRate = (8+9)/(10+10) = 0.85
    expect(points[0].dimensions.passRate).toBeCloseTo(0.85, 2);
  });

  it("周日回退到上周一（不进下一周）", () => {
    // 2025-01-12 是周日 → ISO 周周一应为 2025-01-06
    const ws = isoWeekStart("2025-01-12T10:00:00Z");
    expect(ws.toISOString()).toBe("2025-01-06T00:00:00.000Z");
  });
});

describe("[片3-验收] 边界探针：单周单点 / 空数据", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("单周单数据点：聚合产出 1 个周点，taskCount=1", () => {
    appendTaskToWeekly(dir, "single", makeTask({ timestamp: "2025-01-06T10:00:00Z" }));
    const pts = loadWeeklyPoints(dir, "single");
    expect(pts).toHaveLength(1);
    expect(pts[0].taskCount).toBe(1);
  });

  it("空数据：queryMetrics 返回 []，detectAnomalies 返回 []", () => {
    expect(loadWeeklyPoints(dir, "empty")).toEqual([]);
    expect(queryMetrics(dir, "empty")).toEqual([]);
    expect(detectAnomalies([])).toHaveLength(0);
  });

  it("queryMetrics range 不含任何周点 → 返回 []", () => {
    writeWeeklyPoints(dir, "r", [makePoint("2025-01-06T00:00:00.000Z"), makePoint("2025-01-13T00:00:00.000Z")]);
    const r = queryMetrics(dir, "r", { start: "2025-06-01T00:00:00.000Z", end: "2025-06-30T00:00:00.000Z" });
    expect(r).toEqual([]);
  });

  it("queryMetrics range 边界含等号（start/end 含端点）", () => {
    writeWeeklyPoints(dir, "r", [makePoint("2025-01-06T00:00:00.000Z"), makePoint("2025-01-13T00:00:00.000Z")]);
    const r = queryMetrics(dir, "r", { start: "2025-01-06T00:00:00.000Z", end: "2025-01-13T00:00:00.000Z" });
    expect(r).toHaveLength(2); // 含两端
  });
});

// ---------------------------------------------------------------------------
// 边界探针：mergeWeekPoint 精确合并（r3 P2 修复验证）
// ---------------------------------------------------------------------------

describe("[片3-验收] 边界探针：mergeWeekPoint 精确合并", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("passRate 按用例数加权（非 taskCount 加权）—— r3 P2 核心", () => {
    // Task1: 10 cases 8 pass → 0.8; Task2: 20 cases 10 pass → 0.5
    // 正确: (8+10)/(10+20)=18/30=0.6; 错误(taskCount): (0.8+0.5)/2=0.65
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2, totalCases: 10 }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", passed: 10, failed: 10, totalCases: 20 }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts).toHaveLength(1);
    expect(pts[0].dimensions.passRate).toBeCloseTo(0.6, 2);
    expect(pts[0].dimensions.passRate).not.toBeCloseTo(0.65, 2);
    expect(pts[0].taskCount).toBe(2);
  });

  it("tokenCost 精确合并：两任务都有 token → 总和", () => {
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: { input: 100, output: 50, total: 150 } }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", tokenCost: { input: 200, output: 100, total: 300 } }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.tokenCost).toBe(450); // 150 + 300
  });

  it("tokenCost 合并：existing 有 + new null → 保留 existing", () => {
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: { input: 100, output: 50, total: 150 } }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", tokenCost: null }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.tokenCost).toBe(150); // 保留，不被 null 清零
  });

  it("tokenCost 合并：existing null + new 有 → 取 new", () => {
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", tokenCost: null }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", tokenCost: { input: 100, output: 50, total: 150 } }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.tokenCost).toBe(150);
  });

  it("avgDurationMs 精确合并：按任务数算术平均（非 taskCount 加权）", () => {
    // Task1: 4000ms, Task2: 6000ms → (4000+6000)/2 = 5000
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", durationMs: 4000 }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", durationMs: 6000 }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.avgDurationMs).toBe(5000);
  });

  it("avgDurationMs 合并：existing 有 + new null → 保留 existing（不除以 2）", () => {
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", durationMs: 4000 }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", durationMs: null }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.avgDurationMs).toBe(4000); // 保留，不被 null 拉低
  });

  it("failCategoryRatio 精确合并：失败计数累加后重算", () => {
    // Task1: 1 real-bug, 1 test-defect → real=0.5, test=0.5
    // Task2: 2 real-bug, 0 test → real=1.0, test=0
    // 合并: 3 real-bug, 1 test-defect → real=0.75, test=0.25
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", passed: 8, failed: 2, failedCases: [{ category: "real-bug" }, { category: "test-defect" }] }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", passed: 8, failed: 2, failedCases: [{ category: "real-bug" }, { category: "real-bug" }] }));
    const pts = loadWeeklyPoints(dir, "w");
    const ratio = pts[0].dimensions.failCategoryRatio;
    expect(ratio["real-bug"]).toBeCloseTo(0.75, 2);
    expect(ratio["test-defect"]).toBeCloseTo(0.25, 2);
  });

  it("flakyRate 精确合并：flaky 数与 totalCases 累加后重算", () => {
    // Task1: 10 cases, 1 flaky → 0.1; Task2: 10 cases, 3 flaky → 0.3
    // 合并: 4 flaky / 20 cases = 0.2
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-06T10:00:00Z", totalCases: 10, flakyCases: [{ isFlaky: true }, { isFlaky: false }, { isFlaky: false }, { isFlaky: false }] }));
    appendTaskToWeekly(dir, "w", makeTask({ timestamp: "2025-01-07T10:00:00Z", totalCases: 10, flakyCases: [{ isFlaky: true }, { isFlaky: true }, { isFlaky: true }, { isFlaky: false }] }));
    const pts = loadWeeklyPoints(dir, "w");
    expect(pts[0].dimensions.flakyRate).toBeCloseTo(0.2, 2);
  });

  it("降级路径：旧文件无 totals → taskCount 加权近似（与精确合并不同）", () => {
    // 先写一个无 totals 的旧周点
    const legacy: WeeklyPoint = {
      weekStart: "2025-01-06T00:00:00.000Z",
      taskCount: 1,
      dimensions: {
        passRate: 0.8,
        failCategoryRatio: { "real-bug": 1, "test-defect": 0, environment: 0, flaky: 0 },
        flakyRate: 0,
        avgDurationMs: 4000,
        tokenCost: null,
      },
      // 无 totals 字段
    };
    writeWeeklyPoints(dir, "legacy", [legacy]);
    appendTaskToWeekly(dir, "legacy", makeTask({ timestamp: "2025-01-07T10:00:00Z", passed: 5, failed: 5, totalCases: 10, durationMs: 6000 }));
    const pts = loadWeeklyPoints(dir, "legacy");
    expect(pts).toHaveLength(1);
    expect(pts[0].taskCount).toBe(2);
    // 降级 taskCount 加权: (0.8*1 + 0.5*1)/2 = 0.65（非精确 0.6）
    expect(pts[0].dimensions.passRate).toBeCloseTo(0.65, 2);
    expect(pts[0].dimensions.passRate).not.toBeCloseTo(0.6, 2);
  });
});

// ---------------------------------------------------------------------------
// 独立判断点（KEY）：fitness 多轮 retest 不污染聚合
// ---------------------------------------------------------------------------

function makeRunResult(passed: number, failed: number, coverage: number | null, failedCases?: unknown[]): AgentRunResult {
  return {
    lanes: [],
    report: {
      passed,
      failed,
      coverage,
      ...(failedCases ? { failedCases: failedCases as never } : {}),
    },
    artifacts: [],
  } as AgentRunResult;
}

const noopEmit = (_event: AgentEvent): void => {};

const baseInput: TaskInput = {
  projectPath: "/tmp/p1-metrics-mock", // 会被测试覆盖为 temp dir
  systemName: "mock",
  version: "1.0",
  testTypes: ["unit"],
};

const mockCases: TestCase[] = [
  { id: "TC001", title: "case1", scenario: "", steps: [], expected: "", priority: "medium", layer: "unit" },
];

function failedCase(category = "test-defect"): unknown {
  return { name: "c1", layer: "unit", error: "err", category, confidence: "low" };
}

describe("[片3-验收] 独立判断点：fitness 多轮 retest 不污染聚合", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("runFitnessDrivenExecute 调 runExecute 3 次（baseline+2 retest），但 weekly.jsonl taskCount=1", async () => {
    // 真实 runFitnessDrivenExecute（不 mock 它），mock runExecute/runFix/runScout/runCaseDesign
    const runner = new Runner({ providers: {} } as never, undefined, undefined, undefined);
    let executeCalls = 0;
    // runExecute 序列：baseline(failed>0) → retest1(failed>0) → retest2(failed=0 收敛)
    runner.runExecute = async function () {
      executeCalls++;
      const seq = [
        makeRunResult(3, 4, 50, [failedCase()]),
        makeRunResult(3, 4, 50, [failedCase()]), // improvement=false，K=3 不停
        makeRunResult(7, 0, 80), // 收敛
      ];
      const r = seq[executeCalls - 1] ?? seq[seq.length - 1];
      return { ...r };
    } as never;
    runner.runFix = async function () {
      return { phase: "fix", report: { passed: 0, failed: 0, coverage: null }, lanes: [], artifacts: [] } as never;
    } as never;
    runner.runScout = async function () {
      return { report: { summary: "scout" } } as never;
    } as never;
    runner.runCaseDesign = async function () {
      return { cases: mockCases } as never;
    } as never;

    const input: TaskInput = { ...baseInput, projectPath: dir };
    await runner.run(input, noopEmit, undefined, { fitnessDriven: true } as never);

    // runExecute 被调 3 次（fitness 多轮）
    expect(executeCalls).toBe(3);
    // 但聚合只发生 1 次（execWithMetrics 在 run() 层，fitness 循环外）
    const hash = computeProjectHash(dir);
    const pts = loadWeeklyPoints(join(dir, ".test-agent", "metrics"), hash);
    expect(pts).toHaveLength(1);
    expect(pts[0].taskCount).toBe(1); // 关键：不虚高
    // 聚合的是最终收敛结果（7 过 0 失）
    expect(pts[0].dimensions.passRate).toBe(1.0);
  });

  it("非 fitness 路径：runExecute 调 1 次，taskCount=1", async () => {
    const runner = new Runner({ providers: {} } as never, undefined, undefined, undefined);
    let executeCalls = 0;
    runner.runExecute = async function () {
      executeCalls++;
      return makeRunResult(7, 3, 60, [failedCase(), failedCase(), failedCase()]);
    } as never;
    runner.runScout = async function () {
      return { report: { summary: "scout" } } as never;
    } as never;
    runner.runCaseDesign = async function () {
      return { cases: mockCases } as never;
    } as never;

    const input: TaskInput = { ...baseInput, projectPath: dir };
    await runner.run(input, noopEmit); // 无 fitnessDriven

    expect(executeCalls).toBe(1);
    const hash = computeProjectHash(dir);
    const pts = loadWeeklyPoints(join(dir, ".test-agent", "metrics"), hash);
    expect(pts).toHaveLength(1);
    expect(pts[0].taskCount).toBe(1);
    expect(pts[0].dimensions.passRate).toBeCloseTo(7 / 10, 2);
  });
});

describe("[片3-验收] 独立判断点：execWithMetrics 异常降级", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("metrics 写入失败（.test-agent 是文件非目录）→ run() 仍返回 result，不抛", async () => {
    // 在 dir 下创建文件 ".test-agent"，使 mkdirSync(dir/.test-agent/metrics) 抛 ENOTDIR/EEXIST
    writeFileSync(join(dir, ".test-agent"), "blocker", "utf8");

    const runner = new Runner({ providers: {} } as never, undefined, undefined, undefined);
    runner.runExecute = async function () {
      return makeRunResult(8, 2, 70, [failedCase(), failedCase()]);
    } as never;
    runner.runScout = async function () {
      return { report: { summary: "scout" } } as never;
    } as never;
    runner.runCaseDesign = async function () {
      return { cases: mockCases } as never;
    } as never;

    const input: TaskInput = { ...baseInput, projectPath: dir };
    let warned = false;
    const emit = (e: AgentEvent) => {
      if (e.type === "log" && (e as { message?: string }).message?.includes("质量趋势聚合异常")) warned = true;
    };
    // 不应抛错
    const result = await runner.run(input, emit);
    expect(result.report.passed).toBe(8);
    expect(warned).toBe(true); // emit 了 warning
    // 无 weekly.jsonl 产生
    const hash = computeProjectHash(dir);
    expect(existsSync(join(dir, ".test-agent", "metrics", hash, "weekly.jsonl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 独立判断点：聚合真在 Worker 本地（无 services/ 调用）
// ---------------------------------------------------------------------------

describe("[片3-验收] 独立判断点：聚合在 Worker 本地（文件系统）", () => {
  it("metricsDir = baseDir/<projectHash>，路径在 .test-agent/metrics 下", () => {
    // 镜像 metricsDir 逻辑（已 import）确认路径布局
    const baseDir = join("/tmp", "proj", ".test-agent", "metrics");
    const hash = "abc123";
    const expected = join(baseDir, hash);
    expect(metricsDir(baseDir, hash)).toBe(expected);
  });

  it("appendTaskToWeekly 写入路径 = <projectPath>/.test-agent/metrics/<hash>/weekly.jsonl", () => {
    const dir = makeTempDir();
    try {
      appendTaskToWeekly(dir, "localhash", makeTask({ timestamp: "2025-01-06T10:00:00Z" }));
      expect(existsSync(join(dir, "localhash", "weekly.jsonl"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractMetricsInput / sumTimelineDuration 边界
// ---------------------------------------------------------------------------

describe("[片3-验收] extractMetricsInput / sumTimelineDuration 边界", () => {
  it("extractMetricsInput：fitness.tokenCost=null → tokenCost=null（数据积累中）", () => {
    const input = extractMetricsInput({ passed: 8, failed: 2, fitness: { tokenCost: null } }, "2025-01-06T10:00:00Z", 10, 5000);
    expect(input.tokenCost).toBeNull();
    expect(input.passed).toBe(8);
  });

  it("extractMetricsInput：fitness 缺失 → tokenCost=null", () => {
    const input = extractMetricsInput({ passed: 10, failed: 0 }, "2025-01-06T10:00:00Z", 10);
    expect(input.tokenCost).toBeNull();
  });

  it("extractMetricsInput：durationMs=undefined → null", () => {
    const input = extractMetricsInput({ passed: 10, failed: 0 }, "2025-01-06T10:00:00Z", 10);
    expect(input.durationMs).toBeNull();
  });

  it("sumTimelineDuration：部分阶段无 durationMs → 仅累加有值的", () => {
    expect(sumTimelineDuration([{ durationMs: 1000 }, {}, { durationMs: 2000 }])).toBe(3000);
  });

  it("sumTimelineDuration：全无 durationMs → null", () => {
    expect(sumTimelineDuration([{}, {}])).toBeNull();
  });
});
