/**
 * Coordinator — planner + 多专业 worker 调度层（规则引擎 planner）。
 *
 * 照抄 pi-intercom send/ask/reply/超时降级 拓扑 + 现有 runner.run() 顺序调度规则。
 * worker→ask planner 复用 EscalationHandler（已照 pi-intercom waitForReply）。
 *
 * 向后兼容：coordinatorEnabled=false（默认）用现有 runner.run() 顺序流水线，true 用 Coordinator。
 */

import type { TaskInput, TestType } from "@cxmt/protocol";
import type { AgentAdapter, AgentEvent, AgentLaneResult, AgentRunContext, AgentRunResult, TestCase } from "./types.js";
import { EscalationHandler } from "./escalation-handler.js";
import { log } from "./types.js";
import { evaluateQualityGate, finalizeQualityGate } from "./quality-gate.js";
import { enrichFailedCasesWithSurefire } from "./validator.js";

/** Worker 角色（5 顶层 worker，照现有五角色）。 */
export type WorkerRole = "scout" | "case-designer" | "tester" | "result-reviewer" | "fixer";

/** Worker 完成报告（照 pi-intercom ask 报完成）。 */
export interface WorkerReport {
  workerRole: WorkerRole;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Coordinator 调度消息（dispatch/report/ask/reply 的真实记录，照 pi-intercom ReplyTracker.pendingAsks 记录模式）。
 *
 * 存于 dispatchLog，供 GUI 读或通过 emitMessage 实时推。
 * 切片 6A+6B 只记录到 dispatchLog + emit log 事件；切片 6C 加 protocol coordinator-message 事件 + GUI dispatchMessages 从真实记录读。
 */
export interface CoordinatorMessage {
  id: string;
  type: 'dispatch' | 'report' | 'ask' | 'reply';
  from: string;  // 'planner' | workerRole
  to: string;    // workerRole | 'planner'
  content: string;
  timestamp: number;
}

/** Coordinator 调度决策（规则引擎，照现有 runner.run() 顺序）。 */
export interface CoordinatorOptions {
  /** 启用 Coordinator 调度（默认 false，用现有顺序流水线）。 */
  coordinatorEnabled?: boolean;
}

/**
 * Coordinator — 规则引擎 planner，dispatch worker + 收 report + 调度决策。
 *
 * 照 pi-intercom：
 * - dispatch = send（fire-and-forget，index.ts:1130）
 * - worker ask planner = EscalationHandler.ask（已照 waitForReply）
 * - worker reportDone = ask planner 报完成（index.ts ask action）
 * - 超时降级 = EscalationHandler setTimeout reject（已照 config.ts getAskTimeoutMs）
 */
export class Coordinator {
  /** pending worker 报告（照 pi-intercom ReplyTracker.pendingAsks）。 */
  private readonly pendingReports = new Map<string, { resolve: (r: WorkerReport) => void; reject: (e: Error) => void }>();
  /** worker→planner ask handler（复用 EscalationHandler）。 */
  private readonly escalationHandler: EscalationHandler;
  /** 调度消息日志（照 pi-intercom ReplyTracker.pendingAsks 记录模式）。 */
  private readonly dispatchLog: CoordinatorMessage[] = [];
  /** 消息转发回调（构造函数可选参数，用于转发消息到 GUI/log 流）。 */
  private readonly emitMessage?: (msg: CoordinatorMessage) => void;

  constructor(
    private readonly adapter: AgentAdapter,
    escalationHandler?: EscalationHandler,
    emitMessage?: (msg: CoordinatorMessage) => void,
  ) {
    // 复用传入的 escalationHandler（runner 已构造），或新建（照 EscalationHandler 默认配置）
    this.escalationHandler = escalationHandler ?? new EscalationHandler();
    this.emitMessage = emitMessage;
  }

  /** 返回 dispatchLog 供 GUI 读（照 pi-intercom ReplyTracker.pendingAsks 记录模式）。 */
  getMessages(): CoordinatorMessage[] {
    return [...this.dispatchLog];
  }

  /** 推消息到 dispatchLog + emitMessage + 限长防无限增长（照 bug #11 history 上限模式）。 */
  private pushMessage(msg: CoordinatorMessage): void {
    this.dispatchLog.push(msg);
    if (this.dispatchLog.length > 100) this.dispatchLog.shift();
    this.emitMessage?.(msg);
  }

