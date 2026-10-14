/**
 * GUI 专属类型 — 只在 gui 包内部使用（Electron main/preload/renderer）。
 *
 * 运行契约类型（TaskInput/TestType/AiConfig/协议消息）从 @cxmt/protocol 导入。
 * 按 pi 方式：类型定义在使用它的包里。
 */

import type { TaskInput, TestType, AiConfig, FailedCaseRecord, EscalationRecord } from "@cxmt/protocol";

// 诊断类型组从 @cxmt/protocol 统一导入，re-export 供包内其他模块使用。
export type { FailedCaseRecord, EscalationRecord };

// ---------------------------------------------------------------------------
// 导航 + 菜单
// ---------------------------------------------------------------------------

export type AppNavTarget = "home" | "history" | "settings";
export type AppMenuCommand =
  | "start"
  | "cancel"
  | "exportMarkdown"
  | "exportHtml"
  | "copySummary"
  | "selectKnowledgeRoots"
  | "settingsEnvironment"
  | "settingsApi"
  | "settingsUi"
  | "settingsCoverage"
  | "settingsKnowledge"
  | "settingsAi";

// ---------------------------------------------------------------------------
// 任务快照 + 运行状态
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "idle"
  | "queued"
  | "planning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "needsReview";

export type LaneStatus = "pending" | "running" | "passed" | "failed";

export interface TaskLog {
  id: string;
  time: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export interface LaneState {
  type: TestType;
  status: LaneStatus;
  summary: string;
}

export interface TestCaseRecord {
  id: string;
  title: string;
  scenario: string;
  steps: string[];
  expected: string;
  priority: "low" | "medium" | "high";
  layer?: "api" | "ui" | "unit";
  source?: string;
  target?: string;
  method?: string;
  path?: string;
  body?: unknown;
  expectedStatus?: number;
  expectedBodyContains?: string[];
  expectedJsonSubset?: Record<string, unknown>;
  assertions?: number;
  coverageDelta?: string;
  /** 反射用例的 JSON 场景（target/params/assertion），传统 JUnit 用例无此字段。P0 项1+2。 */
  structuredScenario?: unknown;
}

export interface RoutingRecord {
  caseId: string;
  layer: "api" | "ui" | "unit";
  runner: string | null;
  valueScore: number;
  reason: string;
  skipped: boolean;
}

export interface UiStepRecord {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
  screenshot?: string;
  error?: string;
}

export interface TimelineRecord {
  stage: string;
  status: "pending" | "running" | "passed" | "failed";
  startedAt: string;
  durationMs?: number;
  message?: string;
}

export interface UiRecording {
  video?: string;
  trace?: string;
}

export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  logs: TaskLog[];
  lanes: LaneState[];
  artifacts: string[];
  report?: {
    provenance?: {
      gitCommitSha: string | null;
      gitDirty: boolean | null;
      projectType: 'node' | 'maven' | 'gradle' | 'mixed' | 'go' | 'python' | 'unknown';
      executionEnvironment: string;
      targetUrl: string | null;
      capturedAt: string;
    };
    passed: number;
    failed: number;
    coverage: number | null;
    branchCoverage?: number | null;
    coverageEvidence?: { source: string; generatedAt: string; gaps: Array<{ file: string; uncoveredLines: number[] }> };
    durationMs?: number;
    summary?: string;
    cases?: TestCaseRecord[];
    caseResults?: Array<{ caseId: string; status: "passed" | "failed" | "skipped"; evidence: string; tool: string }>;
    casesMeta?: {
      count: number;
      byLayer: Record<string, number>;
      byPriority: Record<string, number>;
    };
    routing?: RoutingRecord[];
    failedCases?: FailedCaseRecord[];
    uiSteps?: UiStepRecord[];
    timeline?: TimelineRecord[];
    recording?: UiRecording;
    riskPoints?: Array<{ severity: "high" | "medium" | "low"; file: string; message: string; suggestion?: string }>;
    fixes?: Array<{ severity: "high" | "medium" | "low"; file: string; title: string; summary: string; beforeCode?: string; afterCode?: string }>;
    /** read-only 违规证据（诊断 Agent 改了文件时由 mutation-evidence 填充）。 */
    readOnlyViolation?: { changedFiles: string[]; unavailable?: string };
    /** 修复动作（诊断先行架构：按诊断分类修复后产出的可追溯记录）。 */
    fixActions?: Array<{
      diagnosisName: string;
      category: "real-bug" | "test-defect" | "environment" | "flaky";
      confidence: "high" | "low";
      files: Array<{ path: string; diff: string }>;
      rerunResult: { passed: number; failed: number };
      patch: string;
    }>;
    /** escalation 汇总（任务结束后从 EscalationHandler.getRecords 收集，角色调 escalate 工具的记录）。无 escalation 时 undefined。 */
    escalations?: EscalationRecord[];
    screenshots?: string[];
    metrics?: {
      compileRate: number;
      execRate: number;
      assertRate: number;
      effectiveRate: number;
      knowledgeRate?: number;
    };
    gate?: {
      coverageTarget: number;
      coverage: number | null;
      effectiveRate: number;
      passed: boolean;
      reason: string;
      blockingReasons?: string[];
    };
    api?: {
      pass: number;
      fail: number;
      skipped: number;
      details: Array<{ caseId: string; method: string; path: string; status: string; statusCode?: number; durationMs?: number; reason?: string }>;
    };
    knowledge?: {
      refs: Array<{
        source: string;
        version: string | null;
        type: string;
      }>;
      degraded: boolean;
      reason?: string;
    };
    /** Fitness-driven 自修复观测（PRD 功能一）。 */
    fitness?: {
      iterations: number;
      k: number;
      converged: boolean;
      stoppedReason: 'converged' | 'no-improvement' | 'max-iterations' | 'no-failures';
      message: string;
      curve: Array<{ iter: number; passed: number; failed: number; coverage: number | null; passRate: number; passRateDelta: number; coverageDelta: number; improvement: boolean }>;
      tokenCost?: { input: number; output: number; total: number } | null;
    };
  };
}

