/**
 * EscalationHandler — escalation 通道核心机制（片A，纯函数+Promise，不接线 runner）。
 *
 * 照抄 pi-intercom ask/reply 阻塞+超时降级语义 + pi-messenger deliverFn/限流思想，
 * 塌缩为同进程 Promise + setTimeout（不需要 broker/socket/文件 inbox）。
 *
 * 逐条映射见技术方案 §3 照抄映射表。
 */

import { randomUUID } from "node:crypto";
import type { Agent } from "@cxmt/agent-core";
import { appendEscalationAudit, type EscalationAuditEntry } from "./escalation-audit.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 照抄 config.ts:4 默认值（改 5 分钟）

/**
 * 读 TEST_AGENT_ESCALATION_TIMEOUT_MS 环境变量（照抄 config.ts:6-15 getAskTimeoutMs）。
 *
 * 未设 → 默认 5 分钟；设有效正整数 → 用 env；设非法值 → 抛错。
 */
export function getEscalationTimeoutMs(): number {
  const raw = process.env.TEST_AGENT_ESCALATION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("TEST_AGENT_ESCALATION_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

/** 照抄 reply-tracker.ts:20-23 IntercomContext：待答 ask 的注册条目。 */
interface PendingAsk {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  createdAt: number;
  role: string;
  question: string;
  fallback?: string;
}

/** escalation 事件，通过 notifyFn 转发给 host-mode GUI 或外部监听者。 */
export interface EscalationEvent {
  escalationId: string;
  role: string;
  question: string;
  fallback?: string;
  context?: string;
}

/** ask 输入参数。 */
export interface EscalationAskInput {
  role: string;
  question: string;
  fallback?: string;
  context?: string;
}

/** EscalationHandler 可选配置（片C：审计日志 + 突变检测）。 */
export interface EscalationHandlerOptions {
  /** 项目路径（审计日志写入 .test-agent/escalations/<projectHash>/）。不设 → 不写审计。 */
  projectPath?: string;
  /** 项目 hash（预计算时传入，否则从 projectPath 计算）。 */
  projectHash?: string;
  /** 突变检测窗口（毫秒，默认 60000 = 1 分钟）。 */
  burstWindowMs?: number;
  /** 突变检测阈值（窗口内 ask 次数超此值 → 告警，默认 3）。 */
  burstThreshold?: number;
}

/**
 * EscalationHandler — 管理 escalation 的 pending 注册表 + 限流 + 超时降级。
 *
 * 核心阻塞靠 Promise（§7 不确定点 5）：`ask()` 返回的 Promise 由 `reply()` resolve，
 * 工具 execute await 后立即拿到答复返回——不依赖 deliverFn/steer。
 * deliverFn 保留接口（默认 agent.steer），仅用于答复后给角色 Agent 补充上下文的可选增强。
 */
export class EscalationHandler {
  private readonly pendingAsks = new Map<string, PendingAsk>(); // 照抄 reply-tracker.ts:43
  private readonly escalationCountByRole = new Map<string, number>(); // 照抄 handlers.ts:394
  private readonly timeoutMs: number | null;
  private readonly budget: number;
  /** 片C：审计日志配置。projectPath 未设 → 不写审计。 */
  private readonly projectPath?: string;
  private readonly projectHash?: string;
  /** 片C：突变检测配置（同角色短时高频 escalate → 告警）。 */
  private readonly burstWindowMs: number;
  private readonly burstThreshold: number;
  /** 片C：每角色 ask 时间戳列表（突变检测用）。 */
  private readonly askTimestampsByRole = new Map<string, number[]>();
  /** 片C：steer 开启的角色集合（escalationSteer: true 时 runner 调 setSteerEnabled）。 */
  private readonly steerEnabledRoles = new Set<string>();
  /** escalation 记录历史（独立于审计落盘，供 AgentRunResult.report.escalations 收集）。即使 projectPath 未设（不落盘）也存内存。 */
  private readonly records: EscalationAuditEntry[] = [];

  constructor(
    /** 照抄 store.ts:57 deliverFn，默认 agent.steer（§7 不确定点 5：保留接口，核心不依赖）。 */
    private readonly deliverFn: (msg: string, agent: Agent) => void = (m, a) =>
      a.steer({ role: "user", content: m, timestamp: Date.now() }),
    /** host-mode 转 GUI；worker-mode 留空（仅超时降级）。 */
    private readonly notifyFn?: (e: EscalationEvent) => void,
    /** null 表示交互式 Host：一直等待用户明确回答、跳过或取消任务。 */
    timeoutMs: number | null = getEscalationTimeoutMs(),
    /** 照抄 handlers.ts:393 messageBudgets，默认 5/角色/任务。 */
    budget: number = 5,
    /** 片C：审计日志 + 突变检测可选配置。 */
    options?: EscalationHandlerOptions,
  ) {
    this.timeoutMs = timeoutMs;
    this.budget = budget;
    this.projectPath = options?.projectPath;
    this.projectHash = options?.projectHash;
    this.burstWindowMs = options?.burstWindowMs ?? 60_000;
    this.burstThreshold = options?.burstThreshold ?? 3;
  }

  /**
   * 发起 escalation：限流检查 → new Promise + setTimeout reject → notifyFn 转发。
   *
   * 照抄 index.ts:606-630 waitForReply + handlers.ts:393-398 限流。
   */
  ask(input: EscalationAskInput): Promise<string> {
    // 限流（照抄 handlers.ts:393-398）
    const used = this.escalationCountByRole.get(input.role) ?? 0;
    if (used >= this.budget) {
      // 片C：审计日志（预算耗尽 = 降级）
      this.writeAudit({
        timestamp: new Date().toISOString(),
        escalationId: randomUUID(),
        role: input.role,
        question: input.question,
        fallback: input.fallback,
        resolved: false,
        degraded: true,
      });
      return Promise.resolve(
        `[escalation 预算耗尽（${used}/${this.budget}），请自行决策。建议：${input.fallback ?? "保守方案"}][需人工复核]`,
      );
    }
    this.escalationCountByRole.set(input.role, used + 1);

    // 片C：突变检测——记录 ask 时间戳，检查窗口内频率
    const burstWarning = this.checkBurst(input.role);

    // 照抄 index.ts:606-630 waitForReply：Promise + setTimeout reject
    return new Promise<string>((resolve, reject) => {
      const escalationId = randomUUID();
      const createdAt = Date.now();

      // 片C：审计日志（ask 发起）
      this.writeAudit({
        timestamp: new Date(createdAt).toISOString(),
        escalationId,
        role: input.role,
        question: input.question,
        fallback: input.fallback,
        resolved: false,
        degraded: false,
        ...(burstWarning ? { burstWarning } : {}),
      });

      const timeout = this.timeoutMs === null ? undefined : setTimeout(() => {
        // 照抄 index.ts:610-616 超时 reject
        this.pendingAsks.delete(escalationId);
        // 片C：审计日志（超时降级）
        this.writeAudit({
          timestamp: new Date().toISOString(),
          escalationId,
          role: input.role,
          question: input.question,
          fallback: input.fallback,
          resolved: false,
          degraded: true,
          durationMs: Date.now() - createdAt,
        });
        reject(new Error(`escalation 超时（${this.timeoutMs}ms 无答复）`));
      }, this.timeoutMs);

      this.pendingAsks.set(escalationId, {
        resolve: (answer) => {
          if (timeout) clearTimeout(timeout);
          this.pendingAsks.delete(escalationId);
          // 片C：审计日志（resolved）
          this.writeAudit({
            timestamp: new Date().toISOString(),
            escalationId,
            role: input.role,
            question: input.question,
            fallback: input.fallback,
            resolved: true,
            degraded: false,
            answer,
            durationMs: Date.now() - createdAt,
          });
          resolve(answer);
        },
        reject: (err) => {
          if (timeout) clearTimeout(timeout);
          this.pendingAsks.delete(escalationId);
          reject(err);
        },
        createdAt,
        role: input.role,
        question: input.question,
        fallback: input.fallback,
      });

      // 通知（host-mode 转 GUI；worker-mode notifyFn 留空，仅等超时）
      this.notifyFn?.({ escalationId, ...input });
    });
  }

  /**
   * 答复 escalation（照抄 reply-tracker.ts:104-115 markReplied）。
   *
   * resolve pending Promise + 清除 timeout。可选 deliverFn 注入回角色 Agent。
   *
   * 片C steer 控制：reply 本身始终在 roleAgent 传入时调 deliverFn（向后兼容片A 测试）。
   * steer 默认关闭在 **接线层**（host-mode replyEscalation 检查 isSteerEnabled 后再传 agent）。
   */
  reply(escalationId: string, answer: string, roleAgent?: Agent): boolean {
    const pending = this.pendingAsks.get(escalationId);
    if (!pending) return false; // 已超时或不存在，告知调用方未送达
    pending.resolve(answer); // resolve 内写审计日志（resolved=true）
    // deliverFn 思想（照抄 store.ts:987 deliverFn(msg)）：答复注入回角色 Agent（可选增强）
    if (roleAgent) this.deliverFn(answer, roleAgent);
    return true;
  }

  /** 用户主动跳过：立即走与超时相同的保守降级，不再等待计时器。 */
  dismiss(escalationId: string): boolean {
    const pending = this.pendingAsks.get(escalationId);
    if (!pending) return false;
    this.writeAudit({
      timestamp: new Date().toISOString(),
      escalationId,
      role: pending.role,
      question: pending.question,
      fallback: pending.fallback,
      resolved: false,
      degraded: true,
      durationMs: Date.now() - pending.createdAt,
    });
    pending.reject(new Error("用户跳过 escalation，立即按保守方案降级"));
    return true;
  }

  /**
   * 惰性清理超时项（照抄 reply-tracker.ts:140-147 pruneExpired）。
   *
   * 对已超时但 setTimeout 尚未触发的条目主动 reject + 删除。
   */
  pruneExpired(now: number = Date.now()): void {
    if (this.timeoutMs === null) return;
    for (const [id, p] of this.pendingAsks) {
      if (now - p.createdAt > this.timeoutMs) {
        p.reject(new Error("escalation 超时"));
        this.pendingAsks.delete(id);
      }
    }
  }

  /** 当前 pending 数量（测试/调试用）。 */
  get pendingCount(): number {
    return this.pendingAsks.size;
  }

  /** 指定角色的 escalation 计数（测试/调试用）。 */
  escalationCount(role: string): number {
    return this.escalationCountByRole.get(role) ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Agent 注册表（供 reply 时按 role 取 agent steer；§7 不确定点 5）
  // ---------------------------------------------------------------------------

  /** 角色 → Agent 实例映射，供 reply 时按 role 取 agent 做 deliverFn/steer。 */
  private readonly roleAgents = new Map<string, Agent>();

  /** 注册角色 Agent（runner 构造 Agent 后调用，供 reply 时 steer）。 */
  registerAgent(role: string, agent: Agent): void {
    this.roleAgents.set(role, agent);
  }

  /** 取角色 Agent（reply 时用）。 */
  getAgent(role: string): Agent | undefined {
    return this.roleAgents.get(role);
  }

  // ---------------------------------------------------------------------------
  // 片C：steer 配置（接线层控制，默认关闭）
  // ---------------------------------------------------------------------------

  /** 设置角色是否开启 steer（runner 从 role.escalationSteer 读取后调用）。 */
  setSteerEnabled(role: string, enabled: boolean): void {
    if (enabled) this.steerEnabledRoles.add(role);
    else this.steerEnabledRoles.delete(role);
  }

  /** 查询角色是否开启 steer（host-mode replyEscalation 调用，决定是否传 agent）。 */
  isSteerEnabled(role: string): boolean {
    return this.steerEnabledRoles.has(role);
  }

  // ---------------------------------------------------------------------------
  // 片C：pending role 查询（供 host-mode replyEscalation 取 role）
  // ---------------------------------------------------------------------------

  /** 获取 pending escalation 的 role（reply 前调，取 role 后查 isSteerEnabled + getAgent）。 */
  getPendingRole(escalationId: string): string | undefined {
    return this.pendingAsks.get(escalationId)?.role;
  }

  // ---------------------------------------------------------------------------
  // 片C：审计日志 + 突变检测
  // ---------------------------------------------------------------------------

  /**
   * 突变检测——同角色短时高频 escalate → 返回告警文本。
   *
   * 在 burstWindowMs 窗口内 ask 次数超 burstThreshold → 返回告警，否则返回 undefined。
   */
  private checkBurst(role: string): string | undefined {
    const now = Date.now();
    const timestamps = this.askTimestampsByRole.get(role) ?? [];
    // 清理窗口外的时间戳
    const recent = timestamps.filter((t) => now - t < this.burstWindowMs);
    recent.push(now);
    this.askTimestampsByRole.set(role, recent);
    if (recent.length > this.burstThreshold) {
      return `角色可能卡在不确定区，建议人工介入（${this.burstWindowMs}ms 内 ${recent.length} 次 escalation）`;
    }
    return undefined;
  }

  /** 写审计日志（projectPath 未设 → 不落盘，但仍存内存 records）。 */
  private writeAudit(entry: EscalationAuditEntry): void {
    this.records.push(entry);
    if (!this.projectPath) return;
    appendEscalationAudit(this.projectPath, entry, this.projectHash);
  }

  /** 取本任务所有 escalation 记录（供 runner/orchestrator/fix-orchestrator 填 AgentRunResult.report.escalations）。 */
  getRecords(): readonly EscalationAuditEntry[] {
    return this.records;
  }
}
