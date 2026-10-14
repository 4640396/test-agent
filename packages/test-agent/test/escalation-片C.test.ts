/**
 * escalation 通道片C测试：全角色开启 + 审计日志 + steer 增强 + 突变检测。
 *
 * 覆盖：
 * - 全角色开启后 runner 接线测试（scout/case-designer/reviewer 都注入 escalate）
 * - 审计日志写入+读取测试（escalation-audit.ts）
 * - steer 增强测试（reply 传 agent → steer 被调；默认关闭配置生效）
 * - 突变检测测试（高频 ask → 告警标记）
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EscalationHandler,
  type EscalationEvent,
} from "../src/core/escalation-handler.js";
import { createEscalateTool } from "../src/core/tools/escalate.js";
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

function makeMockAgent(): { steer: ReturnType<typeof vi.fn> } {
  return { steer: vi.fn() };
}

function makeRoleConfig(opts?: Partial<RoleConfig>): RoleConfig {
  return {
    name: opts?.name ?? "tester",
    tools: opts?.tools ?? ["read"],
    systemPrompt: opts?.systemPrompt ?? "test",
    escalation: opts?.escalation,
    fallback: opts?.fallback,
    escalationSteer: opts?.escalationSteer,
  };
}

/** 创建临时项目目录（审计日志测试用）。 */
function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "esc-audit-"));
}

// ---------------------------------------------------------------------------
// 全角色开启 runner 接线测试
// ---------------------------------------------------------------------------

describe("片C：全角色开启 escalation", () => {
  it("scout 配 escalation:true → 工具注入 + registerAgent", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ name: "scout", escalation: true, fallback: "按最保守不扩大范围方案继续，跳过不确定的侦察点" });
    const mockAgent = makeMockAgent();

    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "scout"));
      handler.registerAgent("scout", mockAgent as any);
    }

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("escalate");
    expect(handler.getAgent("scout")).toBe(mockAgent);
  });

  it("case-designer 配 escalation:true → 工具注入 + registerAgent", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ name: "case-designer", escalation: true, fallback: "跳过不确定用例，按已确认信息设计" });
    const mockAgent = makeMockAgent();

    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "case-designer"));
      handler.registerAgent("case-designer", mockAgent as any);
    }

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("escalate");
    expect(handler.getAgent("case-designer")).toBe(mockAgent);
  });

  it("result-reviewer 配 escalation:true → 工具注入 + registerAgent", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ name: "result-reviewer", escalation: true, fallback: "标记诊断不确定，保守归类" });
    const mockAgent = makeMockAgent();

    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "result-reviewer"));
      handler.registerAgent("result-reviewer", mockAgent as any);
    }

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("escalate");
    expect(handler.getAgent("result-reviewer")).toBe(mockAgent);
  });

  it("全角色 fallback 符合角色定位", () => {
    const scoutRole = makeRoleConfig({ name: "scout", escalation: true, fallback: "按最保守不扩大范围方案继续，跳过不确定的侦察点" });
    const designerRole = makeRoleConfig({ name: "case-designer", escalation: true, fallback: "跳过不确定用例，按已确认信息设计" });
    const reviewerRole = makeRoleConfig({ name: "result-reviewer", escalation: true, fallback: "标记诊断不确定，保守归类" });

    expect(scoutRole.fallback).toContain("跳过不确定的侦察点");
    expect(designerRole.fallback).toContain("跳过不确定用例");
    expect(reviewerRole.fallback).toContain("保守归类");
  });
});

// ---------------------------------------------------------------------------
// 审计日志测试
// ---------------------------------------------------------------------------

