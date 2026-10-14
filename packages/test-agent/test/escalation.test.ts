/**
 * escalation 通道单测（片A，纯函数+Promise，不接线 runner）。
 *
 * 照抄 pi-intercom ask/reply 超时降级语义验证：
 * - ask 阻塞→reply resolve
 * - ask 超时→降级 [需人工复核]
 * - 限流超 budget
 * - pruneExpired 清理
 * - deliverFn 调 agent.steer
 * - notifyFn 转发 EscalationEvent
 * - escalate 工具 execute
 * - getEscalationTimeoutMs env 配置
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EscalationHandler,
  getEscalationTimeoutMs,
  type EscalationEvent,
} from "../src/core/escalation-handler.js";
import { createEscalateTool, escalateSchema } from "../src/core/tools/escalate.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 创建带可控 timeoutMs 的 handler（测试用小值避免长等）。 */
function makeHandler(opts?: {
  timeoutMs?: number;
  budget?: number;
  notifyFn?: (e: EscalationEvent) => void;
  deliverFn?: (msg: string, agent: any) => void;
}): EscalationHandler {
  return new EscalationHandler(
    opts?.deliverFn ?? ((m, a) => a.steer({ role: "user", content: m, timestamp: Date.now() })),
    opts?.notifyFn,
    opts?.timeoutMs ?? 50,
    opts?.budget ?? 5,
  );
}

/** mock Agent 对象（{steer: vi.fn()}）。 */
function makeMockAgent(): { steer: ReturnType<typeof vi.fn> } {
  return { steer: vi.fn() };
}

// ---------------------------------------------------------------------------
// getEscalationTimeoutMs
// ---------------------------------------------------------------------------

