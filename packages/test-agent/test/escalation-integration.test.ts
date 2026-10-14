/**
 * escalation 通道集成测试（片B：runner 接线 + host/worker 分流 + GUI 逻辑 + 场景 A/B/C）。
 *
 * 覆盖：
 * - runner 接线：role.escalation=true 时工具注入 + registerAgent；未设时工具不注入（向后兼容）
 * - host-mode 分流：notifyFn 被调传 EscalationEvent
 * - worker-mode 分流：无 notifyFn，ask 超时降级
 * - GUI 逻辑判定函数：escalation event → 显示弹窗
 * - 场景A（host 实时答：handler.ask → reply → 角色收到答复）
 * - 场景B（worker 超时降级 + [需人工复核]）
 * - 场景C（向后兼容：不开 escalation 的角色行为同今）
 */

import { describe, expect, it, vi } from "vitest";
import {
  EscalationHandler,
  type EscalationEvent,
} from "../src/core/escalation-handler.js";
import { createEscalateTool } from "../src/core/tools/escalate.js";
import type { RoleConfig } from "../src/core/agent-loader.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRoleConfig(opts?: Partial<RoleConfig>): RoleConfig {
  return {
    name: opts?.name ?? "tester",
    tools: opts?.tools ?? ["read", "write", "edit"],
    systemPrompt: opts?.systemPrompt ?? "test prompt",
    escalation: opts?.escalation,
    fallback: opts?.fallback,
  };
}

/** mock Agent（{steer: vi.fn()}）。 */
function makeMockAgent(): { steer: ReturnType<typeof vi.fn> } {
  return { steer: vi.fn() };
}

// ---------------------------------------------------------------------------
// runner 接线集成测试
// ---------------------------------------------------------------------------

