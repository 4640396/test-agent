/**
 * tester-found bug #24 回归守卫：coordinator fan-out regression + 其他 testTypes 时用例不重复
 *
 * 发现者：tester（GUI 真实效果验证第 1 轮）
 * 模块：packages/test-agent/src/core/coordinator.ts run()（line 248-262）
 *
 * bug 回顾：
 *   runTesterSubAgent cases 过滤：regression 跑全部，其他按 layer。
 *   unit+regression 组合时 unit 子代理跑 layer=unit 的，regression 子代理跑全部（含 unit）→ unit 用例重复。
 *   修复（ff5562a）：含 regression 时只跑 regression 子代理，不 fan-out 其他 testTypes。
 *
 * 回归守卫：testTypes=["unit","regression"] 时 runTesterSubAgent 只调 1 次（regression），不调 unit。
 */

import { describe, it, expect, vi } from "vitest";
import { Coordinator } from "../src/core/coordinator.js";
import type { AgentRunResult, AgentAdapter, AgentRunContext } from "../src/core/types.js";

describe("[tester-found] bug #24 回归守卫：regression + 其他 testTypes 不重复执行", () => {
  it("testTypes=['unit','regression'] → runTesterSubAgent 只调 1 次（regression），unit 用例不重复", async () => {
    let subAgentCalls: string[] = [];

    const fakeAdapter: AgentAdapter = {
      name: "test",
      run: async () => ({ phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] }),
      runScout: async () => ({ report: "scout report", artifacts: [] }),
      runCaseDesign: async () => ({
        phase: "plan",
        cases: [
          { id: "TC1", title: "用例1", scenario: "s", steps: [], expected: "e", priority: "medium" as const, layer: "unit" as const },
          { id: "TC2", title: "用例2", scenario: "s", steps: [], expected: "e", priority: "medium" as const, layer: "ui" as const },
        ],
        artifacts: [],
      }),
      runExecute: async (_input, cases) => ({
        phase: "execute",
        lanes: [],
        report: { passed: cases.length, failed: 0, coverage: null },
        artifacts: [],
        cases,
      }),
    };

    const coord = new Coordinator(fakeAdapter, undefined, undefined);
    // spy private runTesterSubAgent
    (coord as unknown as { runTesterSubAgent: (...args: unknown[]) => Promise<AgentRunResult> }).runTesterSubAgent = async function (
      this: Coordinator, _input: unknown, _cases: unknown, testType: string, _emit: unknown, _signal: unknown, _context: unknown,
    ) {
      subAgentCalls.push(testType);
      // 调真实 runExecute（fakeAdapter）
      const result = await (this as unknown as { adapter: AgentAdapter }).adapter.runExecute?.(_input as never, _cases as never, _emit as never, _signal as never, _context as never);
      return result ?? { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] };
    } as never;

    const input = {
      projectPath: ".",
      systemName: "test",
      version: "1.0",
      testTypes: ["unit", "regression" as const],
    } as never;

    await coord.run(input, () => {}, undefined, { coordinatorEnabled: true } as AgentRunContext);

    // 期望：含 regression 时只调 1 次 runTesterSubAgent（testType="regression"），不调 unit
    // 修复前（bug）：调 2 次（unit + regression），unit 用例重复
    expect(subAgentCalls).toEqual(["regression"]); // 修复后：只 regression
    expect(subAgentCalls).not.toContain("unit"); // unit 不单独跑（regression 已覆盖全部）
  });
});