describe("getEscalationTimeoutMs", () => {
  const original = process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
    else process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = original;
  });

  it("env 未设 → 默认 5*60*1000", () => {
    delete process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
    expect(getEscalationTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("env 设空字符串 → 默认值", () => {
    process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "  ";
    expect(getEscalationTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("env 设有效正整数 → 用 env 值", () => {
    process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "3000";
    expect(getEscalationTimeoutMs()).toBe(3000);
  });

  it("env 设非法值（负数）→ 抛错", () => {
    process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "-1";
    expect(() => getEscalationTimeoutMs()).toThrow("positive integer");
  });

  it("env 设非法值（小数）→ 抛错", () => {
    process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "1.5";
    expect(() => getEscalationTimeoutMs()).toThrow("positive integer");
  });

  it("env 设非法值（非数字）→ 抛错", () => {
    process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "abc";
    expect(() => getEscalationTimeoutMs()).toThrow("positive integer");
  });
});

describe("interactive escalation lifetime", () => {
  it("keeps a null-timeout ask pending until the user explicitly replies", async () => {
    vi.useFakeTimers();
    try {
      const events: EscalationEvent[] = [];
      const handler = new EscalationHandler(undefined, (event) => events.push(event), null, 5);
      const answer = handler.ask({ role: "tester", question: "install?", fallback: "skip" });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(handler.pendingCount).toBe(1);
      expect(handler.reply(events[0].escalationId, "yes")).toBe(true);
      await expect(answer).resolves.toBe("yes");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// EscalationHandler.ask / reply
// ---------------------------------------------------------------------------

describe("EscalationHandler ask/reply", () => {
  it("ask 阻塞→reply resolve → 得到答复，resolved=true", async () => {
    const events: EscalationEvent[] = [];
    const handler = makeHandler({ notifyFn: (e) => events.push(e) });

    const askPromise = handler.ask({ role: "tester", question: "用例失败但可能 flaky，继续还是重跑？" });

    // 等一个 tick 让 notifyFn 被调
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("tester");
    expect(events[0].question).toContain("flaky");
    expect(events[0].escalationId).toBeTruthy();

    const escalationId = events[0].escalationId;
    handler.reply(escalationId, "重跑一次确认是否 flaky");

    const answer = await askPromise;
    expect(answer).toBe("重跑一次确认是否 flaky");
    expect(handler.pendingCount).toBe(0);
  });

  it("ask 超时→reject（handler 层面）", async () => {
    const handler = makeHandler({ timeoutMs: 50 });
    const askPromise = handler.ask({ role: "tester", question: "超时测试" });

    await expect(askPromise).rejects.toThrow("超时");
    expect(handler.pendingCount).toBe(0);
  });

  it("主动跳过立即拒绝等待并清理 pending，不等待超时", async () => {
    const events: EscalationEvent[] = [];
    const handler = makeHandler({ notifyFn: (e) => events.push(e), timeoutMs: 60_000 });
    const pending = handler.ask({ role: "tester", question: "需要确认", fallback: "保守处理" });
    expect(handler.dismiss(events[0].escalationId)).toBe(true);
    await expect(pending).rejects.toThrow("用户跳过");
    expect(handler.pendingCount).toBe(0);
    expect(handler.dismiss(events[0].escalationId)).toBe(false);
  });

  it("reply 不存在的 id → 安全无操作", () => {
    const handler = makeHandler();
    expect(() => handler.reply("nonexistent-id", "答复")).not.toThrow();
  });

  it("同一 role 多次 ask 计数递增", async () => {
    const events: EscalationEvent[] = [];
    const handler = makeHandler({ notifyFn: (e) => events.push(e), timeoutMs: 200 });

    const p1 = handler.ask({ role: "tester", question: "q1" });
    const p2 = handler.ask({ role: "tester", question: "q2" });

    await Promise.resolve();
    expect(handler.escalationCount("tester")).toBe(2);

    handler.reply(events[0].escalationId, "a1");
    handler.reply(events[1].escalationId, "a2");

    await Promise.all([p1, p2]);
    expect(handler.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

describe("EscalationHandler 限流", () => {
  it("超 budget → 返回预算耗尽文本（不抛），含 [需人工复核]", async () => {
    // 前两次正常（会 pending，需要 reply 才 resolve）
    const events: EscalationEvent[] = [];
    const h2 = new EscalationHandler(undefined, (e) => events.push(e), 1000, 2);

    const p1 = h2.ask({ role: "tester", question: "q1" });
    const p2 = h2.ask({ role: "tester", question: "q2" });
    await Promise.resolve();

    // 第三次超 budget → 立即 resolve 预算耗尽文本
    const p3 = h2.ask({ role: "tester", question: "q3", fallback: "保守重跑" });
    const answer3 = await p3;

    expect(answer3).toContain("预算耗尽");
    expect(answer3).toContain("2/2");
    expect(answer3).toContain("[需人工复核]");
    expect(answer3).toContain("保守重跑");

    // 清理前两个
    h2.reply(events[0].escalationId, "a1");
    h2.reply(events[1].escalationId, "a2");
    await Promise.all([p1, p2]);
  });

  it("不同角色独立计数", async () => {
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 1000, 1);

    // tester 用满 budget
    const p1 = h.ask({ role: "tester", question: "q1" });
    await Promise.resolve();

    // reviewer 仍有 budget
    const p2 = h.ask({ role: "result-reviewer", question: "q2" });
    await Promise.resolve();

    expect(h.escalationCount("tester")).toBe(1);
    expect(h.escalationCount("result-reviewer")).toBe(1);

    h.reply(events[0].escalationId, "a1");
    h.reply(events[1].escalationId, "a2");
    await Promise.all([p1, p2]);
  });
});

// ---------------------------------------------------------------------------
// pruneExpired
// ---------------------------------------------------------------------------

describe("EscalationHandler pruneExpired", () => {
  it("超时项被清理 + reject 触发", async () => {
    const handler = makeHandler({ timeoutMs: 50 });

    const askPromise = handler.ask({ role: "tester", question: "pruneExpired 测试" });
    // 立即 attach catch 防止 unhandled rejection
    const caught = askPromise.catch((e: Error) => e);
    expect(handler.pendingCount).toBe(1);

    // 等待超过 timeoutMs
    await new Promise((r) => setTimeout(r, 100));

    // pruneExpired 清理（即使 setTimeout 已触发，Map 可能已空）
    handler.pruneExpired();
    expect(handler.pendingCount).toBe(0);

    // 验证 reject 已触发
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("超时");
  });

  it("未超时项不被清理", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);

    handler.ask({ role: "tester", question: "未超时" });
    await Promise.resolve();
    expect(handler.pendingCount).toBe(1);

    handler.pruneExpired();
    expect(handler.pendingCount).toBe(1);

    // 清理
    handler.reply(events[0].escalationId, "答复");
  });
});

// ---------------------------------------------------------------------------
// deliverFn
// ---------------------------------------------------------------------------

describe("EscalationHandler deliverFn", () => {
  it("reply 时传 roleAgent → deliverFn 调 agent.steer", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );

    const askPromise = handler.ask({ role: "tester", question: "deliverFn 测试" });
    await Promise.resolve();

    handler.reply(events[0].escalationId, "答复内容", mockAgent as any);

    const answer = await askPromise;
    expect(answer).toBe("答复内容");
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "答复内容" }),
    );
  });

  it("reply 不传 roleAgent → deliverFn 不调", async () => {
    const deliverFn = vi.fn();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(deliverFn, (e) => events.push(e), 5000, 5);

    const askPromise = handler.ask({ role: "tester", question: "无 agent" });
    await Promise.resolve();

    handler.reply(events[0].escalationId, "答复");
    const answer = await askPromise;

    expect(answer).toBe("答复");
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("ask resolve 不依赖 deliverFn（§7 不确定点 5 核心假设）", async () => {
    // deliverFn 设为 no-op，ask 仍应通过 reply 正常 resolve
    const noopDeliverFn = vi.fn();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(noopDeliverFn, (e) => events.push(e), 5000, 5);

    const askPromise = handler.ask({ role: "tester", question: "不依赖 steer" });
    await Promise.resolve();

    handler.reply(events[0].escalationId, "靠 Promise 传递");
    const answer = await askPromise;

    expect(answer).toBe("靠 Promise 传递");
    expect(noopDeliverFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// notifyFn
// ---------------------------------------------------------------------------

describe("EscalationHandler notifyFn", () => {
  it("ask 时 notifyFn 被调，传含 escalationId/role/question/fallback 的 EscalationEvent", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);

    const p = handler.ask({
      role: "fixer",
      question: "修复方案 A 还是 B？",
      fallback: "选 B（更保守）",
      context: "两套方案各有风险",
    });
    await Promise.resolve();

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.escalationId).toBeTruthy();
    expect(evt.role).toBe("fixer");
    expect(evt.question).toBe("修复方案 A 还是 B？");
    expect(evt.fallback).toBe("选 B（更保守）");
    expect(evt.context).toBe("两套方案各有风险");

    handler.reply(evt.escalationId, "选 A");
    await p;
  });

  it("notifyFn 未设 → ask 正常工作（不崩）", async () => {
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    const p = handler.ask({ role: "tester", question: "无 notifyFn" });
    await Promise.resolve();

    // 没有途径拿 escalationId，直接超时验证不崩
    await expect(p).rejects.toThrow("超时");
  });
});

// ---------------------------------------------------------------------------
// escalate 工具
// ---------------------------------------------------------------------------

describe("createEscalateTool", () => {
  it("工具基本属性", () => {
    const handler = makeHandler();
    const tool = createEscalateTool(handler, "tester");

    expect(tool.name).toBe("escalate");
    expect(tool.label).toBe("escalate");
    expect(tool.description).toContain("未预料决策");
    expect(tool.parameters).toBe(escalateSchema);
  });

  it("execute 成功 → content 含答复，details resolved=true degraded=false", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const tool = createEscalateTool(handler, "tester");

    const execPromise = tool.execute!("call-1", {
      question: "用例失败需决策",
      fallback: "保守重跑",
    });

    await Promise.resolve();
    handler.reply(events[0].escalationId, "继续执行");

    const result = await execPromise;
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("继续执行");
    expect(result.details.resolved).toBe(true);
    expect(result.details.degraded).toBe(false);
    expect(result.details.escalationId).toBe("");
  });

  it("execute 超时 → 降级文本含 [需人工复核] + fallback，details degraded=true resolved=false", async () => {
    const handler = makeHandler({ timeoutMs: 50 });
    const tool = createEscalateTool(handler, "tester");

    const result = await tool.execute!("call-2", {
      question: "超时降级测试",
      fallback: "按最保守方案继续",
    });

    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.content[0].text).toContain("按最保守方案继续");
    expect(result.content[0].text).toContain("降级");
    expect(result.details.resolved).toBe(false);
    expect(result.details.degraded).toBe(true);
  });

  it("execute 超时无 fallback → 降级文本用默认保守方案", async () => {
    const handler = makeHandler({ timeoutMs: 50 });
    const tool = createEscalateTool(handler, "tester");

    const result = await tool.execute!("call-3", {
      question: "无 fallback 超时",
    });

    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.content[0].text).toContain("按最保守不扩大范围方案继续");
  });

  it("execute 限流超 budget → 返回预算耗尽文本（不抛）", async () => {
    // 第一次 ask 正常 pending
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 5000, 1);
    const t = createEscalateTool(h, "tester");

    const p1 = t.execute!("call-1", { question: "q1" });
    await Promise.resolve();

    // 第二次超 budget → 立即返回预算耗尽
    const result2 = await t.execute!("call-2", { question: "q2", fallback: "自行决策" });

    expect(result2.content[0].text).toContain("预算耗尽");
    expect(result2.content[0].text).toContain("[需人工复核]");
    expect(result2.details.resolved).toBe(true); // ask resolve（预算耗尽也走 resolve 路径）
    expect(result2.details.degraded).toBe(false);

    // 清理第一个
    h.reply(events[0].escalationId, "a1");
    await p1;
  });

  it("context 参数传递到 handler.ask", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const tool = createEscalateTool(handler, "result-reviewer");

    const execPromise = tool.execute!("call-ctx", {
      question: "需审批",
      context: "PR #123 的测试结果",
    });

    await Promise.resolve();
    expect(events[0].context).toBe("PR #123 的测试结果");
    handler.reply(events[0].escalationId, "批准");
    await execPromise;
  });
});

// ---------------------------------------------------------------------------
// getRecords() — escalation 记录历史收集（供 AgentRunResult.report.escalations）
// ---------------------------------------------------------------------------

describe("EscalationHandler.getRecords", () => {
  it("无 ask 时返回空数组", () => {
    const h = makeHandler({ timeoutMs: 5000 });
    expect(h.getRecords()).toHaveLength(0);
  });

  it("ask 发起后记录一条（resolved=false degraded=false）", async () => {
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p = h.ask({ role: "tester", question: "q1", fallback: "fb" });
    await Promise.resolve();
    const records = h.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("tester");
    expect(records[0].question).toBe("q1");
    expect(records[0].fallback).toBe("fb");
    expect(records[0].resolved).toBe(false);
    expect(records[0].degraded).toBe(false);
    h.reply(events[0].escalationId, "a1");
    await p;
  });

  it("reply 后记录更新为 resolved=true 含 answer + durationMs", async () => {
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p = h.ask({ role: "tester", question: "q1" });
    await Promise.resolve();
    h.reply(events[0].escalationId, "answer-1");
    await p;
    const records = h.getRecords();
    // ask 记一条 + resolve 再记一条（照抄 writeAudit 在 ask 和 resolve 各记一次）
    const resolved = records.find((r) => r.resolved);
    expect(resolved).toBeDefined();
    expect(resolved!.answer).toBe("answer-1");
    expect(resolved!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("超时降级后记录 degraded=true 含 durationMs", async () => {
    const h = new EscalationHandler(undefined, undefined, 50, 5); // 50ms 超时
    await expect(h.ask({ role: "tester", question: "q1", fallback: "保守方案" })).rejects.toThrow(
      /escalation 超时/,
    );
    const records = h.getRecords();
    const degraded = records.find((r) => r.degraded);
    expect(degraded).toBeDefined();
    expect(degraded!.degraded).toBe(true);
    expect(degraded!.resolved).toBe(false);
    expect(degraded!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("projectPath 未设时仍存内存 records（不落盘但可收集）", async () => {
    const h = new EscalationHandler(undefined, undefined, 50, 5); // 无 projectPath options
    await expect(h.ask({ role: "tester", question: "q1" })).rejects.toThrow(/超时/);
    expect(h.getRecords().length).toBeGreaterThan(0);
  });

  it("多次 ask 累积记录", async () => {
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p1 = h.ask({ role: "tester", question: "q1" });
    const p2 = h.ask({ role: "fixer", question: "q2" });
    await Promise.resolve();
    h.reply(events[0].escalationId, "a1");
    h.reply(events[1].escalationId, "a2");
    await Promise.all([p1, p2]);
    const records = h.getRecords();
    // 2 次 ask 发起 + 2 次 resolve = 4 条
    expect(records.length).toBeGreaterThanOrEqual(4);
    const roles = new Set(records.map((r) => r.role));
    expect(roles.has("tester")).toBe(true);
    expect(roles.has("fixer")).toBe(true);
  });
});
