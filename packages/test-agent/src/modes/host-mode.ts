/**
 * Host mode — 本地 stdio 执行模式（desktop app 用）。
 *
 * Desktop app 通过子进程启动 host-cli，用 JSON lines stdio 协议通信：
 * handshake → run → (event*) → run-result / run-error → cancel
 *
 * 与旧 local-host/host.ts 的区别：不再走 test-kernel pipeline（runTestWorkflow），
 * 直接调 adapter.run()。agent-core agentLoop 在 adapter 内部处理多轮工具调用 +
 * 自修复，取代了 test-kernel 的 feedback 循环 + quality gate + plugins + executors。
 */

import { createInterface } from "node:readline";
import { createHostAgentAdapter } from "../core/factory.js";
import type { AgentAdapter, AgentEvent, AgentRunContext, AgentRunResult } from "../core/types.js";
import { log } from "../core/types.js";
import { EscalationHandler, type EscalationEvent } from "../core/escalation-handler.js";
import { authorizeProjectPath, parseAllowedProjectRoots } from "../core/security.js";
import { configuredCapabilities } from './capabilities.js'
import { inspectProjectSupport } from '../core/project-support.js'
import {
  EXECUTION_ID_PATTERN,
  LOCAL_HOST_PROTOCOL_VERSION,
  type ClientMessage,
  type HostMessage,
  type TaskInput,
} from "@cxmt/protocol";

export const LOCAL_HOST_VERSION = "0.1.0";

export interface LocalAgentHostOptions {
  capabilities: readonly string[];
  allowedProjectRoots: readonly string[];
  createProvider?: () => AgentAdapter | null;
  preferAi?: boolean;
}

interface ActiveRun {
  controller: AbortController;
  provider: AgentAdapter;
  resolvedPath: string;
}

type Send = (message: HostMessage) => void | Promise<void>;

/** Local endpoint execution host. Owns agent execution, not a shared queue. */
export class LocalAgentHost {
  private readonly active = new Map<string, ActiveRun>();
  private readonly protocolVersion = LOCAL_HOST_PROTOCOL_VERSION;
  /** Escalation handler per executionId（host-mode 有人盯，GUI 答复经 replyEscalation 回调）。 */
  private readonly escalationHandlers = new Map<string, EscalationHandler>();

  constructor(private readonly options: LocalAgentHostOptions) {}

  /** GUI 答复 escalation：经 IPC 调此方法 → handler.reply。 */
  replyEscalation(executionId: string, escalationId: string, answer: string): boolean {
    const handler = this.escalationHandlers.get(executionId);
    if (!handler) return false;
    const role = handler.getPendingRole(escalationId);
    if (!role) return false; // pending 不存在（已超时/不存在），告知 GUI 未送达
    // 片C steer 控制：仅当角色配 escalationSteer: true（handler.isSteerEnabled）时传 agent
    const agent = handler.isSteerEnabled(role) ? handler.getAgent(role) : undefined;
    return handler.reply(escalationId, answer, agent);
  }

  dismissEscalation(executionId: string, escalationId: string): boolean {
    return this.escalationHandlers.get(executionId)?.dismiss(escalationId) ?? false;
  }