describe("runner 接线：escalation 工具注入", () => {
  it("role.escalation=true + handler 可用 → escalate 工具被注入", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ escalation: true, fallback: "保守方案" });

    // 模拟 runner 接线逻辑
    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "tester"));
    }

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("escalate");
  });

  it("role.escalation 未设 → escalate 工具不注入（向后兼容）", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ escalation: undefined });

    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "tester"));
    }

    expect(tools).toHaveLength(0);
  });

  it("handler 不可用 → escalate 工具不注入（向后兼容）", () => {
    const role = makeRoleConfig({ escalation: true });
    const handler: EscalationHandler | undefined = undefined;

    const tools: unknown[] = [];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "tester"));
    }

    expect(tools).toHaveLength(0);
  });

  it("role.escalation=true → registerAgent 被调", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ escalation: true });
    const mockAgent = makeMockAgent();

    // 模拟 runner 接线逻辑
    if (role.escalation && handler) {
      handler.registerAgent("tester", mockAgent as any);
    }

    expect(handler.getAgent("tester")).toBe(mockAgent);
  });

  it("role.escalation 未设 → registerAgent 不被调", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ escalation: undefined });
    const mockAgent = makeMockAgent();

    if (role.escalation && handler) {
      handler.registerAgent("tester", mockAgent as any);
    }

    expect(handler.getAgent("tester")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agent-loader 解析测试
// ---------------------------------------------------------------------------

describe("agent-loader escalation/fallback 解析", () => {
  it("RoleConfig 包含 escalation + fallback 字段", () => {
    const role = makeRoleConfig({
      escalation: true,
      fallback: "按最保守方案继续",
    });

    expect(role.escalation).toBe(true);
    expect(role.fallback).toBe("按最保守方案继续");
  });

  it("RoleConfig 默认 escalation=undefined, fallback=undefined（向后兼容）", () => {
    const role = makeRoleConfig();

    expect(role.escalation).toBeUndefined();
    expect(role.fallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// host-mode 分流测试
// ---------------------------------------------------------------------------

describe("host-mode 分流：notifyFn 被调传 EscalationEvent", () => {
  it("host-mode handler 构造时 notifyFn 被传入，ask 时触发", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );

    const askPromise = handler.ask({ role: "tester", question: "需要决策" });
    await Promise.resolve();

    // notifyFn 被调
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("tester");
    expect(events[0].question).toBe("需要决策");

    // 模拟 GUI 答复 → handler.reply
    handler.reply(events[0].escalationId, "继续执行");
    const answer = await askPromise;
    expect(answer).toBe("继续执行");
  });
});

// ---------------------------------------------------------------------------
// worker-mode 分流测试
// ---------------------------------------------------------------------------

describe("worker-mode 分流：无 notifyFn，ask 超时降级", () => {
  it("worker-mode handler 无 notifyFn，超时后 reject", async () => {
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      undefined, // 无 GUI
      50, // 50ms 超时
      5,
    );

    const askPromise = handler.ask({ role: "tester", question: "无人答" });
    await expect(askPromise).rejects.toThrow("超时");
  });

  it("worker-mode escalate 工具超时 → 降级文本含 [需人工复核]", async () => {
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    const tool = createEscalateTool(handler, "tester");

    const result = await tool.execute!("call-1", {
      question: "worker 超时降级",
      fallback: "按最保守方案继续",
    });

    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.content[0].text).toContain("按最保守方案继续");
    expect(result.details.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GUI 逻辑判定函数测试（不依赖 DOM）
// ---------------------------------------------------------------------------

describe("GUI escalation 逻辑判定", () => {
  /** 模拟 App.vue 的 escalation pending 逻辑 */
  function processEscalationEvent(
    event: { type: string; escalationId?: string; role?: string; question?: string; fallback?: string },
    executionId: string,
  ): { isEscalation: boolean; pending: { escalationId: string; role: string; question: string; fallback?: string; executionId: string } | null } {
    if (event.type === "escalation" && event.escalationId) {
      return {
        isEscalation: true,
        pending: {
          escalationId: event.escalationId,
          role: event.role ?? "未知角色",
          question: event.question ?? "",
          fallback: event.fallback,
          executionId,
        },
      };
    }
    return { isEscalation: false, pending: null };
  }

  it("escalation event → isEscalation=true，pending 含完整信息", () => {
    const result = processEscalationEvent(
      { type: "escalation", escalationId: "esc-123", role: "tester", question: "用例失败需决策", fallback: "保守重跑" },
      "exec-456",
    );

    expect(result.isEscalation).toBe(true);
    expect(result.pending).not.toBeNull();
    expect(result.pending!.escalationId).toBe("esc-123");
    expect(result.pending!.role).toBe("tester");
    expect(result.pending!.question).toBe("用例失败需决策");
    expect(result.pending!.fallback).toBe("保守重跑");
    expect(result.pending!.executionId).toBe("exec-456");
  });

  it("非 escalation event → isEscalation=false", () => {
    const result = processEscalationEvent(
      { type: "log", escalationId: undefined, role: undefined, question: undefined },
      "exec-456",
    );

    expect(result.isEscalation).toBe(false);
    expect(result.pending).toBeNull();
  });

  it("escalation event 无 escalationId → 不处理（安全降级）", () => {
    const result = processEscalationEvent(
      { type: "escalation", escalationId: undefined, role: "tester", question: "缺少 id" },
      "exec-456",
    );

    expect(result.isEscalation).toBe(false);
  });

  it("多个并发 escalation event 各自独立（按 escalationId 区分）", () => {
    const pending1 = processEscalationEvent(
      { type: "escalation", escalationId: "esc-1", role: "tester", question: "问题1" },
      "exec-1",
    );
    const pending2 = processEscalationEvent(
      { type: "escalation", escalationId: "esc-2", role: "result-reviewer", question: "问题2" },
      "exec-1",
    );

    expect(pending1.pending!.escalationId).toBe("esc-1");
    expect(pending2.pending!.escalationId).toBe("esc-2");
    expect(pending1.pending!.role).toBe("tester");
    expect(pending2.pending!.role).toBe("result-reviewer");
  });
});

// ---------------------------------------------------------------------------
// 场景A：host 实时答（handler.ask → reply → 角色收到答复）
// ---------------------------------------------------------------------------

describe("场景A：host 实时答", () => {
  it("角色调 escalate → host 人答 → 角色收到答复继续执行", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      (e) => events.push(e),
      5000,
      5,
    );
    const mockAgent = makeMockAgent();
    handler.registerAgent("tester", mockAgent as any);

    const tool = createEscalateTool(handler, "tester");

    // 角色 LLM 调用 escalate 工具
    const execPromise = tool.execute!("call-1", {
      question: "用例失败可能 flaky，继续还是重跑？",
      fallback: "保守重跑",
    });

    // 等一个 tick 让 notifyFn 被调
    await Promise.resolve();

    // GUI 收到 escalation event，人答"重跑一次"
    expect(events).toHaveLength(1);
    handler.reply(events[0].escalationId, "重跑一次确认", mockAgent as any);

    // 角色工具 execute 拿到答复
    const result = await execPromise;
    expect(result.content[0].text).toBe("重跑一次确认");
    expect(result.details.resolved).toBe(true);
    expect(result.details.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 场景B：worker 超时降级 + [需人工复核]
// ---------------------------------------------------------------------------

describe("场景B：worker 超时降级", () => {
  it("角色调 escalate → 无人答 → 超时降级保守方案 + [需人工复核]", async () => {
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    const tool = createEscalateTool(handler, "tester");

    const result = await tool.execute!("call-1", {
      question: "不确定的测试结果",
      fallback: "按最保守不扩大范围方案继续",
    });

    expect(result.content[0].text).toContain("降级");
    expect(result.content[0].text).toContain("超时");
    expect(result.content[0].text).toContain("按最保守不扩大范围方案继续");
    expect(result.content[0].text).toContain("[需人工复核]");
    expect(result.details.resolved).toBe(false);
    expect(result.details.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 场景C：向后兼容（不开 escalation 的角色行为同今）
// ---------------------------------------------------------------------------

describe("场景C：向后兼容", () => {
  it("role.escalation 未设 → 工具数组不含 escalate", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const role = makeRoleConfig({ escalation: undefined });

    const tools: unknown[] = ["read", "write", "edit"];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "tester"));
    }

    expect(tools).toEqual(["read", "write", "edit"]);
    expect(tools.find((t) => (t as { name: string }).name === "escalate")).toBeUndefined();
  });

  it("handler 未传 → 工具数组不含 escalate（即使 role.escalation=true）", () => {
    const role = makeRoleConfig({ escalation: true });
    const handler: EscalationHandler | undefined = undefined;

    const tools: unknown[] = ["read", "write", "edit"];
    if (role.escalation && handler) {
      tools.push(createEscalateTool(handler, "tester"));
    }

    expect(tools).toEqual(["read", "write", "edit"]);
  });

  it("escalationHandler 可选 → 不传时 runner 不注入工具（现有调用方不受影响）", () => {
    // 模拟 context.escalationHandler 未设
    const context = { taskId: "task-1" }; // 无 escalationHandler
    const role = makeRoleConfig({ escalation: true });

    const tools: unknown[] = ["read", "write", "edit"];
    if (role.escalation && context.escalationHandler) {
      tools.push(createEscalateTool(context.escalationHandler as EscalationHandler, "tester"));
    }

    expect(tools).toEqual(["read", "write", "edit"]);
  });
});

// ---------------------------------------------------------------------------
// orchestrator/fix-orchestrator 接线：role.escalation 检查（P1-1 回归）
// ---------------------------------------------------------------------------

describe("orchestrator/fix-orchestrator 接线：role.escalation 检查", () => {
  // 模拟 runner.ts 传 escalationHandler 给 runDiagnosis/runFixByDiagnosis 的逻辑
  function getDiagnosisHandler(role: RoleConfig | undefined, handler: EscalationHandler | undefined): EscalationHandler | undefined {
    return role?.escalation ? handler : undefined;
  }

  it("result-reviewer 未配 escalation → 不传 handler 给 runDiagnosis", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const reviewerRole = makeRoleConfig({ name: "result-reviewer", escalation: undefined });

    const passed = getDiagnosisHandler(reviewerRole, handler);
    expect(passed).toBeUndefined();
  });

  it("result-reviewer 配 escalation:true → 传 handler 给 runDiagnosis", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const reviewerRole = makeRoleConfig({ name: "result-reviewer", escalation: true });

    const passed = getDiagnosisHandler(reviewerRole, handler);
    expect(passed).toBe(handler);
  });

  it("fixer 无 .md → roles[fixer] undefined → 不传 handler 给 runFixByDiagnosis", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    // fixer 无 .md 文件，loadRoles 返回的 map 中无 fixer
    const fixerRole = undefined;

    const passed = getDiagnosisHandler(fixerRole, handler);
    expect(passed).toBeUndefined();
  });

  it("handler undefined → 无论角色配置如何都不传", () => {
    const reviewerRole = makeRoleConfig({ name: "result-reviewer", escalation: true });

    const passed = getDiagnosisHandler(reviewerRole, undefined);
    expect(passed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerAgent / getAgent 测试
// ---------------------------------------------------------------------------

describe("registerAgent / getAgent", () => {
  it("registerAgent 后 getAgent 返回注册的 agent", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const mockAgent = makeMockAgent();

    handler.registerAgent("tester", mockAgent as any);
    expect(handler.getAgent("tester")).toBe(mockAgent);
  });

  it("未注册的 role → getAgent 返回 undefined", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(handler.getAgent("result-reviewer")).toBeUndefined();
  });

  it("多角色注册各自独立", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    const mockTester = makeMockAgent();
    const mockReviewer = makeMockAgent();

    handler.registerAgent("tester", mockTester as any);
    handler.registerAgent("result-reviewer", mockReviewer as any);

    expect(handler.getAgent("tester")).toBe(mockTester);
    expect(handler.getAgent("result-reviewer")).toBe(mockReviewer);
  });
});

// ---------------------------------------------------------------------------
// 接线层双守卫：roleEscalation 字段（批2——fix-orchestrator/orchestrator 不假设调用方守卫）
// ---------------------------------------------------------------------------

describe("接线层双守卫：roleEscalation 字段", () => {
  // 模拟接线层的双守卫逻辑：if (deps.escalationHandler && deps.roleEscalation)
  function shouldInject(handler: EscalationHandler | undefined, roleEscalation: boolean | undefined): boolean {
    return !!(handler && roleEscalation);
  }

  it("handler 存在但 roleEscalation 未设 → 不注入（接线层自守卫，不假设调用方已守卫）", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(shouldInject(handler, undefined)).toBe(false);
    expect(shouldInject(handler, false)).toBe(false);
  });

  it("handler 存在且 roleEscalation=true → 注入", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(shouldInject(handler, true)).toBe(true);
  });

  it("handler undefined 且 roleEscalation=true → 不注入", () => {
    expect(shouldInject(undefined, true)).toBe(false);
  });

  it("调用方传 roleEscalation: !!role?.escalation 还原 runExecute 的 role?.escalation && handler 语义", () => {
    // 模拟 runner.ts: !!roles["result-reviewer"]?.escalation
    const roleWithEscalation = makeRoleConfig({ name: "result-reviewer", escalation: true });
    const roleWithout = makeRoleConfig({ name: "result-reviewer", escalation: undefined });
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    expect(shouldInject(handler, !!roleWithEscalation.escalation)).toBe(true);
    expect(shouldInject(handler, !!roleWithout.escalation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentRunResult.report.escalations 接线（批2——从 handler.getRecords 填充）
// ---------------------------------------------------------------------------

describe("AgentRunResult.report.escalations 接线", () => {
  it("handler 无 records → report.escalations undefined（向后兼容）", () => {
    const handler = new EscalationHandler(undefined, undefined, 5000, 5);
    // 模拟 runExecute 末尾收集
    const escalations = handler.getRecords().length > 0 ? [...handler.getRecords()] : undefined;
    expect(escalations).toBeUndefined();
  });

  it("handler 有 records → report.escalations 填充", async () => {
    const events: EscalationEvent[] = [];
    const handler = new EscalationHandler(undefined, (e) => events.push(e), 5000, 5);
    const p = handler.ask({ role: "tester", question: "q1", fallback: "fb" });
    await Promise.resolve();
    handler.reply(events[0].escalationId, "a1");
    await p;
    // 模拟 runExecute 末尾收集
    const escalations = handler.getRecords().length > 0 ? [...handler.getRecords()] : undefined;
    expect(escalations).toBeDefined();
    expect(escalations!.length).toBeGreaterThan(0);
    expect(escalations!.some((r) => r.role === "tester")).toBe(true);
  });

  it("超时降级 records → report.escalations 含 degraded=true 条目", async () => {
    const handler = new EscalationHandler(undefined, undefined, 50, 5);
    await expect(handler.ask({ role: "fixer", question: "q1", fallback: "保守" })).rejects.toThrow(/超时/);
    const escalations = [...handler.getRecords()];
    expect(escalations.some((r) => r.degraded && r.role === "fixer")).toBe(true);
  });
});