describe("片C：审计日志（escalation-audit.ts）", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("appendEscalationAudit 写入 → loadEscalationAudit 读取", () => {
    const entry: EscalationAuditEntry = {
      timestamp: "2026-09-04T12:00:00.000Z",
      escalationId: "esc-001",
      role: "tester",
      question: "用例失败需决策",
      fallback: "保守重跑",
      resolved: false,
      degraded: false,
    };
    appendEscalationAudit(projectPath, entry);

    const loaded = loadEscalationAudit(projectPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].escalationId).toBe("esc-001");
    expect(loaded[0].role).toBe("tester");
    expect(loaded[0].question).toBe("用例失败需决策");
    expect(loaded[0].resolved).toBe(false);
  });

  it("多条审计日志按时间正序追加", () => {
    const e1: EscalationAuditEntry = {
      timestamp: "2026-09-04T12:00:00.000Z",
      escalationId: "esc-001",
      role: "tester",
      question: "q1",
      resolved: false,
      degraded: false,
    };
    const e2: EscalationAuditEntry = {
      timestamp: "2026-09-04T12:00:01.000Z",
      escalationId: "esc-001",
      role: "tester",
      question: "q1",
      resolved: true,
      degraded: false,
      answer: "继续",
      durationMs: 1000,
    };
    appendEscalationAudit(projectPath, e1);
    appendEscalationAudit(projectPath, e2);

    const loaded = loadEscalationAudit(projectPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].resolved).toBe(false);
    expect(loaded[1].resolved).toBe(true);
    expect(loaded[1].answer).toBe("继续");
    expect(loaded[1].durationMs).toBe(1000);
  });

  it("空审计日志 → loadEscalationAudit 返回空数组", () => {
    const loaded = loadEscalationAudit(projectPath);
    expect(loaded).toEqual([]);
  });

  it("审计日志文件路径 = .test-agent/escalations/<projectHash>/audit.jsonl", () => {
    const entry: EscalationAuditEntry = {
      timestamp: "2026-09-04T12:00:00.000Z",
      escalationId: "esc-001",
      role: "tester",
      question: "q",
      resolved: false,
      degraded: false,
    };
    appendEscalationAudit(projectPath, entry);

    const hash = computeProjectHash(projectPath);
    const auditFile = join(projectPath, ".test-agent", "escalations", hash, "audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);

    const raw = readFileSync(auditFile, "utf8").trim();
    const parsed = JSON.parse(raw) as EscalationAuditEntry;
    expect(parsed.escalationId).toBe("esc-001");
  });

  it("Handler 带 projectPath → ask 时自动写审计", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      undefined,
      (e) => events.push(e),
      5000,
      5,
      { projectPath },
    );

    const askPromise = handler.ask({ role: "tester", question: "审计测试" });
    await Promise.resolve();

    // ask 时写一条 pending 审计
    const auditAfterAsk = loadEscalationAudit(projectPath);
    expect(auditAfterAsk).toHaveLength(1);
    expect(auditAfterAsk[0].resolved).toBe(false);
    expect(auditAfterAsk[0].degraded).toBe(false);
    expect(auditAfterAsk[0].role).toBe("tester");

    // reply 后写一条 resolved 审计
    handler.reply(events[0].escalationId, "答复");
    await askPromise;

    const auditAfterReply = loadEscalationAudit(projectPath);
    expect(auditAfterReply).toHaveLength(2);
    expect(auditAfterReply[1].resolved).toBe(true);
    expect(auditAfterReply[1].answer).toBe("答复");
    expect(auditAfterReply[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("Handler 带 projectPath → 超时时写降级审计", async () => {
    const handler = new EscalationHandler(
      undefined,
      undefined,
      50,
      5,
      { projectPath },
    );

    const askPromise = handler.ask({ role: "tester", question: "超时审计", fallback: "保守方案" });
    await expect(askPromise).rejects.toThrow("超时");

    const audit = loadEscalationAudit(projectPath);
    // ask 时 1 条 + 超时 1 条
    expect(audit).toHaveLength(2);
    expect(audit[0].resolved).toBe(false);
    expect(audit[0].degraded).toBe(false);
    expect(audit[1].resolved).toBe(false);
    expect(audit[1].degraded).toBe(true);
    expect(audit[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("Handler 不带 projectPath → 不写审计", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);

    const askPromise = handler.ask({ role: "tester", question: "无审计" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "答复");
    await askPromise;

    const audit = loadEscalationAudit(projectPath);
    expect(audit).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// steer 增强测试
// ---------------------------------------------------------------------------

describe("片C：steer 增强", () => {
  it("setSteerEnabled(role, true) → isSteerEnabled(role) 返回 true", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(handler.isSteerEnabled("tester")).toBe(false);

    handler.setSteerEnabled("tester", true);
    expect(handler.isSteerEnabled("tester")).toBe(true);
  });

  it("setSteerEnabled(role, false) → isSteerEnabled(role) 返回 false", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    handler.setSteerEnabled("tester", true);
    handler.setSteerEnabled("tester", false);
    expect(handler.isSteerEnabled("tester")).toBe(false);
  });

  it("默认 isSteerEnabled 返回 false（steer 默认关闭）", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(handler.isSteerEnabled("scout")).toBe(false);
    expect(handler.isSteerEnabled("case-designer")).toBe(false);
    expect(handler.isSteerEnabled("result-reviewer")).toBe(false);
    expect(handler.isSteerEnabled("tester")).toBe(false);
    expect(handler.isSteerEnabled("fixer")).toBe(false);
  });

  it("reply 传 roleAgent → deliverFn 调 agent.steer（片A 兼容，handler 层不变）", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );

    const askPromise = handler.ask({ role: "tester", question: "steer 测试" });
    await Promise.resolve();

    handler.reply(events[0].escalationId, "答复内容", mockAgent as any);
    await askPromise;

    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
  });

  it("接线层：isSteerEnabled=false → 不传 agent → steer 不被调（默认关闭）", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );
    handler.registerAgent("tester", mockAgent as any);
    // 不调 setSteerEnabled → isSteerEnabled=false

    const askPromise = handler.ask({ role: "tester", question: "默认关闭" });
    await Promise.resolve();

    // 模拟 host-mode replyEscalation：isSteerEnabled=false → 不传 agent
    const role = handler.getPendingRole(events[0].escalationId);
    const agent = role && handler.isSteerEnabled(role) ? handler.getAgent(role) : undefined;
    handler.reply(events[0].escalationId, "答复", agent);
    await askPromise;

    expect(mockAgent.steer).not.toHaveBeenCalled();
  });

  it("接线层：isSteerEnabled=true → 传 agent → steer 被调（配置开启）", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );
    handler.registerAgent("tester", mockAgent as any);
    handler.setSteerEnabled("tester", true); // escalationSteer: true

    const askPromise = handler.ask({ role: "tester", question: "配置开启" });
    await Promise.resolve();

    // 模拟 host-mode replyEscalation：isSteerEnabled=true → 传 agent
    const role = handler.getPendingRole(events[0].escalationId);
    const agent = role && handler.isSteerEnabled(role) ? handler.getAgent(role) : undefined;
    handler.reply(events[0].escalationId, "总代理答复: 答复", agent);
    await askPromise;

    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "总代理答复: 答复" }),
    );
  });

  it("getPendingRole 返回 pending 的 role", async () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const events: EscalationEvent[] = [];
    const h = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);

    const p = h.ask({ role: "result-reviewer", question: "role 查询" });
    await Promise.resolve();

    expect(h.getPendingRole(events[0].escalationId)).toBe("result-reviewer");
    h.reply(events[0].escalationId, "答复");
    await p;
  });

  it("getPendingRole 不存在的 id → undefined", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(handler.getPendingRole("nonexistent")).toBeUndefined();
  });

  it("集成：registerAgent + setSteerEnabled + reply → 完整 steer 流程", async () => {
    const mockAgent = makeMockAgent();
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );

    // runner 接线：registerAgent + setSteerEnabled
    handler.registerAgent("scout", mockAgent as any);
    handler.setSteerEnabled("scout", true);

    // 角色调 escalate
    const tool = createEscalateTool(handler, "scout");
    const execPromise = tool.execute!("call-1", { question: "不确定的侦察点", fallback: "跳过" });
    await Promise.resolve();

    // host-mode replyEscalation：查 role + isSteerEnabled + getAgent
    const role = handler.getPendingRole(events[0].escalationId);
    expect(role).toBe("scout");
    expect(handler.isSteerEnabled("scout")).toBe(true);
    const agent = handler.getAgent("scout");
    handler.reply(events[0].escalationId, "总代理答复: 继续", agent);

    const result = await execPromise;
    expect(result.content[0].text).toBe("总代理答复: 继续");
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 突变检测测试
// ---------------------------------------------------------------------------

describe("片C：突变检测", () => {
  it("高频 ask（窗口内 >3 次）→ audit 含 burstWarning", async () => {
    const projectPath = makeTempProject();
    try {
      const events: EscalationEvent[] = [];
      const handler = new EscalationHandler(
        undefined,
        (e) => events.push(e),
        5000,
        10, // budget 10 让我们可以发起 4 次 ask
        { projectPath, burstWindowMs: 60_000, burstThreshold: 3 },
      );

      // 发起 4 次 ask（第 4 次触发 burst）
      const promises: Promise<string>[] = [];
      for (let i = 0; i < 4; i++) {
        promises.push(handler.ask({ role: "tester", question: `q${i}` }));
        await Promise.resolve();
      }

      // 审计日志中第 4 条应含 burstWarning
      const audit = loadEscalationAudit(projectPath);
      const burstEntries = audit.filter((e) => e.burstWarning);
      expect(burstEntries).toHaveLength(1);
      expect(burstEntries[0].burstWarning).toContain("卡在不确定区");
      expect(burstEntries[0].burstWarning).toContain("建议人工介入");

      // 清理
      for (let i = 0; i < 4; i++) {
        handler.reply(events[i].escalationId, `a${i}`);
      }
      await Promise.all(promises);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("低频 ask（窗口内 ≤3 次）→ 无 burstWarning", async () => {
    const projectPath = makeTempProject();
    try {
      const events: EscalationEvent[] = [];
      const handler = new EscalationHandler(
        undefined,
        (e) => events.push(e),
        5000,
        10,
        { projectPath, burstWindowMs: 60_000, burstThreshold: 3 },
      );

      // 发起 3 次 ask（不触发 burst）
      for (let i = 0; i < 3; i++) {
        handler.ask({ role: "tester", question: `q${i}` });
        await Promise.resolve();
      }

      const audit = loadEscalationAudit(projectPath);
      const burstEntries = audit.filter((e) => e.burstWarning);
      expect(burstEntries).toHaveLength(0);

      // 清理
      for (let i = 0; i < 3; i++) {
        handler.reply(events[i].escalationId, `a${i}`);
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("不同角色独立计数（tester 高频不触发 reviewer burst）", async () => {
    const projectPath = makeTempProject();
    try {
      const events: EscalationEvent[] = [];
      const handler = new EscalationHandler(
        undefined,
        (e) => events.push(e),
        5000,
        10,
        { projectPath, burstWindowMs: 60_000, burstThreshold: 3 },
      );

      // tester 3 次（不触发）
      for (let i = 0; i < 3; i++) {
        handler.ask({ role: "tester", question: `tq${i}` });
        await Promise.resolve();
      }
      // reviewer 1 次（不触发）
      handler.ask({ role: "result-reviewer", question: "rq0" });
      await Promise.resolve();

      const audit = loadEscalationAudit(projectPath);
      const burstEntries = audit.filter((e) => e.burstWarning);
      expect(burstEntries).toHaveLength(0);

      // 清理
      for (const evt of events) {
        handler.reply(evt.escalationId, "a");
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("自定义 burstWindowMs + burstThreshold 生效", async () => {
    const projectPath = makeTempProject();
    try {
      const events: EscalationEvent[] = [];
      const handler = new EscalationHandler(
        undefined,
        (e) => events.push(e),
        5000,
        10,
        { projectPath, burstWindowMs: 100, burstThreshold: 1 },
      );

      // 第 2 次 ask 就触发（threshold=1）
      handler.ask({ role: "tester", question: "q0" });
      await Promise.resolve();
      handler.ask({ role: "tester", question: "q1" });
      await Promise.resolve();

      const audit = loadEscalationAudit(projectPath);
      const burstEntries = audit.filter((e) => e.burstWarning);
      expect(burstEntries).toHaveLength(1);
      expect(burstEntries[0].burstWarning).toContain("100ms");
      expect(burstEntries[0].burstWarning).toContain("2 次");

      // 清理
      for (const evt of events) {
        handler.reply(evt.escalationId, "a");
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// agent-loader escalationSteer 解析测试
// ---------------------------------------------------------------------------

describe("片C：agent-loader escalationSteer 解析", () => {
  it("RoleConfig 包含 escalationSteer 字段", () => {
    const role = makeRoleConfig({ escalationSteer: true });
    expect(role.escalationSteer).toBe(true);
  });

  it("RoleConfig 默认 escalationSteer=undefined（默认关闭）", () => {
    const role = makeRoleConfig();
    expect(role.escalationSteer).toBeUndefined();
  });
});
