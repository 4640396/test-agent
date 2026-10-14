/**
 * Agent 事件与运行结果类型。
 *
 * AgentEvent 是 union type，是 @cxmt/protocol `LocalHostAgentEvent` 的别名（单一来源）。
 * 外部 CLI adapter（cimicode 等）用 log() 辅助函数发简单的日志事件。
 * runner（内置 Agent 路径）发完整的结构化事件（tool_execution_start/end 等）。
 */

import type {
  TaskInput,
  TestType,
  DiagnosisCategory,
  EscalationRecord,
  FailedCaseRecord,
  FixAction,
  LocalHostAgentEvent,
} from '@cxmt/protocol';

// 诊断类型组从 @cxmt/protocol 统一导入，re-export 供包内其他模块使用。
export type { DiagnosisCategory, EscalationRecord, FailedCaseRecord, FixAction };

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/**
 * Agent 运行时事件。union type，按 type 分发。
 *
 * 单一来源：本类型是 @cxmt/protocol `LocalHostAgentEvent` 的别名，
 * protocol 是 LIVE 定义，test-agent 仅 import 复用，消除两处手工对齐的漂移风险。
 * 消费方仍用 `import type { AgentEvent } from "./types.js"`，路径不变。
 *
 * - `log`：简单日志行（外部 CLI adapter 用），兼容旧 `{ level, message, stage }` 格式
 * - `agent_start`/`agent_end`：Agent 生命周期
 * - `turn_start`/`turn_end`：一轮对话（assistant 响应 + 工具调用）
 * - `message_update`：LLM 流式文本增量（delta）
 * - `tool_execution_start`/`tool_execution_end`：工具调用生命周期
 *   - `tool_execution_end.result` 是 AgentToolResult，其中 `details` 是结构化测试结果
 */
export type AgentEvent = LocalHostAgentEvent;

/**
 * 创建一个 log 类型的事件（外部 CLI adapter 用）。
 *
 * 替代旧的 `emit({ level, message, stage })`，改为 `emit(log("info", "消息"))`。
 */
export function log(
  level: 'info' | 'success' | 'warning' | 'error',
  message: string,
  stage?: string,
  role?: string,
): AgentEvent {
  return { type: 'log', level, message, stage, role };
}

/** 判断事件是否为 log 类型（向后兼容辅助）。 */
export function isLogEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'log' }> {
  return event.type === 'log';
}

// ---------------------------------------------------------------------------
// 运行结果
// ---------------------------------------------------------------------------

export interface AgentLaneResult {
  type: TestType;
  status: 'passed' | 'failed';
  summary: string;
}

/**
 * 结构化测试用例（计划阶段产出）。
 * 字段与 cimicode RESULT_SCHEMA_DESCRIPTION + GUI TestCaseRecord 对齐。
 */
export interface TestCase {
  id: string;
  title: string;
  scenario: string;
  steps: string[];
  expected: string;
  priority: 'low' | 'medium' | 'high';
  layer: 'unit' | 'api' | 'ui';
  target?: string;
  method?: string;
  path?: string;
  body?: unknown;
  expectedStatus?: number;
  expectedBodyContains?: string[];
  expectedJsonSubset?: Record<string, unknown>;
  /** 用例来源：reuse（库复用）/ incremental（增量新生成）/ generated（首次生成）。PRD 场景B 标记。 */
  source?: 'reuse' | 'incremental' | 'generated';
  /** 需求追溯 ID（PRD 5.3，可选，首期留字段不强制）。 */
  requirementId?: string;
  /** 是否可并行分片（PRD 功能四，默认 true）。false = 依赖组/共享状态，强制串行片。 */
  parallelizable?: boolean;
  /** P2-3: 结构化场景（反射模式产出，与 R1 scenarioSchema 一致）。testStrategy=reflect 时 case-designer 产出，tester 直接调 reflect_test 执行。 */
  structuredScenario?: StructuredScenario;
}