  async handle(message: ClientMessage, send: Send): Promise<void> {
    switch (message.kind) {
      case "handshake": {
        if (message.protocolVersion !== this.protocolVersion) {
          await send({
            id: message.id,
            kind: "handshake",
            ok: false,
            protocolVersion: this.protocolVersion,
            error: `protocol version mismatch: ${message.protocolVersion}`,
          });
          return;
        }
        await send({
          id: message.id,
          kind: "handshake",
          ok: true,
          protocolVersion: this.protocolVersion,
          hostVersion: LOCAL_HOST_VERSION,
          capabilities: [...this.options.capabilities],
        });
        return;
      }
      case "health": {
        await send({ id: message.id, kind: "health", ok: true, activeRuns: this.active.size });
        return;
      }
      case "run": {
        if (!EXECUTION_ID_PATTERN.test(message.executionId)) {
          await send({ id: message.id, kind: "error", message: `invalid executionId: ${message.executionId}` });
          return;
        }
        if (this.active.has(message.executionId)) {
          await send({ id: message.id, kind: "error", message: `execution already active: ${message.executionId}` });
          return;
        }
        const missingCapabilities = (message.input.requiredCapabilities ?? []).filter((capability) => !this.options.capabilities.includes(capability));
        if (missingCapabilities.length > 0) {
          await send({ id: message.id, kind: "error", message: `本机缺少任务所需工具链：${missingCapabilities.join(', ')}` });
          return;
        }
        if (Array.isArray(message.input.cases) && message.input.cases.length === 0) {
          await send({ id: message.id, kind: "error", message: "没有可执行用例，请返回计划页调整范围后再执行" });
          return;
        }
        if (Array.isArray(message.input.cases)) {
          const seenIds = new Set<string>();
          const invalidIndex = message.input.cases.findIndex((raw) => {
            if (!raw || typeof raw !== "object") return true;
            const item = raw as Record<string, unknown>;
            const id = typeof item.id === "string" ? item.id.trim() : "";
            const invalid = !id || seenIds.has(id) || ![item.title, item.scenario, item.expected].every((value) => typeof value === "string" && value.trim());
            seenIds.add(id);
            return invalid;
          });
          if (invalidIndex >= 0) {
            await send({ id: message.id, kind: "error", message: `确认计划的第 ${invalidIndex + 1} 条用例缺少编号、名称、场景或预期，或编号重复；未启动测试` });
            return;
          }
        }
        const authorization = authorizeProjectPath(message.input.projectPath, this.options.allowedProjectRoots);
        if (!authorization.ok || !authorization.resolvedPath) {
          await send({ id: message.id, kind: "error", message: authorization.reason ?? "Project path authorization failed" });
          return;
        }
        const support = inspectProjectSupport(authorization.resolvedPath);
        if (!support.supported && support.kind !== 'unknown') {
          await send({ id: message.id, kind: "error", message: support.reason ?? `Unsupported project kind: ${support.kind}` });
          return;
        }
        const provider = this.options.createProvider
          ? this.options.createProvider()
          : createHostAgentAdapter(message.input.projectPath, this.options.preferAi ?? true);
        if (!provider) {
          await send({ id: message.id, kind: "error", message: "No executable Agent Provider is configured" });
          return;
        }
        const controller = new AbortController();
        this.active.set(message.executionId, { controller, provider, resolvedPath: authorization.resolvedPath });
        await send({ id: message.id, kind: "run-accepted", executionId: message.executionId });
        void this.runSession(message, send, controller);
        return;
      }
      case "escalation-reply": {
        const ok = this.replyEscalation(message.executionId, message.escalationId, message.answer);
        if (!ok) {
          await send({ id: message.id, kind: "error", message: `escalation reply failed: execution ${message.executionId} not found` });
        }
        return;
      }
      case "escalation-dismiss": {
        if (this.dismissEscalation(message.executionId, message.escalationId)) {
          await send({ id: message.id, kind: "escalation-dismissed", executionId: message.executionId, escalationId: message.escalationId });
        } else {
          await send({ id: message.id, kind: "error", message: `escalation 已结束或不存在：${message.escalationId}` });
        }
        return;
      }
      case "cancel": {
        const run = this.active.get(message.executionId);
        if (!run) {
          await send({ id: message.id, kind: "error", message: `unknown execution: ${message.executionId}` });
          return;
        }
        run.controller.abort();
        await send({ id: message.id, kind: "cancelled", executionId: message.executionId });
        return;
      }
      default: {
        const unknown = message as unknown as { id?: string };
        await send({ id: unknown.id ?? "", kind: "error", message: "unknown message kind" });
      }
    }
  }