  /**
   * dispatch worker（fire-and-forget，照 pi-intercom send index.ts:1130）。
   *
   * 不阻塞等 worker 完成——worker 完成后调 reportDone 通知。
   *
   * dispatch 真记录+emit，照 pi-intercom send：记录到 dispatchLog + emitMessage 回调转发。
   * 实际 worker 执行仍由 run() 串行 await 编排（dispatch 是语义标记，照 pi-intercom send 不阻塞）。
   * 切片 2 并行 fan-out 时才启用 waitForReport 让 dispatch 真正异步启动 worker + waitForReport 等完成。照 pi-subagents SKILL runs.all 模式。
   */
  dispatch(workerRole: WorkerRole, task: unknown): string {
    const dispatchId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg: CoordinatorMessage = {
      id: dispatchId,
      type: 'dispatch',
      from: 'planner',
      to: workerRole,
      content: `派 ${workerRole} 执行`,
      timestamp: Date.now(),
    };
    this.pushMessage(msg);
    // fire-and-forget：记录 pending，worker 异步执行后 reportDone resolve
    // 实际 worker 执行由 run() 编排（dispatch 是语义标记，照 pi-intercom send 不阻塞）
    void task; // 语义标记，实际 task 由 run() 传给 adapter
    return dispatchId;
  }

  /**
   * worker 报告完成（照 pi-intercom ask 报完成，planner waitForReply）。
   *
   * 真记录+emit：记录到 dispatchLog + emitMessage 回调转发，再 resolve pendingReport。
   */
  reportDone(dispatchId: string, report: WorkerReport): void {
    const msg: CoordinatorMessage = {
      id: `report-${dispatchId}`,
      type: 'report',
      from: report.workerRole,
      to: 'planner',
      content: `${report.workerRole} 完成: ${report.success ? '成功' : '失败'}`,
      timestamp: Date.now(),
    };
    this.pushMessage(msg);
    const pending = this.pendingReports.get(dispatchId);
    if (pending) {
      this.pendingReports.delete(dispatchId);
      pending.resolve(report);
    }
  }