/** P2-3: 反射场景的结构化定义（与 reflect-test.ts scenarioSchema 一致）。 */
export interface StructuredScenario {
  id: string;
  title?: string;
  target: {
    className: string;
    method: string;
    methodSignature?: string;
  };
  setup?: {
    springContext?: boolean;
    mainClass?: string;
    /** P4-2: 数据库 fixture——预置数据行，事务回滚保证不残留。需 springContext=true + DataSourceTransactionManager。 */
    fixtures?: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }>;
    /** P4-2: Mock bean——仅支持 interface 依赖（java.lang.reflect.Proxy 限制）。指向 class 时 warning 跳过。 */
    mocks?: Array<{
      bean: string;
      stubs: Array<{
        method: string;
        returnValue?: unknown;
      }>;
    }>;
  };
  params: Array<{
    name?: string;
    type: string;
    value: unknown;
  }>;
  assertion: {
    type: 'return' | 'exception';
    expected?: unknown;
    expectedType?: string;
    expectedException?: string;
    expectedMessage?: string;
  };
}

/** ai-native 路径的结构化产物（从测试工具的 TestToolDetails 聚合）。 */
export interface TimelineEntry {
  stage: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startedAt: string;
  durationMs?: number;
  message?: string;
}

export interface AgentFullReport {
  /** UI 截图路径（相对于项目根目录）。 */
  screenshots?: string[];
  /** UI 录像/trace 路径。 */
  recording?: { video?: string; trace?: string };
  /** UI 测试步骤详情（含每步截图缩略图）。 */
  uiSteps?: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number; screenshot?: string; error?: string }>;
  /** 执行时间线（阶段流转：计划→读源码→写测试→跑测试→修复）。 */
  timeline?: TimelineEntry[];
}

/** 增量覆盖率结果（PRD 功能三，变更代码行 ∩ 覆盖行）。 */
export interface IncrementalCoverageResult {
  /** 执行模式：incremental（只跑受影响用例）/ full（全量跑）。 */
  mode: 'incremental' | 'full';
  /** 变更文件列表（相对路径）。 */
  changedFiles: string[];
  /** 变更代码行数（新增行）。 */
  changedLineCount: number;
  /** 变更代码中被覆盖的行数。 */
  coveredChangedLineCount: number;
  /** 增量覆盖率百分比（null = 无行级覆盖率数据）。 */
  percentage: number | null;
  /** 受影响用例数（增量模式下实际执行的用例数）。 */
  affectedCaseCount: number;
  /** 总用例数。 */
  totalCaseCount: number;
  /** 无法计算行级覆盖率时的降级原因。 */
  fallbackReason?: string;
}

/** 计划阶段的返回值（方案B：两次独立调用）。 */
export interface PlanResult {
  phase: 'plan';
  cases: TestCase[];
  artifacts: string[];
}

/** 测试代码生成阶段结果；编译门禁通过后才允许进入 execute。 */
export interface GenerationResult {
  phase: 'generate';
  cases: TestCase[];
  artifacts: string[];
  generatedFiles: string[];
  groups: number;
}

/** 分层自动修复决策（PRD 2.2 分层策略）。 */
export type FixDecision =
  | { action: "auto-fix"; reason: string }
  | { action: "needs-confirm"; reason: string }
  | { action: "no-fix"; reason: string };

/** 诊断结果（orchestrator 产出，runner 接线后填入 report）。 */
export interface DiagnosisResult {
  failedCases: FailedCaseRecord[];
  riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>;
  fixes?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; title: string; summary: string; beforeCode?: string; afterCode?: string }>;
  /** read-only 违规证据（mutation-evidence 检测到诊断 Agent 改了文件）。 */
  readOnlyViolation?: { changedFiles: string[]; unavailable?: string };
}