export interface HistoryRecord {
  id: string;
  projectName: string;
  projectPath: string;
  version: string;
  savedAt: string;
  snapshot: TaskSnapshot;
}

export interface RuntimeStatus {
  mode: "unavailable" | "real";
  provider: "local-go" | "claude-code" | "codex-cli" | "cimicode" | "local-host" | null;
  message: string;
}

export interface EnvironmentProfile {
  id: string;
  projectPath: string;
  name: string;
  apiBaseUrl: string;
  openApiUrl: string;
  uiEntryUrl: string;
  coverageTarget: number;
  apiHeaders: Array<{ key: string; value: string }>;
  env: Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// 缺陷联动（PRD 功能三：建单）
// ---------------------------------------------------------------------------

/** 建单输入（从 FailedCaseRecord 组装，对齐 test-agent DefectCreateInput）。 */
export interface DefectCreateInput {
  title: string;
  description: string;
  evidence?: string;
  suggestion?: string;
  caseName: string;
  category: string;
  screenshots?: string[];
  attachments?: string[];
}

/** 建单结果（对齐 test-agent DefectCreateResult）。 */
export interface DefectCreateResult {
  ok: boolean;
  defectId?: string;
  defectUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 项目选择 + 导出结果
// ---------------------------------------------------------------------------

export interface ProjectSelection {
  path: string;
  detectedSystem: string;
  detectedVersion: string;
  detectedTestTypes?: TestType[];
  requiredCapabilities?: string[];
  projectKind?: 'node' | 'maven' | 'gradle' | 'mixed' | 'go' | 'python' | 'unknown';
  supported?: boolean;
  unsupportedReason?: string;
}

export interface ExportResult {
  saved: boolean;
  path?: string;
  error?: string;
}

export interface CopyResult {
  copied: boolean;
}

// ---------------------------------------------------------------------------
// 回归套件（P3-1：命名保存的用例集合，可一键回归）
// ---------------------------------------------------------------------------

/** 回归套件——命名保存的用例集合，可一键回归。持久化到 .test-agent/suites/<id>.json。 */
export interface Suite {
  id: string;
  name: string;
  projectPath: string;
  caseIds: string[];
  testStrategy: 'reflect' | 'junit';
  createdAt: string;
  lastRunAt?: string;
  lastRunResult?: { total: number; pass: number; fail: number; skipped: number };
}

/** 套件运行结果。 */
export interface SuiteRunResult {
  results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }>;
  summary: { total: number; pass: number; fail: number; skipped: number; time?: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Electron IPC API（preload 暴露给 renderer）
// ---------------------------------------------------------------------------

export interface DesktopApi {
  selectProject(): Promise<ProjectSelection | null>;
  detectProject(path: string): Promise<ProjectSelection | null>;
  getKnowledgeRoots(): Promise<string[]>;
  onKnowledgeRootsChanged(listener: (roots: string[]) => void): () => void;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  startTask(input: TaskInput): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<TaskSnapshot | null>;
  cancelTask(taskId: string): Promise<TaskSnapshot | null>;
  retryTask(taskId: string): Promise<{ taskId: string } | null>;
  rollbackFix(projectPath: string, patch: string): Promise<boolean>;
  subscribeTask(listener: (snapshot: TaskSnapshot) => void): () => void;
  exportReport(format: "markdown" | "html" | "json" | "pdf", snapshot: TaskSnapshot, projectPath?: string): Promise<ExportResult>;
  copyReportSummary(snapshot: TaskSnapshot): Promise<CopyResult>;
  copyText(text: string): Promise<CopyResult>;
  getHistory(): Promise<HistoryRecord[]>;
  saveHistory(record: HistoryRecord): Promise<void>;
  clearHistory(): Promise<void>;
  selectKnowledgeRoots(): Promise<string[]>;
  getAiConfig(): Promise<AiConfig | null>;
  saveAiConfig(config: AiConfig): Promise<void>;
  loadEnvironmentProfiles(projectPath: string): Promise<EnvironmentProfile[]>;
  saveEnvironmentProfiles(projectPath: string, profiles: EnvironmentProfile[]): Promise<void>;
  authorizeProjectArtifacts(projectPath: string): Promise<boolean>;
  onNavigate(listener: (target: AppNavTarget) => void): () => void;
  onCommand(listener: (command: AppMenuCommand) => void): () => void;
  // 用例库（Worker 本地 .test-agent/cases/ 读写，控制面零改动）
  loadCases(projectPath: string): Promise<unknown[]>;
  previewPlanImpact(projectPath: string, cases: unknown[]): Promise<{ total: number; selected: number; skipped: number; changedFilesCount: number; fallbackReason: string | null }>;
  saveCase(projectPath: string, testCase: Record<string, unknown>): Promise<boolean>;
  deleteCaseFromLibrary(projectPath: string, title: string): Promise<boolean>;
  previewGeneratedTestReset(projectPath: string): Promise<{ removableFiles: string[]; protectedFiles: string[] }>;
  resetGeneratedTests(projectPath: string): Promise<{ removedFiles: string[]; failedFiles: string[]; protectedFiles: string[] }>;
  // 反射场景持久化（P0 项1+2：读/写/列 .test-agent/scenarios/<caseId>.json，控制面零改动）
  readScenario(projectPath: string, caseId: string): Promise<unknown | null>;
  saveScenario(projectPath: string, caseId: string, scenario: unknown): Promise<boolean>;
  listScenarios(projectPath: string): Promise<Array<{ caseId: string; title?: string }>>;
  // P3-2 场景文件管理（删除/导入/导出 .test-agent/scenarios/，控制面零改动）
  deleteScenario(projectPath: string, caseId: string): Promise<boolean>;
  importScenarios(projectPath: string, scenarios: Array<{ caseId: string; scenario: unknown }>): Promise<{ imported: number; skipped: number }>;
  exportScenarios(projectPath: string, caseIds?: string[]): Promise<Array<{ caseId: string; scenario: unknown }>>;
  // 单场景重跑（P0 项3：main 本地 spawn mvn，不进 control-server）
  rerunLocal(projectPath: string, caseId: string): Promise<{ ok: boolean; output: string; error?: string }>;
  runAllLocal(projectPath: string): Promise<{ ok: boolean; output: string; error?: string }>;
  runSelectedReflect(projectPath: string, caseIds: string[]): Promise<SuiteRunResult>;
  // 批量只跑失败重跑（P1-2：反射逐条 + JUnit 批量 -Dtest，不进 control-server）
  rerunFailedBatch(projectPath: string, failedCases: Array<{ name: string; layer: string; caseId?: string; testClass?: string }>): Promise<{ results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }>; summary: { total: number; pass: number; fail: number; skipped: number }; error?: string }>;
  getMetrics(projectPath: string, range?: { start: string; end: string }): Promise<unknown[]>;
  // 缺陷联动（PRD 功能三：一键建单）
  createDefect(input: DefectCreateInput): Promise<DefectCreateResult>;
  // escalation 通道（片B：GUI 答复角色 escalation）
  replyEscalation(executionId: string, escalationId: string, answer: string): Promise<boolean>;
  dismissEscalation(executionId: string, escalationId: string): Promise<boolean>;
  // escalation 历史审计（读 .test-agent/escalations/<hash>/audit.jsonl，跨任务）
  getEscalationAudit(projectPath: string): Promise<EscalationRecord[]>;
  // 回归套件管理（P3-1：SuiteLibrary 本地 .test-agent/suites/，控制面零改动）
  saveSuite(projectPath: string, name: string, caseIds: string[], testStrategy: 'reflect' | 'junit'): Promise<{ ok: boolean; suiteId: string; error?: string }>;
  listSuites(projectPath: string): Promise<Suite[]>;
  deleteSuite(projectPath: string, suiteId: string): Promise<{ ok: boolean; error?: string }>;
  runSuite(projectPath: string, suiteId: string): Promise<SuiteRunResult>;
}

// ---------------------------------------------------------------------------
// 质量看板类型（PRD 功能二片3：5维度周点）
// ---------------------------------------------------------------------------

export interface DashboardWeeklyPoint {
  weekStart: string;
  taskCount: number;
  dimensions: {
    passRate: number;
    failCategoryRatio: { 'real-bug': number; 'test-defect': number; environment: number; flaky: number };
    flakyRate: number;
    avgDurationMs: number | null;
    tokenCost: number | null;
  };
}

export interface DashboardAnomalyAlert {
  dimension: string;
  from: number;
  to: number;
  message: string;
  weekStart: string;
}

// ---------------------------------------------------------------------------
// Local Host API（Electron main → host-mode 子进程）
// ---------------------------------------------------------------------------

export interface LocalHostStatus {
  running: boolean;
  protocolVersion?: number;
  hostVersion?: string;
  capabilities?: string[];
  activeRuns?: number;
  error?: string;
}

export interface LocalHostStartResult {
  taskId: string;
}

export interface LocalHostCancelResult {
  cancelled: boolean;
}

export interface LocalHostApi {
  getStatus(): Promise<LocalHostStatus>;
  start(input: TaskInput, executionId?: string): Promise<LocalHostStartResult>;
  cancel(executionId: string): Promise<LocalHostCancelResult>;
  subscribe(listener: (message: unknown) => void): () => void;
}
