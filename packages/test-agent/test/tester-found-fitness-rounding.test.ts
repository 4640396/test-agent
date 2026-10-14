/**
 * tester-found bug 复现测试：fitness passRate 四舍五入致 failed>0 时误判 converged。
 *
 * 发现者：tester（持续 bug 修复循环第 1 轮）
 * 模块：packages/test-agent/src/core/fitness.ts evaluateFitness
 *
 * bug 描述：
 *   computePassRate 用 `Math.round((passed/total)*1000)/10` 保留一位小数。
 *   当 passed/total ≥ 0.9995 时，Math.round(...*1000) 进位到 1000，passRate = 100。
 *   evaluateFitness 判停顺序：先查 failed<=0（no-failures），再查 passRate>=100（converged）。
 *   failed>0 时跳过 no-failures 分支，但 passRate 因四舍五入 = 100 → 命中 converged 分支，
 *   返回 "自修复收敛：第 N 轮通过率达 100%"，stoppedReason='converged'，shouldStop=true。
 *   实际仍有失败用例未修——fix 循环被提前终止，上报虚假成功。
 *
 * 触发条件：total≥2000 且 failed/total≤0.0005（如 2000 用例 1 失败、10000 用例 1~5 失败）。
 * 严重性建议：P1（提前收敛终止修复循环 + 虚假成功信号，影响自修复可靠性）。
 *
 * 预期修复方向（由 reviewer/worker 定）：
 *   - passRate>=100 分支加 failed===0 守卫；或
 *   - computePassRate 在 failed>0 时不上取整到 100（floor 而非 round，或显式夹断）。
 */

import { describe, it, expect } from "vitest";
import { makeCurvePoint, evaluateFitness } from "../src/core/fitness.js";

describe("[tester-found] fitness passRate 四舍五入致 failed>0 误判 converged", () => {
  it("passed=1999 failed=1（total=2000）：passRate 四舍五入为 100，evaluateFitness 误判 converged", () => {
    const baseline = makeCurvePoint(0, 1998, 2, null);
    const point = makeCurvePoint(1, 1999, 1, null, baseline);

    // 复现：四舍五入把 99.95 → 100.0
    expect(point.passRate).toBe(100);
    expect(point.failed).toBe(1); // 仍有 1 个失败用例

    const decision = evaluateFitness([baseline, point], 3);

    // 期望行为：仍有失败用例，不应 converged / 不应停
    // 实际行为（bug）：passRate>=100 → converged=true, shouldStop=true
    expect(decision.converged).toBe(false); // ← 此行 FAIL，复现 bug
    expect(decision.shouldStop).toBe(false);
    expect(decision.stoppedReason).not.toBe("converged");
  });

  it("更大规模 passed=9999 failed=1（total=10000）：同样误判 converged", () => {
    const baseline = makeCurvePoint(0, 9998, 2, null);
    const point = makeCurvePoint(1, 9999, 1, null, baseline);

    expect(point.passRate).toBe(100);
    expect(point.failed).toBe(1);

    const decision = evaluateFitness([baseline, point], 3);
    expect(decision.converged).toBe(false); // ← FAIL
  });
});