export interface AgentRunResult {
  /** 阶段标记，GUI 据此区分计划结果 vs 执行结果。 */
  phase?: 'execute' | 'fix';
  lanes: AgentLaneResult[];
  report: {
    provenance?: import('./run-provenance.js').RunProvenance;
    passed: number;
    failed: number;
    coverage: number | null;
    branchCoverage?: number | null;
    coverageEvidence?: { source: string; generatedAt: string; gaps: Array<{ file: string; uncoveredLines: number[] }> };
    /** Explicit tool evidence only; candidates without an entry remain unverified. */
    caseResults?: Array<{ caseId: string; status: 'passed' | 'failed' | 'skipped'; evidence: string; tool: string }>;
    /** escalation 记录汇总（角色调 escalate 工具时由 runner/orchestrator/fix-orchestrator 从 EscalationHandler 收集）。无 escalation 时 undefined。 */
    escalations?: EscalationRecord[];
    /** 失败用例诊断（failed>0 时由 orchestrator 填充）。 */
    failedCases?: FailedCaseRecord[];
    /** 风险点（诊断产出的结构性风险）。 */
    riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>;
    /** 修复建议（诊断产出的结构化修复方案）。 */
    fixes?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; title: string; summary: string; beforeCode?: string; afterCode?: string }>;
    /** read-only 违规证据（诊断 Agent 改了文件时由 mutation-evidence 填充）。 */
    readOnlyViolation?: { changedFiles: string[]; unavailable?: string };
    /** 修复动作（诊断先行架构：按诊断分类修复后产出的可追溯记录）。 */
    fixActions?: FixAction[];
    /** Flaky 检测结果（PRD 功能二，failed>0 时由 flaky 模块填充）。 */
    flakyCases?: Array<{
      caseId: string;
      caseTitle: string;
      isFlaky: boolean;
      reason: string;
      rerunResults?: boolean[];
      rerunPassRate?: number;
      historyPassRate?: number;
      historyCount: number;
      suspiciousReasons: string[];
    }>;
    /** 质量门禁评估（PRD 功能二场景 C，flaky 隔离后的门禁结果）。 */
    qualityGate?: {
      status: 'passed' | 'failed';
      passed: number;
      failed: number;
      flakyIsolated: number;
      flakyFailed: number;
      flakyCases: Array<{ caseId: string; caseTitle: string; isFlaky: boolean; reason: string }>;
      /** 阻止发布的确定性原因；为空表示没有未解决的人工复核项。 */
      blockingReasons?: string[];
      coverageTarget?: number;
      coverage?: number | null;
      summary: string;
    };
    /** 增量覆盖率（PRD 功能三，变更代码行 ∩ 覆盖行）。 */
    incrementalCoverage?: IncrementalCoverageResult;
    /** Fitness-driven 自修复观测（PRD 功能一：通过率/覆盖率双指标重试曲线）。 */
    fitness?: FitnessReport;
  };
  artifacts: string[];
  cases?: TestCase[];
  /** 诊断先行架构：分层修复决策（auto-fix/needs-confirm/no-fix），供 host-mode 分流。 */
  fixDecision?: FixDecision;
  /** 诊断先行架构：诊断结果（runDiagnosis 产出），传给后续修复阶段。 */
  diagnosis?: DiagnosisResult;
  /** @deprecated 顶层 riskPoints 已迁移到 report.riskPoints，保留向后兼容。 */
  riskPoints?: unknown[];
  /** @deprecated 顶层 fixes 已迁移到 report.fixes，保留向后兼容。 */
  fixes?: unknown[];
  /** 结构化产物（截图/录像/步骤），从测试工具聚合，GUI 读 outcome.fullReport 展示。 */
  fullReport?: AgentFullReport;
}

// ---------------------------------------------------------------------------
// Fitness-driven 自修复观测（PRD 功能一）
// ---------------------------------------------------------------------------

/** 目标函数曲线上的单个观测点（每轮 fix+retest 后追加）。 */
export interface FitnessCurvePoint {
  /** 迭代轮次（1-based，0 = 初始 execute 基线）。 */
  iter: number;
  /** 通过用例数。 */
  passed: number;
  /** 失败用例数。 */
  failed: number;
  /** 覆盖率（无数据时 null）。 */
  coverage: number | null;
  /** 通过率百分比（0-100）。 */
  passRate: number;
  /** 与上一观测点相比的通过率增量（百分点）。 */
  passRateDelta: number;
  /** 与上一观测点相比的覆盖率增量（百分点，无数据时 0）。 */
  coverageDelta: number;
  /** passRateDelta>0 或 coverageDelta>0 任一为正即 true。 */
  improvement: boolean;
}

