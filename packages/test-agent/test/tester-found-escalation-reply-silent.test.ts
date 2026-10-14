/**
 * tester-found bug 复现测试：EscalationHandler.reply 对不存在/已超时 escalationId 静默失败
 * 无返回值，调用方（host-mode/GUI）误以为答复成功
 *
 * 发现者：tester（持续 bug 修复循环第 4 轮）
 * 模块：packages/test-agent/src/core/escalation-handler.ts reply（line 217-222）
 * 关联：packages/test-agent/src/modes/host-mode.ts replyEscalation（line 53-61）
 *      packages/gui/src/renderer/src/App.vue replyEscalation（line 1226-1234）
 *
 * bug 描述：
 *   EscalationHandler.reply(escalationId, answer) 返回 void：
 *     `if (!pending) return; // 已超时或不存在`——静默 return，无信号告知调用方未送达。
 *
 *   host-mode replyEscalation（line 53）返回 boolean，但仅表示 handler 存在（escalationHandlers.get
 *   命中），不表示 escalationId 在 pending。它调 handler.reply 后无检查，仍 return true。
 *
 *   GUI App.vue replyEscalation（line 1228）await window.testAgent.replyEscalation(...) 收到 true
 *   → 移除弹窗 + push "已答复 success" 日志。但若 escalationId 已超时/不存在，handler.reply 静默
 *   return，答复丢失，用户以为答复成功，角色实际已超时降级——审计/用户认知与实际不符。
 *
 *   触发场景：escalation ask 超时（5 分钟默认）→ setTimeout 触发 reject + pendingAsks.delete。
 *   用户在超时后点"答复"（弹窗仍在，因 notifyFn 发了 escalation 事件但超时未同步移除弹窗）→
 *   reply 静默失败。或 GUI 与 host 进程时序错位（escalationId 已被清理）。
 *
 * 严重性建议：P2——用户体验/审计准确性，非功能性中断。用户误以为答复成功但角色已降级。
 *
 * 预期修复方向（reviewer/worker 定）：
 *   A. EscalationHandler.reply 返回 boolean（pending 存在且成功 resolve → true，否则 false）
 *   B. host-mode replyEscalation 用 handler.getPendingRole(escalationId) 检查 pending 存在再 reply，
 *      不存在返回 false（GUI 据此显示"escalation 已超时，答复未送达"）
 *   C. GUI 端超时同步移除弹窗（ask 超时后 notifyFn/事件通知 GUI 移除，避免用户点已超时的弹窗）
 */

import { describe, it, expect } from "vitest";
import { EscalationHandler } from "../src/core/escalation-handler.js";

describe("[tester-found] EscalationHandler.reply 静默失败无信号", () => {
  it("reply 对不存在的 escalationId 返回 false（修复后回归守卫）", async () => {
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    const shortAsk = handler.ask({ role: "tester", question: "短超时", fallback: "保守" });
    // catch 超时 reject（避免 unhandled rejection）
    await shortAsk.catch(() => { /* 预期超时 */ });
    // 等 pendingAsks 被超时清理（setTimeout reject 内 delete）
    expect(handler.pendingCount).toBe(0);

    // reply 对已超时/不存在的 escalationId——静默 return void
    const replyResult = handler.reply("nonexistent-id", "答复内容");
    // 期望：reply 应返回 false 告知调用方未送达
    // 实际（bug）：返回 void（undefined），调用方无法知道未送达
    expect(replyResult).toBe(false); // ← FAIL，复现 bug（实际 undefined）
  });

  it("reply 对 pending 不存在的 id 返回 false，pending 存在的 id 返回 true（修复后回归守卫）", async () => {
    // 用短超时 handler 避免 await askPromise 卡 5 分钟
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    const askPromise = handler.ask({ role: "tester", question: "正常 ask", fallback: "保守" });
    expect(handler.pendingCount).toBe(1);
    // reply 错误 id 返回 false（未送达）
    const wrongResult = handler.reply("wrong-id", "答复");
    expect(wrongResult).toBe(false); // 修复后：pending 不存在返回 false

    // 清理 pending ask（短超时 50ms，等 reject）
    await askPromise.catch(() => { /* 超时降级 */ });
  });
});
