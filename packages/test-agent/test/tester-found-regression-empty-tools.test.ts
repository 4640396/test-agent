/**
 * tester-found bug #8 回归守卫：allowedTestToolNames 必须含 regression case
 *
 * 发现者：tester（持续 bug 修复循环第 8 轮）
 * 模块：packages/test-agent/src/core/runner.ts allowedTestToolNames（line 353-370）
 *
 * bug 回顾：
 *   allowedTestToolNames 的 switch 无 regression case → regression 单选返回空 set →
 *   buildToolsForScenario 裁剪掉所有测试工具 → LLM 无测试工具可跑 → 任务必失败。
 *   修复（commit fc9d292）：加 regression case 映射所有测试工具。
 *
 * 回归守卫策略：
 *   allowedTestToolNames/buildToolsForScenario 是 runner.ts 内部函数（非 export），
 *   端到端 runExecute 需 mock LLM + 工具执行，复杂度高。改用源码断言——读 runner.ts
 *   文本验证 `case "regression"` 在 allowedTestToolNames 函数体中存在，防止 regression case
 *   被误删回归到 bug #8。若未来重构导出 allowedTestToolNames，可改为直接单测。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("[tester-found] bug #8 回归守卫：allowedTestToolNames 含 regression case", () => {
  it("runner.ts allowedTestToolNames 函数体含 case \"regression\"（映射所有测试工具）", () => {
    const runnerSrc = readFileSync(
      resolve(process.cwd(), "packages/test-agent/src/core/runner.ts"),
      "utf8",
    );

    // 定位 allowedTestToolNames 函数体
    const fnStart = runnerSrc.indexOf("function allowedTestToolNames");
    expect(fnStart).toBeGreaterThan(-1);
    // 函数体到下一个 export/function 边界
    const fnEnd = runnerSrc.indexOf("\n}", fnStart) + 2;
    const fnBody = runnerSrc.slice(fnStart, fnEnd);

    // 断言含 regression case（修复 fc9d292 的核心）
    expect(fnBody).toContain('case "regression"');
    // 断言映射所有 4 个测试工具（regression 语义是全回归）
    expect(fnBody).toContain('"maven_test"');
    expect(fnBody).toContain('"node_test"');
    expect(fnBody).toContain('"playwright_test"');
    expect(fnBody).toContain('"api_test"');
  });
});