  private async runSession(
    message: Extract<ClientMessage, { kind: "run" }>,
    send: Send,
    controller: AbortController,
  ): Promise<void> {
    const active = this.active.get(message.executionId);
    if (!active) return;
    try {
      const emit = async (event: AgentEvent) => {
        await send({ id: message.id, kind: "event", executionId: message.executionId, event });
      };

      const input = message.input;
      const inputCases = (input as { cases?: unknown[] }).cases;

      // 构造 EscalationHandler（host-mode 有人盯，notifyFn 转 GUI；片C：审计日志 projectPath）
      const escalationHandler = new EscalationHandler(
        (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
        (e: EscalationEvent) => { void emit({ type: "escalation", ...e }); },
        null, undefined,
        { projectPath: input.projectPath },
      );
      this.escalationHandlers.set(message.executionId, escalationHandler);

      const escalationContext: AgentRunContext = { escalationHandler, taskId: message.executionId, coordinatorEnabled: true };

      // --- 修复阶段（GUI 用户确认后发，input.diagnosis 传回）---
      if (input.diagnosis && active.provider.runFix) {
        const result = await active.provider.runFix(input, emit, controller.signal, escalationContext);
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "fix" });
        return;
      }

      // --- 侦察阶段（无 input.cases + 无 input.scoutReport + provider 有 runScout）---
      if (!inputCases && !input.scoutReport && active.provider.runScout) {
        const result = await active.provider.runScout(input, emit, controller.signal, escalationContext);
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "scout" });
        return;
      }

      // --- 用例设计阶段（有 input.scoutReport + provider 有 runCaseDesign → 替代旧 runPlan）---
      if (input.scoutReport && active.provider.runCaseDesign) {
        const result = await active.provider.runCaseDesign(input, input.scoutReport, emit, controller.signal, escalationContext);
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "plan" });
        return;
      }

      // --- 旧计划阶段（无 scoutReport + 无 runCaseDesign → 降级旧 runPlan，向后兼容）---

      // --- 测试代码生成阶段（确认后的 JUnit 用例先生成并通过编译门禁）---
      const needsJUnitGeneration = input.testStrategy !== "reflect" && input.testTypes.every((type) => type === "unit" || type === "regression");
      if (inputCases && needsJUnitGeneration && !input.testCodeGenerated && active.provider.runGenerate) {
        const result = await active.provider.runGenerate(
          input,
          inputCases as never,
          emit,
          controller.signal,
          escalationContext,
        );
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "generate" });
        return;
      }

      // --- 执行阶段（测试代码已生成，input.cases 存在 → runExecute）---
      if (inputCases && active.provider.runExecute) {
        const result = await active.provider.runExecute(
          input,
          inputCases as never,
          emit,
          controller.signal,
          escalationContext,
        ) as AgentRunResult;

        // 诊断先行架构：按 fixDecision 分流
        if (result.fixDecision && active.provider.runFix) {
          if (result.fixDecision.action === "auto-fix") {
            // 桌面试点默认不自动修改被测项目：即使诊断置信度高，也必须由人明确批准修复。
            const reviewResult: AgentRunResult = {
              ...result,
              fixDecision: { action: "needs-confirm", reason: `诊断建议可修复；修改项目代码前仍需人工确认。${result.fixDecision.reason}` },
            };
            await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: reviewResult, phase: "diagnosis" });
            return;
          } else if (result.fixDecision.action === "needs-confirm") {
            // 停下问：发诊断结果给 GUI，等用户确认
            await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "diagnosis" });
            return;
          } else {
            // no-fix（environment/flaky）：不修代码，发 execute 结果
            await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "execute" });
            return;
          }
        }

        // 无 fixDecision（全过，或旧 adapter 无 runFix）——正常发 execute 结果
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "execute" });
        return;
      }

      // --- 计划阶段（无 input.cases，有 runPlan）---
      if (!inputCases && active.provider.runPlan) {
        const result = await active.provider.runPlan(input, emit, controller.signal);
        await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result, phase: "plan" });
        return;
      }

      // --- 旧 adapter（cimicode 等，无 runPlan/runExecute/runFix）一次性 run ---
      const result = await active.provider.run(input, emit, controller.signal, escalationContext);
      await send({ id: message.id, kind: "run-result", executionId: message.executionId, outcome: result });
    } catch (error) {
      await send({
        id: message.id,
        kind: "run-error",
        executionId: message.executionId,
        error: error instanceof Error ? error.message : String(error),
        cancelled: controller.signal.aborted,
      });
    } finally {
      this.active.delete(message.executionId);
      this.escalationHandlers.delete(message.executionId);
    }
  }
}

export function runStdioHost(options: LocalAgentHostOptions): void {
  const host = new LocalAgentHost(options);
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const write = (message: HostMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    void (async () => {
      let message: ClientMessage;
      try {
        message = JSON.parse(line) as ClientMessage;
      } catch {
        write({ id: "", kind: "error", message: "invalid JSON" });
        return;
      }
      await host.handle(message, write);
    })().catch((error) => {
      write({ id: "", kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
  });
}

export function parseLocalHostOptions(env: NodeJS.ProcessEnv = process.env): LocalAgentHostOptions {
  const capabilities = configuredCapabilities(env.TEST_AGENT_HOST_CAPABILITIES);
  return {
    capabilities,
    allowedProjectRoots: parseAllowedProjectRoots(env.TEST_AGENT_ALLOWED_PROJECT_ROOTS),
    preferAi: (env.TEST_AGENT_AI_MODE ?? "true").toLowerCase() !== "false",
  };
}

/** CLI 入口 — 直接 node 执行。 */
export function runHostCli(): void {
  runStdioHost(parseLocalHostOptions());
}