  /**
   * 等待 worker 报告（照 pi-intercom waitForReply index.ts:670，Promise + 超时）。
   */
  waitForReport(dispatchId: string, timeoutMs = 10 * 60 * 1000): Promise<WorkerReport> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReports.delete(dispatchId);
        reject(new Error(`worker ${dispatchId} 超时未报告（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pendingReports.set(dispatchId, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
    });
  }

  /**
   * worker ask planner（复用 EscalationHandler.ask，已照 pi-intercom waitForReply）。
   *
   * 真记录+emit：记录到 dispatchLog + emitMessage 回调转发，再委托 escalationHandler.ask。
   */
  askPlanner(input: { role: string; question: string; fallback?: string; context?: string }): Promise<string> {
    const msg: CoordinatorMessage = {
      id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'ask',
      from: input.role,
      to: 'planner',
      content: input.question,
      timestamp: Date.now(),
    };
    this.pushMessage(msg);
    return this.escalationHandler.ask(input);
  }

  /**
   * planner reply worker（复用 EscalationHandler.reply，已照 reply-tracker.ts:132 markReplied）。
   *
   * 真记录+emit：记录到 dispatchLog + emitMessage 回调转发，再委托 escalationHandler.reply。
   */
  replyToWorker(escalationId: string, answer: string): boolean {
    const msg: CoordinatorMessage = {
      id: `reply-${escalationId}`,
      type: 'reply',
      from: 'planner',
      to: 'worker',
      content: answer,
      timestamp: Date.now(),
    };
    this.pushMessage(msg);
    return this.escalationHandler.reply(escalationId, answer);
  }

  /**
   * run — Coordinator 调度主流程（规则引擎，照现有 runner.run() 顺序 runner.ts:574-590）。
   *
   * scout → case-designer → tester（runExecute）→ [diagnose → fix 在 runExecute 内]
   * 向后兼容：现有 runner.run() 顺序抽到此处，dispatch/receiveReport 协议包装。
   */
  async run(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    // 调度规则照现有 runner.ts:574-590
    // 1. 用例库命中检查（照 runner.ts:576 checkLibraryReuse）
    // 2. dispatch scout → 等 reportDone → dispatch case-designer（带 scoutReport）→ 等 reportDone
    // 3. dispatch tester（runExecute，带 cases）→ 等 reportDone
    // 4. 返回 AgentRunResult

    // 实现照现有 runner.run() 顺序，用 dispatch/waitForReport 包装（语义清晰，实际仍串行 await）
    // 注意：首期不并行（tester 内部 fan-out 是切片 2），顶层 worker 串行

    const reused = (this.adapter as unknown as { checkLibraryReuse?: (i: TaskInput, e: (ev: AgentEvent) => void) => TestCase[] | undefined }).checkLibraryReuse?.(input, emit);
    if (reused && reused.length > 0) {
      emit(log("info", "[Coordinator] 用例库命中，跳过 scout + designer", "COORDINATING"));
      return this.adapter.run(input, emit, signal, context);
    }

    // dispatch scout
    // 串行下 reportDone 立即返回，waitForReport 为并行预留不强加 await（reviewer 调整）。
    // 切片 2 并行 fan-out 时才用 waitForReport 让 dispatch 真正异步启动 worker + 等完成。
    emit(log("info", "[Coordinator] dispatch scout", "COORDINATING"));
    const scoutDispatchId = this.dispatch("scout", input);
    const scoutResult = await this.adapter.runScout?.(input, emit, signal, context);
    this.reportDone(scoutDispatchId, { workerRole: "scout", success: Boolean(scoutResult), result: scoutResult });

    // dispatch case-designer（带 scoutReport）
    if (!scoutResult || !scoutResult.report) throw new Error("scout 未产出侦察报告");
    emit(log("info", "[Coordinator] dispatch case-designer", "COORDINATING"));
    const designDispatchId = this.dispatch("case-designer", input);
    const planResult = await this.adapter.runCaseDesign?.(input, scoutResult.report, emit, signal, context);
    this.reportDone(designDispatchId, { workerRole: "case-designer", success: Boolean(planResult), result: planResult });

    if (!planResult || planResult.cases.length === 0) {
      throw new Error("用例设计未产出任何测试用例，无法继续执行。");
    }

    // dispatch tester（runExecute，内含 diagnose→fix）
    //
    // 多 testTypes 并行 fan-out（照 pi-subagents runs.all fanout，SKILL.md:35/42）：
    //   每个 testType 一个子代理（fresh context，独立 Agent 实例），Promise.all 并行执行。
    //   照 pi-subagents context:"fresh"（SKILL.md:97）：每个子代理独立 Agent，不共享上下文。
    //   tester 聚合子代理结果（照 pi-subagents parent synthesize，SKILL.md:97）。
    //
    // 单 testTypes 向后兼容：走现有 runExecute（单 Agent 跑全部）。
    emit(log("info", "[Coordinator] dispatch tester", "COORDINATING"));
    const testDispatchId = this.dispatch("tester", planResult.cases);

    let result: AgentRunResult;
    if (input.testTypes && input.testTypes.length > 1) {
      if (input.testTypes.includes("regression")) {
        // regression 是全回归跑全部 cases，其他 testTypes 冗余——含 regression 时只跑 regression 子代理不 fan-out
        emit(log("info", `[Coordinator] tester 含 regression，跑全回归子代理（不 fan-out 其他 testTypes）`, "COORDINATING"));
        result = await this.runTesterSubAgent(input, planResult.cases, "regression", emit, signal, context);
      } else {
        // 非 regression 多 testTypes 并行 fan-out
        emit(log("info", `[Coordinator] tester 内部 fan-out：${input.testTypes.length} 子代理并行（${input.testTypes.join(",")}）`, "COORDINATING"));
        // 照 pi-subagents runs.all fanout：每个 testType 一个子代理，fresh context（独立 Agent 实例）
        // 注意：fan-out 子代理共享同一 emit，agent 事件交错发送（都用 role="tester"，GUI 不区分子代理）。后续可加 subAgentId 字段区分。
        // coverage 均值是首期聚合策略（不同 testType coverage 语义不同，简单平均不代表整体）。
        const subResults = await Promise.all(
          input.testTypes.map((testType) =>
            this.runTesterSubAgent(input, planResult.cases, testType, emit, signal, context),
          ),
        );
        // tester 聚合子代理结果（照 pi-subagents parent synthesize and apply fixes in the parent，SKILL.md:97）
        result = this.aggregateTesterResults(subResults, input);
      }
      emit(log("success", `[Coordinator] tester fan-out 完成：${result.report.passed} 通过，${result.report.failed} 失败`, "COORDINATING"));
    } else {
      // 单 testTypes 向后兼容：走现有 runExecute（单 Agent 跑全部）
      result = await this.adapter.runExecute?.(input, planResult.cases, emit, signal, context) ?? { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] };
    }
    this.reportDone(testDispatchId, { workerRole: "tester", success: Boolean(result), result });

    return result;
  }

  /**
   * runTesterSubAgent — 为单个 testType 构造子 Agent（fresh context，独立 outputDirectory stamp）。
   *
   * 照 pi-subagents runs.all fanout（SKILL.md:35 `runs.all([...]) for fanout`）：
   * - fresh context：每次调用 runExecute 创建独立 Agent 实例，不共享上下文（SKILL.md:97 fresh-context fanout）
   * - 独立 outputDirectory：context.outputDirectorySuffix = testType → initRun stamp 追加后缀（如 `...-unit`）
   * - 对应 scenario：runExecute 内 inferScenarioFromTestTypes 单选推断（unit→unit-test，api→api-test，ui→ui-test）
   * - cases 按 layer 过滤：只跑该 testType 相关用例（regression 跑全部）
   *
   * 照抄来源映射：
   * | 子代理 fresh context | pi-subagents context:"fresh" | SKILL.md:97 |
   * | 独立 outputDirectory | 现有 stamp 模式 | runner.ts:619 initRun stamp |
   * | 按 testType 路由 scenario | inferScenarioFromTestTypes | runner.ts:332 |
   */
  private async runTesterSubAgent(
    input: TaskInput,
    cases: TestCase[],
    testType: TestType,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    // 构造子代理 input：testTypes 只含当前 testType（单选 → 专用 scenario 推断）
    const subInput: TaskInput = { ...input, testTypes: [testType] };

    // 构造子代理 context：独立 outputDirectory 后缀（并行隔离，照现有 stamp 模式）
    const subContext: AgentRunContext | undefined = context
      ? { ...context, outputDirectorySuffix: testType }
      : { outputDirectorySuffix: testType };

    // cases 按 layer 过滤：regression 跑全部，其余只跑匹配 layer 的用例
    const subCases = testType === "regression"
      ? cases
      : cases.filter((c) => c.layer === testType);

    // 若过滤后无用例，返回空结果（不阻塞其他子代理）
    if (subCases.length === 0) {
      emit(log("info", `[Coordinator] tester 子代理（${testType}）：无用例匹配，跳过`, "COORDINATING"));
      return {
        phase: "execute",
        lanes: [],
        report: { passed: 0, failed: 0, coverage: null },
        artifacts: [],
        cases: [],
      };
    }

    emit(log("info", `[Coordinator] tester 子代理（${testType}）：${subCases.length} 条用例`, "COORDINATING"));

    // 照 pi-subagents runs.all fresh-context fanout：独立 Agent 实例（runExecute 内部 new Agent）
    const subResult = await this.adapter.runExecute?.(subInput, subCases, emit, signal, subContext);
    return subResult ?? { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] };
  }

  /**
   * aggregateTesterResults — 聚合多子代理结果（照 pi-subagents parent synthesize，SKILL.md:97）。
   *
   * 合并逻辑：
   * - report.passed/failed：相加
   * - report.coverage：非 null 值取平均（无数据时 null）
   * - lanes：拼接
   * - cases：拼接
   * - artifacts：拼接
   * - report.failedCases/riskPoints/fixes/fixActions/escalations/flakyCases：拼接
   * - report.qualityGate：重新评估（合并后重新计算门禁状态）
   * - report.incrementalCoverage：取第一个非 null
   * - report.fitness：取第一个非 null
   * - fullReport：拼接 timeline/uiSteps/screenshots
   * - fixDecision/diagnosis：取第一个非 null
   */
  private aggregateTesterResults(subResults: AgentRunResult[], _input: TaskInput): AgentRunResult {
    // 过滤掉空结果（无用例匹配的子代理返回空结果）
    const valid = subResults.filter((r) => r.cases && r.cases.length > 0 || r.report.passed > 0 || r.report.failed > 0);
    if (valid.length === 0) {
      return { phase: "execute", lanes: [], report: { passed: 0, failed: 0, coverage: null }, artifacts: [], cases: [] };
    }
    if (valid.length === 1) return valid[0];

    // pass/fail 相加
    const passed = valid.reduce((sum, r) => sum + r.report.passed, 0);
    const failed = valid.reduce((sum, r) => sum + r.report.failed, 0);

    // coverage 取均值（非 null 值平均，全 null 时 null）
    const coverages = valid.map((r) => r.report.coverage).filter((c): c is number => c !== null);
    const coverage = coverages.length > 0
      ? Math.round(coverages.reduce((sum, c) => sum + c, 0) / coverages.length)
      : null;

    // lanes 拼接
    const lanes: AgentLaneResult[] = valid.flatMap((r) => r.lanes);

    // cases 拼接
    const cases = valid.flatMap((r) => r.cases ?? []);

    // artifacts 拼接
    const artifacts = valid.flatMap((r) => r.artifacts);

    // 合并 report 扩展字段
    const failedCases = valid.flatMap((r) => r.report.failedCases ?? []);
    // P0 项4：用 surefire 报告补全 failedCases 的 location/testClass（追加式可选字段）
    const enrichedFailedCases = _input.projectPath
      ? enrichFailedCasesWithSurefire(failedCases, _input.projectPath)
      : failedCases;
    const riskPoints = valid.flatMap((r) => r.report.riskPoints ?? []);
    const fixes = valid.flatMap((r) => r.report.fixes ?? []);
    const fixActions = valid.flatMap((r) => r.report.fixActions ?? []);
    const escalations = valid.flatMap((r) => r.report.escalations ?? []);
    const flakyCases = valid.flatMap((r) => r.report.flakyCases ?? []);

    // incrementalCoverage 取第一个非 null
    const incrementalCoverage = valid.find((r) => r.report.incrementalCoverage)?.report.incrementalCoverage;

    // fitness 取第一个非 null
    const fitness = valid.find((r) => r.report.fitness)?.report.fitness;

    // qualityGate 重新评估（合并后重新计算门禁状态，照 evaluateQualityGate）
    const qualityGate = failed === 0 && flakyCases.length === 0
      ? { status: "passed" as const, passed, failed, flakyIsolated: 0, flakyFailed: 0, flakyCases: [], summary: `${passed} 通过，0 失败` }
      : evaluateQualityGate(cases.length, enrichedFailedCases, flakyCases);

    // fullReport 拼接 timeline
    const fullReport = valid.some((r) => r.fullReport)
      ? {
          timeline: valid.flatMap((r) => r.fullReport?.timeline ?? []),
          screenshots: valid.flatMap((r) => r.fullReport?.screenshots ?? []),
          uiSteps: valid.flatMap((r) => r.fullReport?.uiSteps ?? []),
          recording: valid.map((r) => r.fullReport?.recording).find((r) => r),
        }
      : undefined;

    // fixDecision/diagnosis 取第一个非 null
    const fixDecision = valid.find((r) => r.fixDecision)?.fixDecision;
    const diagnosis = valid.find((r) => r.diagnosis)?.diagnosis;

    const aggregateResult: AgentRunResult = {
      phase: "execute",
      lanes,
      report: {
        passed,
        failed,
        coverage,
        ...(enrichedFailedCases.length > 0 ? { failedCases: enrichedFailedCases } : {}),
        ...(riskPoints.length > 0 ? { riskPoints } : {}),
        ...(fixes.length > 0 ? { fixes } : {}),
        ...(fixActions.length > 0 ? { fixActions } : {}),
        ...(escalations.length > 0 ? { escalations } : {}),
        ...(flakyCases.length > 0 ? { flakyCases } : {}),
        ...(qualityGate ? { qualityGate } : {}),
        ...(incrementalCoverage ? { incrementalCoverage } : {}),
        ...(fitness ? { fitness } : {}),
      },
      artifacts,
      cases,
      ...(fixDecision ? { fixDecision } : {}),
      ...(diagnosis ? { diagnosis } : {}),
      ...(fullReport ? { fullReport } : {}),
    };
    finalizeQualityGate(_input, aggregateResult);
    return aggregateResult;
  }
}
