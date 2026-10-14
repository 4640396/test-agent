/**
 * tester-found bug #21 复现测试：aggregateTesterResults 多 testTypes 聚合时
 * qualityGate 丢失（failed>0 时 undefined）+ recording 丢失
 *
 * 发现者：tester（GUI 真实效果验证第 1 轮）
 * 模块：packages/test-agent/src/core/coordinator.ts aggregateTesterResults（line 338）
 *
 * bug 描述：
 *   host-mode 默认 coordinatorEnabled=true。多 testTypes 时 aggregateTesterResults 聚合子代理结果。
 *   bug 1：qualityGate = failed===0 && flakyCases.length===0 ? {status:"passed"} : undefined
 *          —— failed>0 或有 flaky 时 undefined（丢弃，不调 evaluateQualityGate 重新评估）
 *   bug 2：fullReport 拼接只有 timeline/screenshots/uiSteps，缺 recording
 *          —— AgentFullReport 含 recording（{video?,trace?}），聚合时丢失
 *
 * 严重性：P2——多 testTypes 并行时质量门禁 + recording 丢失。
 */

import { describe, it, expect } from "vitest";
import { Coordinator } from "../src/core/coordinator.js";
import type { AgentRunResult } from "../src/core/types.js";

// 反射调 private aggregateTesterResults
function callAggregate(coordinator: Coordinator, subResults: AgentRunResult[]): AgentRunResult {
  const fn = (coordinator as unknown as { aggregateTesterResults: (r: AgentRunResult[], i: unknown) => AgentRunResult }).aggregateTesterResults;
  return fn.call(coordinator, subResults, { testTypes: ["unit", "ui"] });
}

describe("[tester-found] bug #21 aggregateTesterResults qualityGate + recording 丢失", () => {
  it("bug 1：两子代理 failed>0 → qualityGate 重新评估非 undefined（修复后回归守卫）", () => {
    const coord = new Coordinator({} as never, undefined, undefined);
    const sub1: AgentRunResult = {
      phase: "execute", lanes: [],
      report: { passed: 3, failed: 1, coverage: 80, failedCases: [{ name: "TC1", layer: "unit", error: "err", category: "real-bug", confidence: "low" }] },
      artifacts: [], cases: [{ id: "TC1", title: "用例1", scenario: "s", steps: [], expected: "e", priority: "medium" }],
    };
    const sub2: AgentRunResult = {
      phase: "execute", lanes: [],
      report: { passed: 2, failed: 0, coverage: 90 },
      artifacts: [], cases: [{ id: "TC2", title: "用例2", scenario: "s", steps: [], expected: "e", priority: "medium" }],
    };
    const aggregated = callAggregate(coord, [sub1, sub2]);
    // 期望：failed>0 时 qualityGate 应重新评估（status="failed"），非 undefined
    // 实际（bug）：qualityGate undefined
    expect(aggregated.report.qualityGate).toBeDefined(); // ← FAIL：实际 undefined
    expect(aggregated.report.qualityGate?.status).toBe("failed"); // failed>0 → status="failed"
  });

  it("bug 2：子代理有 recording → 聚合后 fullReport.recording 保留（修复后回归守卫）", () => {
    const coord = new Coordinator({} as never, undefined, undefined);
    const sub1: AgentRunResult = {
      phase: "execute", lanes: [],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: [], cases: [{ id: "TC1", title: "用例1", scenario: "s", steps: [], expected: "e", priority: "medium" }],
      fullReport: { recording: { video: "video.webm", trace: "trace.zip" }, uiSteps: [{ name: "step1", status: "passed" }] },
    };
    const sub2: AgentRunResult = {
      phase: "execute", lanes: [],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: [], cases: [{ id: "TC2", title: "用例2", scenario: "s", steps: [], expected: "e", priority: "medium" }],
    };
    const aggregated = callAggregate(coord, [sub1, sub2]);
    // 期望：fullReport.recording 保留（取首个非空）
    // 实际（bug）：recording 丢失（fullReport 无 recording 字段）
    expect(aggregated.fullReport?.recording).toBeDefined(); // ← FAIL：实际 undefined
    expect(aggregated.fullReport?.recording?.video).toBe("video.webm");
  });
});
