import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordRun,
  loadRuns,
  computePassRate,
  isHistorySufficient,
  isSuspiciousByHistory,
  identifySuspiciousReasons,
  detectFlaky,
  detectFlakyBatch,
  defaultFlakyConfig,
  type CaseRun,
  type FlakyConfig,
  type RerunExecutor,
} from "../src/core/flaky.js";
import type { DiagnosisCategory } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flaky-"));
}

/** 向 runs.jsonl 写入 N 条历史记录。 */
function seedHistory(baseDir: string, caseId: string, passCount: number, failCount: number): void {
  for (let i = 0; i < passCount; i++) recordRun(baseDir, caseId, true);
  for (let i = 0; i < failCount; i++) recordRun(baseDir, caseId, false);
}

// ---------------------------------------------------------------------------
// 执行历史存储
// ---------------------------------------------------------------------------

describe("recordRun + loadRuns", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("appends a run and loads it back", () => {
    recordRun(dir, "case001", true);
    const runs = loadRuns(dir, "case001");
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(true);
    expect(runs[0].timestamp).toBeTruthy();
  });

  it("appends multiple runs in order", () => {
    recordRun(dir, "case001", true);
    recordRun(dir, "case001", false);
    recordRun(dir, "case001", true);
    const runs = loadRuns(dir, "case001");
    expect(runs).toHaveLength(3);
    expect(runs[0].passed).toBe(true);
    expect(runs[1].passed).toBe(false);
    expect(runs[2].passed).toBe(true);
  });

  it("stores at .test-agent/cases/<hash>/<caseId>/runs.jsonl", () => {
    recordRun(dir, "case001", true);
    const filePath = join(dir, "case001", "runs.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8").trim();
    const parsed = JSON.parse(content) as CaseRun;
    expect(parsed.passed).toBe(true);
  });

  it("returns empty array for non-existent case", () => {
    expect(loadRuns(dir, "nonexistent")).toEqual([]);
  });

  it("respects limit parameter (takes most recent N)", () => {
    for (let i = 0; i < 15; i++) recordRun(dir, "case001", i % 2 === 0);
    const runs = loadRuns(dir, "case001", 10);
    expect(runs).toHaveLength(10);
  });

  it("skips corrupted lines", () => {
    // Write valid + corrupted entries
    recordRun(dir, "case001", true);
    const filePath = join(dir, "case001", "runs.jsonl");
    // Append a corrupted line
    const { appendFileSync } = require("node:fs");
    appendFileSync(filePath, "not json\n");
    recordRun(dir, "case001", false);
    const runs = loadRuns(dir, "case001");
    expect(runs).toHaveLength(2); // corrupted line skipped
    expect(runs[0].passed).toBe(true);
    expect(runs[1].passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 通过率计算
// ---------------------------------------------------------------------------

describe("computePassRate", () => {
  it("returns 1.0 for empty runs (conservative)", () => {
    expect(computePassRate([])).toBe(1.0);
  });

  it("computes pass rate correctly", () => {
    const runs: CaseRun[] = [
      { passed: true, timestamp: "2025-01-01T00:00:00Z" },
      { passed: true, timestamp: "2025-01-02T00:00:00Z" },
      { passed: false, timestamp: "2025-01-03T00:00:00Z" },
    ];
    expect(computePassRate(runs)).toBeCloseTo(2 / 3);
  });

  it("returns 0 for all failures", () => {
    const runs: CaseRun[] = [
      { passed: false, timestamp: "2025-01-01T00:00:00Z" },
      { passed: false, timestamp: "2025-01-02T00:00:00Z" },
    ];
    expect(computePassRate(runs)).toBe(0);
  });

  it("returns 1 for all passes", () => {
    const runs: CaseRun[] = [
      { passed: true, timestamp: "2025-01-01T00:00:00Z" },
      { passed: true, timestamp: "2025-01-02T00:00:00Z" },
    ];
    expect(computePassRate(runs)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 历史充足性
// ---------------------------------------------------------------------------

describe("isHistorySufficient", () => {
  it("returns false when history < min", () => {
    expect(isHistorySufficient([], 3)).toBe(false);
    expect(isHistorySufficient(
      [{ passed: true, timestamp: "t" }],
      3,
    )).toBe(false);
  });

  it("returns true when history >= min", () => {
    expect(isHistorySufficient(
      [
        { passed: true, timestamp: "t1" },
        { passed: false, timestamp: "t2" },
        { passed: true, timestamp: "t3" },
      ],
      3,
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 可疑用例识别
// ---------------------------------------------------------------------------

describe("isSuspiciousByHistory", () => {
  const config = defaultFlakyConfig();

  it("returns false when history insufficient (<3)", () => {
    const dir = makeTempDir();
    try {
      seedHistory(dir, "case1", 1, 1); // 2 runs, < 3
      const runs = loadRuns(dir, "case1", 10);
      expect(isSuspiciousByHistory(runs, config)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when pass rate < 90% with sufficient history", () => {
    // PRD 6.5 场景B: 7 过 3 失 → 70% < 90%
    const dir = makeTempDir();
    try {
      seedHistory(dir, "case1", 7, 3); // 10 runs, 70% pass rate
      const runs = loadRuns(dir, "case1", 10);
      expect(isSuspiciousByHistory(runs, config)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when pass rate >= 90% with sufficient history", () => {
    const dir = makeTempDir();
    try {
      seedHistory(dir, "case1", 9, 1); // 10 runs, 90% pass rate
      const runs = loadRuns(dir, "case1", 10);
      expect(isSuspiciousByHistory(runs, config)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("identifySuspiciousReasons", () => {
  const config = defaultFlakyConfig();

  it("includes diagnosis reason when category is flaky", () => {
    const reasons = identifySuspiciousReasons([], "flaky", config);
    expect(reasons).toContain("诊断标记 flaky");
  });

  it("includes history reason when pass rate < threshold", () => {
    const dir = makeTempDir();
    try {
      seedHistory(dir, "case1", 7, 3);
      const runs = loadRuns(dir, "case1", 10);
      const reasons = identifySuspiciousReasons(runs, undefined, config);
      expect(reasons.length).toBe(1);
      expect(reasons[0]).toContain("通过率");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes both reasons when both apply", () => {
    const dir = makeTempDir();
    try {
      seedHistory(dir, "case1", 7, 3);
      const runs = loadRuns(dir, "case1", 10);
      const reasons = identifySuspiciousReasons(runs, "flaky", config);
      expect(reasons).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when not suspicious", () => {
    const reasons = identifySuspiciousReasons([], "real-bug", config);
    expect(reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectFlaky — PRD 6.5 场景 A/B/C
// ---------------------------------------------------------------------------

describe("detectFlaky", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("场景A: 重跑判定 flaky — 5 次重跑 2 过 3 失 → flaky", async () => {
    const caseId = "case-flaky-A";
    // 诊断标 flaky → suspicious
    const rerunResults = [true, false, true, false, false]; // 2/5 = 40% < 80%
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    const record = await detectFlaky(dir, caseId, "Flaky用例A", "flaky", rerunExecutor);

    expect(record.isFlaky).toBe(true);
    expect(record.rerunResults).toEqual([true, false, true, false, false]);
    expect(record.rerunPassRate).toBeCloseTo(0.4);
    expect(record.reason).toContain("5 次重跑");
    expect(record.reason).toContain("2 过 3 失");
    expect(record.suspiciousReasons).toContain("诊断标记 flaky");
  });

  it("场景A: 重跑判定非 flaky — 5 次重跑 5 过 0 失 → 非 flaky", async () => {
    const caseId = "case-stable";
    const rerunExecutor: RerunExecutor = async () => true; // 全过

    const record = await detectFlaky(dir, caseId, "稳定用例", "flaky", rerunExecutor);

    expect(record.isFlaky).toBe(false);
    expect(record.rerunPassRate).toBe(1.0);
    expect(record.reason).toContain("5 过 0 失");
  });

  it("场景B: 历史通过率触发 — 70% < 90% → suspicious → 重跑确认", async () => {
    const caseId = "case-history-B";
    // 先写入历史：7 过 3 失 = 70%
    seedHistory(dir, caseId, 7, 3);
    // 重跑 4 过 1 失 = 80% → 不判 flaky (>= 80%)
    const rerunResults = [true, false, true, true, true];
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    const record = await detectFlaky(dir, caseId, "历史可疑用例B", undefined, rerunExecutor);

    expect(record.isFlaky).toBe(false); // 80% >= 80% → 非 flaky
    expect(record.historyPassRate).toBeCloseTo(0.7);
    expect(record.historyCount).toBe(10);
    expect(record.suspiciousReasons.some((r) => r.includes("70%"))).toBe(true);
  });

  it("场景B: 历史通过率触发 + 重跑确认 flaky — 70% < 90%, 重跑 60% < 80%", async () => {
    const caseId = "case-history-B-flaky";
    seedHistory(dir, caseId, 7, 3);
    // 重跑 3 过 2 失 = 60% < 80% → flaky
    const rerunResults = [true, false, true, false, true];
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    const record = await detectFlaky(dir, caseId, "历史可疑用例B-flaky", undefined, rerunExecutor);

    expect(record.isFlaky).toBe(true);
    expect(record.rerunPassRate).toBeCloseTo(0.6);
    expect(record.historyPassRate).toBeCloseTo(0.7);
  });

  it("历史不足（<3次）不判 flaky — 靠诊断+重跑双保险", async () => {
    const caseId = "case-insufficient";
    // 只写入 2 条历史（< 3）→ 历史不触发可疑
    seedHistory(dir, caseId, 1, 1);
    // 但诊断标 flaky → 仍可疑 → 重跑
    const rerunResults = [true, false, true, false, false];
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    const record = await detectFlaky(dir, caseId, "历史不足用例", "flaky", rerunExecutor);

    // 诊断标 flaky → suspicious → 重跑 → 2/5 = 40% < 80% → flaky
    expect(record.isFlaky).toBe(true);
    expect(record.historyCount).toBe(2);
    expect(record.suspiciousReasons).toContain("诊断标记 flaky");
    // 历史不足不产生历史可疑原因
    expect(record.suspiciousReasons.some((r) => r.includes("通过率"))).toBe(false);
  });

  it("历史不足且无诊断 → 不可疑 → 不判 flaky", async () => {
    const caseId = "case-no-evidence";
    seedHistory(dir, caseId, 1, 1); // 2 条历史

    const record = await detectFlaky(dir, caseId, "无证据用例", undefined, async () => true);

    expect(record.isFlaky).toBe(false);
    expect(record.suspiciousReasons).toEqual([]);
    expect(record.reason).toContain("不可疑");
  });

  it("可疑但无重跑执行器 → 不判 flaky，标注原因", async () => {
    const caseId = "case-no-rerun";
    seedHistory(dir, caseId, 7, 3); // 70% < 90% → suspicious

    const record = await detectFlaky(dir, caseId, "无重跑用例", undefined, undefined);

    expect(record.isFlaky).toBe(false);
    expect(record.suspiciousReasons.length).toBeGreaterThan(0);
    expect(record.reason).toContain("未执行重跑");
  });

  it("重跑全失 → 持续失败（真 bug），不判 flaky", async () => {
    const caseId = "case-rerun-error";
    const rerunExecutor: RerunExecutor = async () => { throw new Error("connection timeout"); };

    const record = await detectFlaky(dir, caseId, "重跑异常用例", "flaky", rerunExecutor);

    // P2 修复：0% 通过率 = 持续失败 = 真 bug，不是 flaky
    expect(record.isFlaky).toBe(false); // 0/5 = 0% → 持续失败，不判 flaky
    expect(record.rerunResults).toEqual([false, false, false, false, false]);
    expect(record.reason).toContain("持续失败");
  });

  it("重跑全失（正常返回 false）→ 持续失败，不判 flaky", async () => {
    const caseId = "case-consistent-fail";
    const rerunExecutor: RerunExecutor = async () => false; // 全失，无异常

    const record = await detectFlaky(dir, caseId, "持续失败用例", "flaky", rerunExecutor);

    // P2 修复：0% 通过率 = 持续失败 = 真 bug，不是 flaky
    expect(record.isFlaky).toBe(false);
    expect(record.rerunPassRate).toBe(0);
    expect(record.reason).toContain("持续失败");
  });

  it("自定义配置覆盖默认值", async () => {
    const caseId = "case-custom-config";
    // 1 过 2 失 = 33% < 50% → flaky（至少 1 次通过，符合 flaky 定义）
    const rerunResults = [true, false, false];
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    // 自定义：重跑 3 次，阈值 50%
    const record = await detectFlaky(dir, caseId, "自定义配置用例", "flaky", rerunExecutor, {
      rerunCount: 3,
      rerunPassRateThreshold: 0.5,
    });

    expect(record.isFlaky).toBe(true); // 1/3 = 33% < 50% → flaky
    expect(record.rerunResults).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// detectFlakyBatch
// ---------------------------------------------------------------------------

describe("detectFlakyBatch", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("detects flaky for multiple cases", async () => {
    const cases = [
      { id: "case1", title: "用例1" },
      { id: "case2", title: "用例2" },
    ];
    const diagnosisByTitle = new Map<string, DiagnosisCategory>([
      ["用例1", "flaky"],
      ["用例2", "real-bug"],
    ]);
    // 2 过 3 失 = 40% < 80% → flaky（至少 1 次通过，符合 flaky 定义）
    const rerunResults = [true, false, true, false, false];
    const rerunExecutor: RerunExecutor = async () => rerunResults.shift() ?? false;

    const records = await detectFlakyBatch(dir, cases, diagnosisByTitle, rerunExecutor);

    expect(records).toHaveLength(2);
    // 用例1: diagnosis flaky → suspicious → rerun 2/5 = 40% < 80% → flaky
    expect(records[0].isFlaky).toBe(true);
    // 用例2: diagnosis real-bug → not suspicious by diagnosis; no history → not suspicious
    expect(records[1].isFlaky).toBe(false);
  });
});
