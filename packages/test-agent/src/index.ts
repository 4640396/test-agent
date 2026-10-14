/**
 * @cxmt/test-agent — CIMDEV TestAgent product package
 *
 * 两条执行路径：
 * - 内置 AI：Runner — @cxmt/agent-core Agent + 测试工具（maven_test 等）
 * - 外部 CLI：cli-runners/ — spawn cimicode/claude-code/codex-cli 子进程
 *
 * Agent runtime powered by @cxmt/agent-core (agentLoop + AgentTool).
 */

// 执行器工厂 + 类型
export { createAgentAdapter, createHostAgentAdapter } from "./core/factory.js";
export type { AgentAdapter, AgentEvent, AgentRunContext, AgentRunResult, AgentLaneResult, ScoutResult, PlanResult } from "./core/types.js";
export { log, isLogEvent } from "./core/types.js";

// Runner (内置 AI 路径)
export { Runner, createRunner } from "./core/runner.js";

// 场景配置
export {
  getScenario,
  listScenarios,
  KNOWN_TOOL_NAMES,
  type ScenarioConfig,
} from "./core/scenarios.js";

// CLI runners (外部 CLI 路径)
export { CimiCodeAdapter, createCimiCodeAdapter } from "./cli-runners/cimicode.js";
export { ClaudeCodeAdapter, resolveClaudeExecutable } from "./cli-runners/claude-code.js";
export { CodexCliAdapter, resolveCodexExecutable } from "./cli-runners/codex-cli.js";

// Test execution
export { resolveBundledPlaywrightCli } from "./core/validator.js";
export { inspectProjectSupport, type ProjectKind, type ProjectSupport } from "./core/project-support.js";
export { captureRunProvenance, type RunProvenance } from './core/run-provenance.js';
export { loadOpenApiSummary } from './core/openapi.js';

// Test tools (AgentTool)
export { createTestTools, type TestToolContext, type TestToolDetails, type TestCase, type CasePriority, type CaseLayer } from "./core/tools/index.js";
export { getChangedFiles, selectAffectedCases } from "./core/impact.js";
export { reflectMavenCommandSpec, reflectBatchMavenCommandSpec, reflectDirMavenCommandSpec, injectReflectTestRunner } from "./core/tools/reflect-test.js";
export { mavenCommandSpec, junitBatchMavenCommandSpec } from "./core/validator.js";

// Case library (用例库 — Worker 本地持久化)
export {
  CaseLibrary,
  computeProjectHash,
  computeCaseId,
  computeCodeHash,
  extractTargetFile,
  type StoredCase,
  type CaseVersion,
  type CaseLibraryIndex,
  type CodeHashResult,
} from "./core/cases.js";

// Flaky 检测与隔离（PRD 功能二）
export {
  recordRun,
  loadRuns,
  computePassRate,
  isHistorySufficient,
  isSuspiciousByHistory,
  identifySuspiciousReasons,
  detectFlaky,
  detectFlakyBatch,
  defaultFlakyConfig,
  type CaseRun,
  type FlakyRecord,
  type FlakyConfig,
  type RerunExecutor,
} from "./core/flaky.js";

// 质量门禁（PRD 功能二场景 C：flaky 隔离）
export { evaluateQualityGate, type QualityGateResult } from "./core/quality-gate.js";

// 质量趋势看板（PRD 功能二片3：5维度按周预聚合 + 突变检测）
export {
  isoWeekStart,
  aggregateWeekly,
  loadWeeklyPoints,
  writeWeeklyPoints,
  appendTaskToWeekly,
  queryMetrics,
  detectAnomalies,
  defaultAnomalyThresholds,
  extractMetricsInput,
  sumTimelineDuration,
  metricsDir,
  type FailCategory,
  type MetricsDimensions,
  type WeeklyPoint,
  type MetricsTaskInput,
  type AnomalyAlert,
  type AnomalyThresholds,
  type MetricsTimeRange,
} from "./core/metrics.js";

// 并行执行与测试分片（PRD 功能四）
export {
  isParallelizable,
  splitShards,
  shardBalanceVariance,
  aggregateShardResults,
  type ShardConfig,
  type ShardAssignment,
  type ShardExecutionResult,
  type AggregatedShardReport,
} from "./core/shard.js";

// 测试数据管理（PRD 功能四片4：数据集 + factory + cleanup hook）
export {
  parseDataset,
  parseCsv,
  namespaceForShard,
  computeDatasetId,
  DatasetLibrary,
  type DatasetRow,
  type ParsedDataset,
  type DatasetVersion,
  type StoredDataset,
  type DatasetLibraryIndex,
} from "./core/datasets.js";
export {
  DefaultDataFactory,
  executeCleanupHook,
  categorizeCreateFailure,
  type DataFactory,
  type EntityRef,
  type CreateResult,
  type CleanupResult,
  type CleanupHookResult,
  type CreateFn,
  type DeleteFn,
} from "./core/data-factory.js";
export { expandApiCases } from "./core/tools/api-test.js";

// Defect tracker（PRD 功能三：缺陷联动）
export {
  createDefectTracker,
  type DefectTracker,
  type DefectCreateInput,
  type DefectCreateResult,
  MockDefectTracker,
  resetMockCounter,
  JiraDefectTracker,
  jiraConfigFromEnv,
  isJiraConfigured,
  type JiraConfig,
} from "./integrations/index.js";

// Security
export { authorizeProjectPath, parseAllowedProjectRoots } from "./core/security.js";
export { decideFixAction } from "./core/fix-decision.js";
export type { FixDecision, FixAction, DiagnosisResult } from "./core/types.js";
export { runFixByDiagnosis, type FixDeps } from "./core/fix-orchestrator.js";

// Worker mode (headless task execution)
export { runWorkerMode, runWorkerCli, parseWorkerConfig, type WorkerConfig } from "./modes/worker-mode.js";

// Host mode (local stdio execution for desktop app)
export {
  LocalAgentHost,
  runStdioHost,
  runHostCli,
  parseLocalHostOptions,
  LOCAL_HOST_VERSION,
  type LocalAgentHostOptions,
} from "./modes/host-mode.js";
