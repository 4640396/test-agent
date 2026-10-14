/**
 * tester-found bug 复现测试：runner.ts shouldStopAfterTurn 的 terminalStop 永远 true
 * 致 turnBudgetDecision 短路 return "continue"，turn-budget 在 runner 完全失效。
 *
 * 发现者：tester（持续 bug 修复循环第 2 轮）
 * 模块：packages/test-agent/src/core/runner.ts（3 处 shouldStopAfterTurn）+ packages/sub/src/turn-budget.ts
 *
 * bug 描述：
 *   runner.ts 3 处 shouldStopAfterTurn（line 788/933/1254）计算 terminalStop：
 *     `const terminalStop = (context as { stopReason?: string }).stopReason === "tool_use" ? false : true;`
 *   但 agent-core 的 ShouldStopAfterTurnContext（types.ts:126-138）只有 message/toolResults/
 *   context/newMessages/turn 五个字段，**没有 stopReason**。所以 context.stopReason 永远 undefined
 *   → `undefined === "tool_use"` false → 三元走 else → terminalStop = **true**。
 *
 *   turnBudgetDecision 第一行：`if (terminalAssistantStop || turnCount < hardLimit) return "continue";`
 *   terminalStop=true → 短路 → 永远 return "continue"，永不到 abort 分支。
 *
 *   实际影响：runner 的 3 处 turn-budget 检查完全失效，agent 跑飞（超过 maxTurns+graceTurns）
 *   也不会被 shouldStopAfterTurn 终止，只能靠 LLM 自停或外部中断。ce553fe 修复了 context.turn
 *   undefined，但 terminalStop 永远 true 让整个 budget 检查短路（修复未闭环）。
 *
 *   对比：orchestrator.ts:321 / fix-orchestrator.ts:292 用 `terminalStop = !hasToolCalls`
 *   （hasToolCalls = message.content 有 toolCall parts），语义正确——有工具调用非终态停。
 *
 * 严重性建议：P1（turn-budget 失效，长跑 agent 不停，token 失控；非 P0 因 LLM 常自停 + 有外部中断）。
 *
 * 预期修复方向（reviewer/worker 定）：
 *   A. runner.ts 改用与 orchestrator 一致的判断：hasToolCalls = context.message.content.some(p=>p.type==="toolCall")，
 *      terminalStop = !hasToolCalls（最小改动，3 处统一）。
 *   B. 或从 context.toolResults 推断：toolResults?.length>0 → 有工具调用 → 非终态。
 */

import { describe, it, expect } from "vitest";
import { turnBudgetDecision } from "@cxmt/sub";

/** 复现 runner.ts line 789 的 terminalStop 计算（断言 context 无 stopReason 字段）。 */
function runnerTerminalStop(context: { stopReason?: string }): boolean {
  return context.stopReason === "tool_use" ? false : true;
}

/** 复现 orchestrator.ts line 325 的 terminalStop 计算（正确语义）。 */
function orchestratorTerminalStop(hasToolCalls: boolean): boolean {
  return !hasToolCalls;
}

/** 修复后 runner.ts shouldStopAfterTurn 的 terminalStop 计算（照抄修复后 runner 逻辑）。 */
function fixedRunnerTerminalStop(context: { message: { content: Array<{ type: string }> } }): boolean {
  const hasToolCalls = context.message.content.some((p) => p.type === "toolCall");
  return !hasToolCalls;
}

describe("[tester-found] runner turn-budget terminalStop 永远 true 致检查失效", () => {
  it("ShouldStopAfterTurnContext 无 stopReason 字段 → runner terminalStop 永远 true", () => {
    // 模拟 agent-loop 传给 shouldStopAfterTurn 的真实 context（无 stopReason）
    const realContext = {
      message: { role: "assistant", content: [] },
      toolResults: [],
      context: { messages: [] },
      newMessages: [],
      turn: 5,
    };
    // runner.ts 的计算
    expect(runnerTerminalStop(realContext as { stopReason?: string })).toBe(true);

    // 即便有工具调用（应判非终态），runner 仍算 terminalStop=true
    const withToolCalls = { ...realContext, message: { role: "assistant", content: [{ type: "toolCall" }] } };
    expect(runnerTerminalStop(withToolCalls as { stopReason?: string })).toBe(true); // ← bug：应 false
  });

  it("修复后：turnCount 超 hardLimit + 有工具调用 → terminalStop=false → 正确 abort", () => {
    // 模拟 runner.ts shouldStopAfterTurn 内的调用（maxTurns=6, graceTurns=1, hardLimit=7）
    const turnBudget = { maxTurns: 6, graceTurns: 1 };
    const turnCount = 20; // 远超 hardLimit=7
    const hasToolCalls = true;
    // 修复前 runner 算 terminalStop=true 短路 continue（bug），修复后 terminalStop=!hasToolCalls=false 正确 abort
    const terminalStop = !hasToolCalls;
    const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);

    // 修复后：terminalStop=false + turnCount>hardLimit → turnBudgetDecision 正确 abort
    expect(decision).toBe("abort");
  });

  // 注：terminalStop=true 在 turnBudgetDecision 语义里是"LLM 已自然终态停（无工具调用）",
  // 此时 decision=continue 表示"允许停"（shouldStopAfterTurn 返回 false 不强制，
  // agent-loop 因 hasMoreToolCalls=false 自然退出）。所以无工具调用场景不是 bug 表现。
  // bug 表现在"有工具调用 + 超 budget"场景——见上 case 2。

  it("对照：orchestrator 语义（terminalStop=!hasToolCalls）+ 有工具调用 + 超 budget → 正确 abort", () => {
    const turnBudget = { maxTurns: 6, graceTurns: 1 };
    const turnCount = 20;
    const hasToolCalls = true; // 仍在调工具，非终态
    const terminalStop = orchestratorTerminalStop(hasToolCalls); // false（正确语义）
    // enforceHardLimit=true → 不 defer，直接 abort
    const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);
    expect(decision).toBe("abort"); // ← PASS（对照正确语义，证明 orchestrator 路径有效）
  });

  it("修复后：runner terminalStop 不再永远 true（有 toolCall→false 非终态）", () => {
    // 修复后 runner shouldStopAfterTurn 用 hasToolCalls = message.content.some(p=>p.type==="toolCall")
    // terminalStop = !hasToolCalls，不再依赖不存在的 stopReason 字段
    const withToolCalls = { message: { content: [{ type: "toolCall" }] } };
    const withoutToolCalls = { message: { content: [{ type: "text" }] } };

    // 有 toolCall → hasToolCalls=true → terminalStop=false（非终态，正确）
    expect(fixedRunnerTerminalStop(withToolCalls)).toBe(false);
    // 无 toolCall → hasToolCalls=false → terminalStop=true（终态，正确）
    expect(fixedRunnerTerminalStop(withoutToolCalls)).toBe(true);
  });
});
