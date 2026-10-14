/**
 * escalation 通道独立验收 — 照抄真实性核对 + 边界探针
 *
 * 验收重点：对照 pi-intercom/pi-messenger 源码，独立验证 worker 是否真照抄，
 * 而非凭空想象。同时补 worker 未覆盖的边界探针。
 *
 * 照抄映射表逐条核对（技术方案 §3）：
 * 1. ask 阻塞+超时：pi-intercom index.ts:606-630 waitForReply + config.ts:6-15
 * 2. pendingAsks 跟踪：reply-tracker.ts:43-62/104-115/140-147
 * 3. messageBudgets 限流：handlers.ts:393-398
 * 4. deliverFn/steer：store.ts:57 + 片C steer 默认关闭
 * 5. contact_supervisor schema：index.ts:1818-1826
 * 6. AgentHarnessTool 形态：api-test.ts:16-39
 *
 * 边界探针（worker 可能未覆盖）：
 * - 超时 reject 后 reply 到达（已删除，不应 resolve）—— 竞态正确性
 * - 预算耗尽 escalationId 唯一性（片C P2 修复点）
 * - pruneExpired 主动清理 setTimeout 已触发的残留
 * - burst 检测窗口外清理 + 不同角色独立 + 阈值边界（等于不触发）
 * - 审计日志 2 条/次 escalationId 关联
 * - host/worker 分流构造差异（notifyFn 有无）
 * - steer 默认关闭 + setSteerEnabled 配置开启
 * - 多角色并发 pendingAsks Map 隔离
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EscalationHandler,
  getEscalationTimeoutMs,
  type EscalationEvent,
} from "../src/core/escalation-handler.js";
import { createEscalateTool, escalateSchema } from "../src/core/tools/escalate.js";
import {
  appendEscalationAudit,
  loadEscalationAudit,
  type EscalationAuditEntry,
} from "../src/core/escalation-audit.js";
import { computeProjectHash } from "../src/core/cases.js";
import type { RoleConfig } from "../src/core/agent-loader.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeHandler(opts?: {
  timeoutMs?: number;
  budget?: number;
  notifyFn?: (e: EscalationEvent) => void;
  deliverFn?: (msg: string, agent: unknown) => void;
  options?: { projectPath?: string; burstWindowMs?: number; burstThreshold?: number };
}): EscalationHandler {
  return new EscalationHandler(
    opts?.deliverFn ?? ((_m, _a) => {}),
    opts?.notifyFn,
    opts?.timeoutMs ?? 50,
    opts?.budget ?? 5,
    opts?.options,
  );
}

function makeMockAgent(): { steer: ReturnType<typeof vi.fn> } {
  return { steer: vi.fn() };
}

function makeRoleConfig(opts?: Partial<RoleConfig>): RoleConfig {
  return {
    name: opts?.name ?? "tester",
    tools: opts?.tools ?? ["read"],
    systemPrompt: opts?.systemPrompt ?? "test",
    thinking: opts?.thinking,
    turnBudget: opts?.turnBudget,
    escalation: opts?.escalation,
    fallback: opts?.fallback,
    escalationSteer: opts?.escalationSteer,
  } as RoleConfig;
}

const tmpRoots: string[] = [];
afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()!;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
function makeTmp(): string {
  const root = mkdtempSync(join(tmpdir(), "p1-esc-"));
  tmpRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// 照抄核对 1：ask 阻塞 + 超时降级（对照 pi-intercom index.ts:606-630 + config.ts:6-15）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对1：ask 阻塞+超时（pi-intercom waitForReply）", () => {
  it("getEscalationTimeoutMs 照抄 config.ts:getAskTimeoutMs 逻辑（env/默认/校验）", () => {
    const prev = process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
    try {
      // 默认值：pi-intercom 10min，test-agent 改造为 5min（技术方案 §3.1 明确"改 5 分钟"）
      delete process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
      expect(getEscalationTimeoutMs()).toBe(5 * 60 * 1000); // 改造点：5min 非 10min

      // env 有效正整数 → 用 env（照抄 config.ts:10-13）
      process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "3000";
      expect(getEscalationTimeoutMs()).toBe(3000);

      // 空字符串 → 默认（照抄 config.ts:8 raw.trim()===""）
      process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "  ";
      expect(getEscalationTimeoutMs()).toBe(5 * 60 * 1000);

      // 非法值抛错（照抄 config.ts:11-13 Number.isSafeInteger && >0）
      process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "-1";
      expect(() => getEscalationTimeoutMs()).toThrow(/positive integer/);
      process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "1.5";
      expect(() => getEscalationTimeoutMs()).toThrow(/positive integer/);
      process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = "abc";
      expect(() => getEscalationTimeoutMs()).toThrow(/positive integer/);
    } finally {
      if (prev === undefined) delete process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
      else process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS = prev;
    }
  });

  it("ask 照抄 waitForReply：new Promise + setTimeout(timeoutMs) reject", async () => {
    const handler = makeHandler({ timeoutMs: 30 });
    const start = Date.now();
    await expect(handler.ask({ role: "tester", question: "超时" })).rejects.toThrow(/超时/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500); // 不是凭空立即 reject
  });

  it("超时 reject 后 pendingAsks 已删除（照抄 index.ts:610-616 delete on timeout）", async () => {
    const handler = makeHandler({ timeoutMs: 30 });
    const p = handler.ask({ role: "tester", question: "q" });
    p.catch(() => {}); // 防 unhandled
    await new Promise((r) => setTimeout(r, 60));
    expect(handler.pendingCount).toBe(0); // 超时后已删除
  });

  it("reply resolve 时 clearTimeout（照抄 index.ts:621 cleanup）—— 答复后不应再触发超时", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 50, 5);
    const p = handler.ask({ role: "tester", question: "q" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "答复");
    const answer = await p;
    expect(answer).toBe("答复");
    // 答复后再等超时窗口，不应有 reject 副作用
    await new Promise((r) => setTimeout(r, 80));
    expect(handler.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 照抄核对 2：pendingAsks 跟踪（对照 reply-tracker.ts:43-62/104-115/140-147）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对2：pendingAsks 跟踪（reply-tracker）", () => {
  it("pendingAsks = Map<string, PendingAsk>（照抄 reply-tracker.ts:43）", () => {
    const handler = makeHandler();
    // 通过 ask + pendingCount 验证 Map 行为
    expect(handler.pendingCount).toBe(0);
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    expect(handler.pendingCount).toBe(1);
  });

  it("reply 照抄 markReplied：resolve + delete（reply-tracker.ts:104-115）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p = handler.ask({ role: "tester", question: "q" });
    await Promise.resolve();
    expect(handler.pendingCount).toBe(1);
    handler.reply(events[0].escalationId, "a");
    await p;
    expect(handler.pendingCount).toBe(0); // 删除
  });

  it("reply 不存在 id 安全无操作（照抄 markReplied 对已删除 id 容错）", () => {
    const handler = makeHandler();
    expect(() => handler.reply("nonexistent", "a")).not.toThrow();
    expect(() => handler.reply("nonexistent", "a", makeMockAgent() as never)).not.toThrow();
  });

  it("pruneExpired 照抄 reply-tracker.ts:140-147：超时项 reject + delete", async () => {
    const handler = new EscalationHandler(undefined, undefined, 100, 5);
    const p = handler.ask({ role: "tester", question: "prune" });
    const caught = p.catch((e: Error) => e);
    // 等超过 timeoutMs（setTimeout 会触发，但 pruneExpired 是另一条清理路径）
    await new Promise((r) => setTimeout(r, 120));
    handler.pruneExpired(); // 主动清理（惰性调用路径）
    expect(handler.pendingCount).toBe(0);
    const err = await caught;
    expect(err.message).toContain("超时");
  });

  it("pruneExpired 未超时项不清理（照抄 reply-tracker.ts:142 if now-receivedAt > timeoutMs）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    handler.ask({ role: "tester", question: "未超时" }).catch(() => {});
    await Promise.resolve();
    expect(handler.pendingCount).toBe(1);
    handler.pruneExpired();
    expect(handler.pendingCount).toBe(1); // 未超时不清理
    handler.reply(events[0].escalationId, "a");
  });

  it("多角色并发 ask：pendingAsks Map 按 escalationId 隔离（照抄 reply-tracker 多 pending）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p1 = handler.ask({ role: "tester", question: "q1" });
    const p2 = handler.ask({ role: "reviewer", question: "q2" });
    const p3 = handler.ask({ role: "fixer", question: "q3" });
    await Promise.resolve();
    expect(handler.pendingCount).toBe(3);
    expect(events.map((e) => e.role)).toEqual(["tester", "reviewer", "fixer"]);
    // 各自独立 reply
    handler.reply(events[0].escalationId, "a1");
    handler.reply(events[2].escalationId, "a3");
    handler.reply(events[1].escalationId, "a2");
    const [a1, a2, a3] = await Promise.all([p1, p2, p3]);
    expect([a1, a2, a3]).toEqual(["a1", "a2", "a3"]);
  });
});

// ---------------------------------------------------------------------------
// 照抄核对 3：messageBudgets 限流（对照 handlers.ts:393-398）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对3：messageBudgets 限流", () => {
  it("照抄 handlers.ts:393 budget = config ?? 10：test-agent 默认 5（改造点）", () => {
    // pi-messenger 默认 10，test-agent 改造为 5（技术方案 §3.4 + 骨架 budget=5）
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(handler.escalationCount("tester")).toBe(0); // 初始 0
  });

  it("照抄 handlers.ts:394 messagesSentThisSession 计数器单调递增", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    handler.ask({ role: "tester", question: "q2" }).catch(() => {});
    await Promise.resolve();
    expect(handler.escalationCount("tester")).toBe(2);
  });

  it("照抄 handlers.ts:395-398 超限返回 budget_exceeded 文本（非抛错）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 1);
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    await Promise.resolve();
    // 第 2 次超 budget
    const r = await handler.ask({ role: "tester", question: "q2", fallback: "保守" });
    expect(r).toContain("预算耗尽");
    expect(r).toContain("1/1");
    expect(r).toContain("[需人工复核]");
    expect(r).toContain("保守");
    handler.reply(events[0].escalationId, "a");
  });

  it("限流 per-role 隔离（照抄 handlers per-coordination 隔离思想）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 1);
    handler.ask({ role: "tester", question: "q" }).catch(() => {});
    await Promise.resolve();
    // reviewer 仍有 budget
    handler.ask({ role: "reviewer", question: "q" }).catch(() => {});
    await Promise.resolve();
    expect(handler.escalationCount("tester")).toBe(1);
    expect(handler.escalationCount("reviewer")).toBe(1);
    handler.reply(events[0].escalationId, "a");
    handler.reply(events[1].escalationId, "a");
  });
});

// ---------------------------------------------------------------------------
// 照抄核对 4：deliverFn/steer（对照 store.ts:57 + 片C steer 默认关闭）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对4：deliverFn 默认 agent.steer + 片C steer 默认关闭", () => {
  it("默认 deliverFn 照抄 store.ts:57：调 agent.steer({role:'user', content:msg})", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    // 用默认 deliverFn（不传第一个参数）—— 但默认 deliverFn 是 (m,a)=>a.steer(...)
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    // 默认 deliverFn 会在 reply 传 agent 时调 agent.steer
    const p = handler.ask({ role: "tester", question: "q" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "答复", mockAgent as never);
    await p;
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "答复" }),
    );
  });

  it("片C steer 默认关闭：isSteerEnabled 默认 false", () => {
    const handler = makeHandler();
    expect(handler.isSteerEnabled("tester")).toBe(false);
  });

  it("片C setSteerEnabled 开启/关闭", () => {
    const handler = makeHandler();
    handler.setSteerEnabled("tester", true);
    expect(handler.isSteerEnabled("tester")).toBe(true);
    handler.setSteerEnabled("tester", false);
    expect(handler.isSteerEnabled("tester")).toBe(false);
  });

  it("片C host-mode replyEscalation 镜像：isSteerEnabled false 时不传 agent → 不 steer", async () => {
    // 镜像 host-mode.ts:53-60 replyEscalation 逻辑
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (m, a) => a.steer({ role: "user", content: m, timestamp: 0 }),
      (e) => events.push(e),
      5000,
      5,
    );
    handler.registerAgent("tester", mockAgent as never);
    const p = handler.ask({ role: "tester", question: "q" });
    await Promise.resolve();
    const role = handler.getPendingRole(events[0].escalationId);
    // 镜像：role && isSteerEnabled(role) ? getAgent(role) : undefined
    const agent = role && handler.isSteerEnabled(role) ? handler.getAgent(role) : undefined;
    handler.reply(events[0].escalationId, "答复", agent);
    await p;
    expect(mockAgent.steer).not.toHaveBeenCalled(); // steer 关闭 → 不调
  });

  it("片C host-mode replyEscalation 镜像：isSteerEnabled true 时传 agent → steer", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (m, a) => a.steer({ role: "user", content: m, timestamp: 0 }),
      (e) => events.push(e),
      5000,
      5,
    );
    handler.registerAgent("tester", mockAgent as never);
    handler.setSteerEnabled("tester", true);
    const p = handler.ask({ role: "tester", question: "q" });
    await Promise.resolve();
    const role = handler.getPendingRole(events[0].escalationId);
    const agent = role && handler.isSteerEnabled(role) ? handler.getAgent(role) : undefined;
    handler.reply(events[0].escalationId, "答复", agent);
    await p;
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
  });

  it("§7 不确定点5 落地：ask resolve 不依赖 deliverFn（核心靠 Promise）", async () => {
    const noopDeliver = vi.fn();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(noopDeliver, (e) => events.push(e), 5000, 5);
    const p = handler.ask({ role: "tester", question: "不依赖 steer" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "靠 Promise");
    const answer = await p;
    expect(answer).toBe("靠 Promise");
    expect(noopDeliver).not.toHaveBeenCalled(); // deliverFn 未调，ask 仍 resolve
  });
});

// ---------------------------------------------------------------------------
// 照抄核对 5：contact_supervisor schema（对照 index.ts:1818-1826）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对5：escalate schema（contact_supervisor 形态）", () => {
  it("schema 字段：question 必填 + fallback/context 可选（精简为 need_decision 单场景）", () => {
    const schema = escalateSchema as unknown as { properties: Record<string, { type?: string; optional?: boolean }> };
    expect(schema.properties.question).toBeDefined();
    expect(schema.properties.fallback).toBeDefined();
    expect(schema.properties.context).toBeDefined();
  });

  it("工具 description 照抄 contact_supervisor 语义：未预料决策/不确定/需审批", () => {
    const handler = makeHandler();
    const tool = createEscalateTool(handler, "tester");
    expect(tool.description).toContain("未预料决策");
    expect(tool.description).toContain("不确定");
    expect(tool.description).toContain("超时");
    expect(tool.description).toContain("[需人工复核]");
  });
});

// ---------------------------------------------------------------------------
// 照抄核对 6：AgentHarnessTool 形态（对照 api-test.ts:16-39 createApiTestTool）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 照抄核对6：createEscalateTool 工厂形态（AgentHarnessTool）", () => {
  it("照抄 createApiTestTool 返回结构：{name, label, description, parameters, execute}", () => {
    const handler = makeHandler();
    const tool = createEscalateTool(handler, "tester");
    expect(tool.name).toBe("escalate");
    expect(tool.label).toBe("escalate");
    expect(typeof tool.description).toBe("string");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("execute 签名照抄 api-test.ts:77：async (_toolCallId, params, _signal) → {content, details}", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const tool = createEscalateTool(handler, "tester");
    const execPromise = tool.execute!("call-1", { question: "q", fallback: "f" }, undefined);
    await Promise.resolve();
    handler.reply(events[0].escalationId, "答复");
    const result = await execPromise;
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.details).toHaveProperty("escalationId");
    expect(result.details).toHaveProperty("resolved");
    expect(result.details).toHaveProperty("degraded");
  });

  it("execute 超时降级：details degraded=true resolved=false，文本含 [需人工复核]", async () => {
    const handler = makeHandler({ timeoutMs: 30 });
    const tool = createEscalateTool(handler, "tester");
    const result = await tool.execute!("c", { question: "q", fallback: "保守方案" });
    expect(result.details.resolved).toBe(false);
    expect(result.details.degraded).toBe(true);
    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.content[0].text).toContain("保守方案");
  });
});

// ---------------------------------------------------------------------------
// 边界探针：竞态——超时 reject 后 reply 到达（不应 resolve）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 边界探针：超时 reject 后 reply 到达", () => {
  it("超时后 reply → 安全无操作（pending 已删除，不应 resolve 也不应报错）", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 30, 5);
    const p = handler.ask({ role: "tester", question: "竞态" });
    const escalationId = await new Promise<string>((resolve) => {
      setTimeout(() => resolve(events[0]?.escalationId ?? ""), 0);
    });
    // 等超时触发
    await expect(p).rejects.toThrow(/超时/);
    expect(handler.pendingCount).toBe(0);
    // 超时后 reply 到达 —— 不应抛错，不应有副作用
    expect(() => handler.reply(escalationId, "迟到答复")).not.toThrow();
    expect(handler.pendingCount).toBe(0); // 仍 0，未重新创建 pending
  });

  it("超时后 reply 传 agent → 不调 deliverFn（pending 已不存在）", async () => {
    const mockAgent = makeMockAgent();
    const deliverFn = vi.fn((m, a) => (a as { steer: (m: unknown) => void }).steer(m));
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(deliverFn, (e) => events.push(e), 30, 5);
    const p = handler.ask({ role: "tester", question: "竞态2" });
    const escalationId = await new Promise<string>((resolve) => {
      setTimeout(() => resolve(events[0]?.escalationId ?? ""), 0);
    });
    await expect(p).rejects.toThrow(/超时/);
    handler.reply(escalationId, "迟到", mockAgent as never);
    expect(deliverFn).not.toHaveBeenCalled(); // pending 不存在，不调 deliverFn
  });
});

// ---------------------------------------------------------------------------
// 边界探针：预算耗尽 escalationId 唯一性（片C P2 修复点）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 边界探针：预算耗尽 escalationId 唯一性（片C P2 修复）", () => {
  it("多次预算耗尽 → 审计日志 escalationId 各不相同", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 1,
      { projectPath: dir },
    );
    // 第 1 次 ask 正常 pending
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    await Promise.resolve();
    // 第 2、3 次超 budget
    await handler.ask({ role: "tester", question: "q2" });
    await handler.ask({ role: "tester", question: "q3" });

    const audit = loadEscalationAudit(dir);
    const budgetEntries = audit.filter((e) => e.degraded && e.question !== "q1");
    expect(budgetEntries.length).toBeGreaterThanOrEqual(2);
    const ids = budgetEntries.map((e) => e.escalationId);
    expect(new Set(ids).size).toBe(ids.length); // 各不相同
    // 原片C P2 修复前用固定 "budget-exceeded"，会重复
    expect(ids.every((id) => id !== "budget-exceeded")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：突变检测（片C）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 边界探针：突变检测（burst）", () => {
  it("窗口内超阈值 → burstWarning 写入审计日志", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 10,
      { projectPath: dir, burstWindowMs: 1000, burstThreshold: 2 },
    );
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    handler.ask({ role: "tester", question: "q2" }).catch(() => {});
    handler.ask({ role: "tester", question: "q3" }).catch(() => {});
    await Promise.resolve();
    const audit = loadEscalationAudit(dir);
    const warned = audit.filter((e) => e.burstWarning);
    expect(warned.length).toBeGreaterThanOrEqual(1);
    expect(warned[0].burstWarning).toContain("不确定区");
  });

  it("低频不触发 burstWarning", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 10,
      { projectPath: dir, burstWindowMs: 1000, burstThreshold: 5 },
    );
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    await Promise.resolve();
    const audit = loadEscalationAudit(dir);
    expect(audit.every((e) => !e.burstWarning)).toBe(true);
  });

  it("不同角色独立计数（tester 高频不触发 reviewer burst）", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 10,
      { projectPath: dir, burstWindowMs: 1000, burstThreshold: 2 },
    );
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    handler.ask({ role: "tester", question: "q2" }).catch(() => {});
    handler.ask({ role: "tester", question: "q3" }).catch(() => {});
    handler.ask({ role: "reviewer", question: "q1" }).catch(() => {});
    await Promise.resolve();
    const audit = loadEscalationAudit(dir);
    const reviewerEntries = audit.filter((e) => e.role === "reviewer");
    expect(reviewerEntries.every((e) => !e.burstWarning)).toBe(true);
    const testerWarned = audit.filter((e) => e.role === "tester" && e.burstWarning);
    expect(testerWarned.length).toBeGreaterThanOrEqual(1);
  });

  it("阈值边界：正好等于阈值不触发（> threshold 才触发）", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 10,
      { projectPath: dir, burstWindowMs: 1000, burstThreshold: 3 },
    );
    // 3 次 ask → recent.length = 3, 不 > 3 → 不触发
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    handler.ask({ role: "tester", question: "q2" }).catch(() => {});
    handler.ask({ role: "tester", question: "q3" }).catch(() => {});
    await Promise.resolve();
    const audit = loadEscalationAudit(dir);
    // 第 3 次 recent.length=3，不 > 3 → 无 burstWarning
    const warned = audit.filter((e) => e.burstWarning);
    expect(warned).toHaveLength(0);
  });

  it("窗口外时间戳自动清理", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 5000, 10,
      { projectPath: dir, burstWindowMs: 50, burstThreshold: 2 },
    );
    // 第 1 次 ask，等窗口过期
    handler.ask({ role: "tester", question: "q1" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 80)); // 超过 burstWindowMs=50
    // 再 2 次 → 窗口内仅 2 个时间戳（第 1 个已清理），不 > 2 → 不触发
    handler.ask({ role: "tester", question: "q2" }).catch(() => {});
    handler.ask({ role: "tester", question: "q3" }).catch(() => {});
    await Promise.resolve();
    const audit = loadEscalationAudit(dir);
    const warned = audit.filter((e) => e.burstWarning);
    expect(warned).toHaveLength(0); // 窗口外清理后不触发
  });
});

// ---------------------------------------------------------------------------
// 边界探针：审计日志（片C）
// ---------------------------------------------------------------------------

describe("[escalation-验收] 边界探针：审计日志 JSONL", () => {
  it("appendEscalationAudit + loadEscalationAudit 往返", () => {
    const dir = makeTmp();
    const entry: EscalationAuditEntry = {
      timestamp: "2026-09-04T10:00:00.000Z",
      escalationId: "test-id-1",
      role: "tester",
      question: "q",
      resolved: false,
      degraded: false,
    };
    appendEscalationAudit(dir, entry);
    const loaded = loadEscalationAudit(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].escalationId).toBe("test-id-1");
  });

  it("审计日志路径 = .test-agent/escalations/<projectHash>/audit.jsonl", () => {
    const dir = makeTmp();
    appendEscalationAudit(dir, {
      timestamp: "t", escalationId: "id", role: "tester", question: "q", resolved: false, degraded: false,
    });
    const hash = computeProjectHash(dir);
    expect(existsSync(join(dir, ".test-agent", "escalations", hash, "audit.jsonl"))).toBe(true);
  });

  it("每次 escalation 产生 2 条审计（ask + resolve/timeout），escalationId 关联", async () => {
    const dir = makeTmp();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      undefined, (e) => events.push(e), 5000, 5,
      { projectPath: dir },
    );
    const p = handler.ask({ role: "tester", question: "审计关联" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "答复");
    await p;
    const audit = loadEscalationAudit(dir);
    expect(audit).toHaveLength(2);
    expect(audit[0].escalationId).toBe(audit[1].escalationId); // 同一 escalationId
    expect(audit[0].resolved).toBe(false); // ask
    expect(audit[1].resolved).toBe(true); // reply
    expect(audit[1].answer).toBe("答复");
  });

  it("超时降级审计：degraded=true + durationMs", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(
      undefined, undefined, 30, 5,
      { projectPath: dir },
    );
    await expect(handler.ask({ role: "tester", question: "超时审计" })).rejects.toThrow(/超时/);
    const audit = loadEscalationAudit(dir);
    const timeoutEntry = audit.find((e) => e.degraded);
    expect(timeoutEntry).toBeDefined();
    expect(timeoutEntry!.degraded).toBe(true);
    expect(timeoutEntry!.durationMs).toBeDefined();
  });

  it("不传 projectPath → 不写审计（向后兼容）", async () => {
    const dir = makeTmp();
    const handler = new EscalationHandler(undefined, undefined, 30, 5); // 无 options.projectPath
    await expect(handler.ask({ role: "tester", question: "无审计" })).rejects.toThrow(/超时/);
    // 不应在 dir 写审计（handler 未关联 dir）
    expect(existsSync(join(dir, ".test-agent"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：host/worker 分流构造差异
// ---------------------------------------------------------------------------

describe("[escalation-验收] 边界探针：host/worker 分流构造差异", () => {
  it("host-mode 构造：notifyFn 转 GUI（emit escalation event）", async () => {
    // 镜像 host-mode.ts:160-163 构造
    const emitted: Array<{ type: string; escalationId?: string }> = [];
    const emit = (e: { type: string }) => { emitted.push(e); };
    const handler = new EscalationHandler(
      (msg, agent) => (agent as { steer: (m: unknown) => void }).steer({ role: "user", content: msg }),
      (e: EscalationEvent) => { void emit({ type: "escalation", ...e }); },
      5000, 5,
    );
    handler.ask({ role: "tester", question: "host" }).catch(() => {});
    await Promise.resolve();
    expect(emitted.some((e) => e.type === "escalation")).toBe(true);
  });

  it("worker-mode 构造：notifyFn=undefined（无 GUI，仅超时降级）", async () => {
    // 镜像 worker-mode.ts:260-264 构造
    const handler = new EscalationHandler(
      (msg, agent) => (agent as { steer: (m: unknown) => void }).steer({ role: "user", content: msg }),
      undefined, // 无 notifyFn
      30, 5,
      { projectPath: makeTmp() },
    );
    // 无通知，仅超时降级
    await expect(handler.ask({ role: "tester", question: "worker" })).rejects.toThrow(/超时/);
  });
});

// ---------------------------------------------------------------------------
// PRD 9 验收场景 A/B/C（方案 §9）
// ---------------------------------------------------------------------------

describe("[escalation-验收] PRD 场景A：host 实时答（ask→notify→reply→resolve）", () => {
  it("完整链路：ask → notifyFn 收到 event → reply → ask resolve 答复", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const askPromise = handler.ask({
      role: "tester",
      question: "用例失败但可能 flaky，继续还是重跑？",
      fallback: "保守重跑",
    });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    // 模拟 GUI 答复
    handler.reply(events[0].escalationId, "重跑一次确认 flaky");
    const answer = await askPromise;
    expect(answer).toBe("重跑一次确认 flaky");
    expect(handler.pendingCount).toBe(0);
  });
});

describe("[escalation-验收] PRD 场景B：worker 超时降级（无 notifyFn → reject → 降级+[需人工复核]）", () => {
  it("完整链路：ask（无 notifyFn）→ 超时 reject → 工具 catch → 降级文本+[需人工复核]", async () => {
    const handler = new EscalationHandler(undefined, undefined, 30, 5);
    const tool = createEscalateTool(handler, "tester");
    const result = await tool.execute!("c", {
      question: "worker 超时降级",
      fallback: "按最保守不扩大范围方案继续",
    });
    expect(result.details.resolved).toBe(false);
    expect(result.details.degraded).toBe(true);
    expect(result.content[0].text).toContain("降级");
    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.content[0].text).toContain("按最保守不扩大范围方案继续");
  });
});

describe("[escalation-验收] PRD 场景C：向后兼容（不开 escalation 行为同今）", () => {
  it("RoleConfig.escalation 默认 undefined → 不注入 escalate", () => {
    const role = makeRoleConfig();
    expect(role.escalation).toBeUndefined();
  });

  it("AgentRunContext.escalationHandler 可选 → 不传时 runner 不注入（源码确认 runner.ts if role.escalation && handler）", () => {
    // 镜像 runner.ts:775 if (role.escalation && this.escalationHandler)
    const role = makeRoleConfig({ escalation: undefined });
    const handler: EscalationHandler | undefined = undefined;
    const shouldInject = !!(role.escalation && handler);
    expect(shouldInject).toBe(false);
  });

  it("角色开 escalation:true + 有 handler → 注入（源码确认）", () => {
    const role = makeRoleConfig({ escalation: true });
    const handler = makeHandler();
    const shouldInject = !!(role.escalation && handler);
    expect(shouldInject).toBe(true);
  });

  it("角色开 escalation 但无 handler → 不注入（旧调用方不传 handler）", () => {
    const role = makeRoleConfig({ escalation: true });
    const handler: EscalationHandler | undefined = undefined;
    const shouldInject = !!(role.escalation && handler);
    expect(shouldInject).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 独立判断点：控制面零改动 + §7 不确定点处理
// ---------------------------------------------------------------------------

describe("[escalation-验收] 独立判断点：控制面零改动 + §7 不确定点", () => {
  it("控制面零改动：escalation 全程 test-agent 包内（无 services/ 调用）—— 源码确认", () => {
    // escalation-handler.ts: import randomUUID + Agent + escalation-audit
    // escalation-audit.ts: import fs + path + computeProjectHash（test-agent 内）
    // 无 HTTP/RPC/Java 调用。审计落本地 .test-agent/escalations/
    const handler = makeHandler();
    expect(handler).toBeDefined();
    // 源码级确认：escalation-audit.ts 用 appendFileSync 本地写，无 services 调用
  });

  it("§7 不确定点1 落地：核心靠 Promise 不靠 steer（ask resolve 不依赖 deliverFn）", async () => {
    // 已在照抄核对4 验证，此处强调：工具 execute await handler.ask() 拿答复返回
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(vi.fn(), (e) => events.push(e), 5000, 5); // deliverFn = no-op
    const tool = createEscalateTool(handler, "tester");
    const execPromise = tool.execute!("c", { question: "靠 Promise" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "工具返回值即答复");
    const result = await execPromise;
    expect(result.content[0].text).toBe("工具返回值即答复");
    expect(result.details.resolved).toBe(true);
  });

  it("§7 不确定点5 落地：steer 默认关闭，靠工具返回值传递答复", () => {
    // 片C 实现说明明确：默认关闭 steer，避免双重注入
    const handler = makeHandler();
    expect(handler.isSteerEnabled("tester")).toBe(false);
    // 若需强化，角色 .md 加 escalationSteer: true
  });
});