/** Fitness-driven 重试的观测报告（写入 AgentRunResult.report.fitness）。 */
export interface FitnessReport {
  /** 实际迭代轮次（不含初始基线）。 */
  iterations: number;
  /** 判停阈值（连续 K 轮无正提升即停）。 */
  k: number;
  /** 是否收敛（达标或无失败）。 */
  converged: boolean;
  /** 停止原因。 */
  stoppedReason: 'converged' | 'no-improvement' | 'max-iterations' | 'no-failures';
  /** 人类可读的停止说明（未收敛时含『需人工』）。 */
  message: string;
  /** 目标函数曲线（基线 + 每轮观测点）。 */
  curve: FitnessCurvePoint[];
  /** token 用量（agent-core 能取到则记录，否则 null，片3 看板标『数据积累中』）。 */
  tokenCost?: { input: number; output: number; total: number } | null;
}

export interface AgentRunContext {
  knowledge?: string;
  /** 上一轮反馈循环的失败信息，用于 LLM 修复重跑（仅 cimicode adapter 使用） */
  feedback?: string;
  /** 关联任务 ID（PRD 5.5 场景A），从 worker-mode/hand-mode 传入，入库时写入 CaseVersion.taskId。 */
  taskId?: string;
  /** 全量跑开关（PRD 功能三，默认增量，true 强制全量跑所有用例）。 */
  fullRun?: boolean;
  /** Fitness-driven 自修复开关（PRD 功能一，true 时 run() 用 runFitnessDrivenExecute 替代 runExecute）。 */
  fitnessDriven?: boolean;
  /** Escalation handler（host/worker-mode 构造传入，角色 .md 配 escalation:true 时注入 escalate 工具）。 */
  escalationHandler?: unknown;
  /** Coordinator 调度层启用（planner-worker 架构，默认 false 用现有顺序流水线）。
   *
   * ⚠️ 启用时暂跳过 execWithMetrics（质量趋势聚合 + flaky 检测 + 增量覆盖率），后续切片补齐。 */
  coordinatorEnabled?: boolean;
  /** 并行隔离：fan-out 子代理的 outputDirectory 后缀（照 pi-subagents runs.all fresh-context 隔离）。
   *
   * Coordinator 按 testTypes fan-out 时传入 testType 值，initRun 在 stamp 后追加后缀
   * （如 `2026-09-09T...-unit`），防并行子代理共享同一 results 目录。 */
  outputDirectorySuffix?: string;
}

// ---------------------------------------------------------------------------
// 侦察结果（测试角色分工架构：scout 角色产出）
// ---------------------------------------------------------------------------

export interface ScoutResult {
  /** 侦察报告（Markdown 文本，scout 角色的 LLM 输出）。 */
  report: string;
  /** 产物路径（scout 不产文件产物，留空）。 */
  artifacts: string[];
}

// ---------------------------------------------------------------------------
// Adapter 接口（阶段2退役，阶段1 runner 暂时实现它以保持兼容）
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  readonly name: string;
  /** 一次性执行（cimicode 等外部 CLI adapter 用）。 */
  run(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult>;
  /** 计划阶段（ai-native 两阶段流程用）。 */
  runPlan?(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<PlanResult>;
  /** 执行阶段（ai-native 两阶段流程用）。 */
  runExecute?(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult>;
  runGenerate?(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<GenerationResult>;
  /** 修复阶段（诊断先行架构用，按诊断结果修复）。 */
  runFix?(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult>;
  /** Fitness-driven 自修复编排（PRD 功能一：execute→fix→retest 循环 + 双指标判停）。旧 adapter 无该方法时降级 run()。 */
  runFitnessDrivenExecute?(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult>;
  /** 侦察阶段（测试角色分工架构用，scout 角色产出侦察报告）。 */
  runScout?(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<ScoutResult>;
  /** 用例设计阶段（测试角色分工架构用，case-designer 角色，读 scout 报告产出用例）。 */
  runCaseDesign?(
    input: TaskInput,
    scoutReport: string,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<PlanResult>;
}
