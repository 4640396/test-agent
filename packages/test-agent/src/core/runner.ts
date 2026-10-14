/**
 * Runner — 内置 Agent 路径的核心执行逻辑。
 *
 * 与旧内置 adapter 的根本区别：
 * 1. 测试工具替代 bash：LLM 调 maven_test/node_test/playwright_test/api_test，
 *    拿到结构化结果（pass/fail/coverage），不用 bash 跑命令再解析文本。
 * 2. 结构化事件转发：不把 agent-core AgentEvent 塌缩成日志行，
 *    直接转发 tool_execution_start/end、message_update 等结构化事件。
 * 3. 报告从工具结果聚合：订阅 tool_execution_end 收集 TestToolDetails，
 *    agent 跑完后聚合为 AgentRunResult，不依赖 LLM 写结果文件。
 * 4. 保留 read/write/edit 通用工具：LLM 需要读源码、写测试文件、编辑代码。
 *
 * 配置：读取 ai-config.json（格式借鉴 pi 的 models.json），或环境变量覆盖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM 等价 __dirname（runner.ts 在 src/core/，agents/ 在 ../../agents）
// dev 模式 __dirname=src/core/，prod 模式 __dirname=dist/core/（dist 下无 agents/，fallback 源码路径）
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/** 解析 agents 目录：dist 找不到时 fallback 到源码路径（.md 不被 tsc 拷进 dist） */
function resolveAgentsDir(): string {
  const distAgents = resolve(__dirname, "../../agents");
  if (existsSync(distAgents)) return distAgents;
  // electron-vite bundle 模式：__dirname=out/main/，要往上到 packages/test-agent/agents
  const candidates = [
    resolve(__dirname, "../../packages/test-agent/agents"),
    resolve(__dirname, "../../../packages/test-agent/agents"),
    resolve(__dirname, "../../../../packages/test-agent/agents"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return distAgents;
}
import type { TaskInput, TestType } from "@cxmt/protocol";
import { captureRunProvenance } from './run-provenance.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentFullReport,
  AgentLaneResult,
  AgentRunContext,
  AgentRunResult,
  DiagnosisResult,
  FailedCaseRecord,
  FitnessReport,
  GenerationResult,
  PlanResult,
  TestCase,
  StructuredScenario,
  TimelineEntry,
} from "./types.js";
import { log } from "./types.js";
import type { Model, Message, TextContent } from "@cxmt/ai";
import { extractAssistantText } from "./assistant-text.js";
import { streamSimple as streamOpenAICompletionsSimple } from "@cxmt/ai/api/openai-completions";
import {
  Agent,
  type AgentTool,
  type StreamFn,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@cxmt/agent-core";
import { NodeExecutionEnv } from "@cxmt/agent-core/node";
import {
  appendTurnBudgetSystemPrompt,
  turnBudgetDecision,
  turnBudgetExceededMessage,
  registerSubagentCapabilityCeiling,
  resolveSubagentCapabilityCeiling,
  assertAgentAllowedByCapabilityCeiling,
  snapshotTrackedMutations,
  collectTrackedMutationEvidence,
} from "@cxmt/sub";
import { createTestTools, type TestToolContext, type TestToolDetails } from "./tools/index.js";
import { reflectMavenCommandSpec, persistScenarios } from "./tools/reflect-test.js";
import { createEscalateTool } from "./tools/escalate.js";
import { runAgentWithIdleWatchdog } from "./agent-idle-watchdog.js";
import {
  buildTransientExecutionRecoveryPrompt,
  getLastAssistantMessage,
  shouldRecoverTransientExecution,
} from "./execution-recovery.js";
import type { EscalationHandler } from "./escalation-handler.js";
import { getScenario, type ScenarioConfig } from "./scenarios.js";
import { runDiagnosis, type FailedCaseInput } from "./orchestrator.js";
import { runFixByDiagnosis, type FixDeps } from "./fix-orchestrator.js";
import { decideFixAction, type FixDecision } from "./fix-decision.js";
import { evaluateFitness, makeCurvePoint, buildFitnessReport, type FitnessDecision } from "./fitness.js";
import { loadRoles, type RoleConfig } from "./agent-loader.js";
import type { ScoutResult } from "./types.js";
import { CaseLibrary, computeCaseId, computeCodeHash, computeProjectHash } from "./cases.js";
import { recordRun, loadRuns, detectFlaky, defaultFlakyConfig, identifySuspiciousReasons, type RerunExecutor, type FlakyRecord } from "./flaky.js";
import { appendTaskToWeekly, extractMetricsInput, sumTimelineDuration } from "./metrics.js";
import { evaluateQualityGate, finalizeQualityGate } from "./quality-gate.js";
import { runNodeUnitTests, runMavenUnitTests, runMavenCommand, runPlaywrightUiTests } from "./validator.js";
import { getChangedFiles, getChangedLines, selectAffectedCases, computeIncrementalCoverage } from "./impact.js";
import { loadOpenApiSummary } from './openapi.js'
import { inspectProjectSupport, type ProjectKind } from './project-support.js'

// ---------------------------------------------------------------------------
// 项目上下文扫描（减少 LLM 探索轮）
// ---------------------------------------------------------------------------

/** 扫描项目结构，返回关键信息供 LLM 直接使用，避免前几轮 read 探索。 */
function scanProjectContext(projectPath: string): string {
  const lines: string[] = [];
  const root = resolve(projectPath);

  // 1. package.json（如果存在）
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      lines.push(`项目类型: Node.js`);
      lines.push(`项目名: ${pkg.name ?? "未识别"}`);
      if (pkg.scripts?.test) lines.push(`测试命令: ${pkg.scripts.test}`);
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      const testFrameworks = devDeps.filter((d) =>
        /vitest|jest|mocha|playwright|pytest/.test(d));
      if (testFrameworks.length) lines.push(`已有测试框架: ${testFrameworks.join(", ")}`);
    } catch { /* 忽略解析失败 */ }
  }

  // 2. pom.xml / build.gradle（如果存在）
  for (const buildFile of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    if (existsSync(join(root, buildFile))) {
      lines.push(`项目类型: ${buildFile.startsWith("pom") ? "Maven" : "Gradle"} (Java)`);
      lines.push(`构建文件: ${buildFile}`);
      break;
    }
  }

  // 3. go.mod（如果存在）
  if (existsSync(join(root, "go.mod"))) {
    lines.push(`项目类型: Go`);
  }

  // 4. 源文件列表（最多30个，排除 node_modules/.git/dist 等）
  const sourceFiles: string[] = [];
  const excludeDirs = new Set(["node_modules", ".git", "dist", "build", "target", ".test-agent", "out"]);
  function walk(dir: string, depth: number): void {
    if (sourceFiles.length >= 30 || depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (sourceFiles.length >= 30) return;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!excludeDirs.has(name) && !name.startsWith(".")) walk(full, depth + 1);
      } else {
        if (/\.(ts|js|mjs|cjs|java|go|py|vue|jsx|tsx)$/.test(name)) {
          sourceFiles.push(relative(root, full));
        }
      }
    }
  }
  walk(root, 0);
  if (sourceFiles.length) {
    lines.push(`源文件（最多30个）:`);
    for (const f of sourceFiles) lines.push(`  ${f}`);
  }

  // 5. 现有测试文件
  const testFiles = sourceFiles.filter((f) => /\.test\.|\.spec\.|_test\.|Test\./.test(f));
  if (testFiles.length) {
    lines.push(`已有测试文件: ${testFiles.length} 个`);
  } else {
    lines.push(`已有测试文件: 无（需要新建）`);
  }

  return lines.join("\n");
}

interface GenerationGroup {
  sourcePath: string;
  outputPath: string;
  cases: TestCase[];
}

const GENERATED_TEST_MARKER = "Generated by CIMDEV Test Agent";

export function assertGeneratedFileWritable(projectPath: string, outputPath: string): void {
  const absolute = resolve(projectPath, outputPath);
  if (!existsSync(absolute)) return;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", outputPath], { cwd: projectPath, stdio: "ignore" });
    throw new Error(`拒绝覆盖 Git 已跟踪的测试文件：${outputPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("拒绝覆盖")) throw error;
  }
  const existing = readFileSync(absolute, "utf8");
  if (!existing.includes(GENERATED_TEST_MARKER)) throw new Error(`拒绝覆盖非 Test Agent 所有的测试文件：${outputPath}`);
}

/** 按目标源码聚合；同一生产类只交给一个 writer，避免并行覆盖同一测试文件。 */
export function groupCasesForGeneration(projectPath: string, cases: TestCase[]): GenerationGroup[] {
  const groups = new Map<string, TestCase[]>();
  for (const item of cases) {
    const raw = String(item.target ?? "").replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/");
    if (!raw || !raw.includes("src/main/") || !/\.(?:java|kt|groovy)$/i.test(raw)) {
      throw new Error(`用例 ${item.id} 缺少可生成测试的目标源码路径：${item.target ?? "未填写"}`);
    }
    const mainIndex = raw.indexOf("src/main/");
    const sourcePath = raw.slice(mainIndex).replace(/^\.\//, "");
    const bucket = groups.get(sourcePath) ?? [];
    bucket.push(item);
    groups.set(sourcePath, bucket);
  }
  return [...groups.entries()].map(([sourcePath, groupedCases]) => {
    const sourceExt = extname(sourcePath);
    const className = basename(sourcePath, sourceExt);
    const testRelativeDir = dirname(sourcePath).replace(/^src\/main\/(?:java|kotlin|groovy)/, "src/test/java");
    const outputPath = join(testRelativeDir, `${className}AgentGeneratedTest.java`).replace(/\\/g, "/");
    const absoluteOutput = resolve(projectPath, outputPath);
    const testRoot = resolve(projectPath, "src/test");
    if (!absoluteOutput.startsWith(testRoot)) throw new Error(`生成测试路径越界：${outputPath}`);
    return { sourcePath, outputPath, cases: groupedCases };
  });
}

/** Complex targets need more context, but keep a hard ceiling to prevent unbounded repository exploration. */
export function generationReadBudget(caseCount: number): number {
  return Math.min(24, Math.max(12, 8 + caseCount * 2));
}

/** Keep user-facing Maven compiler failures short; the full output belongs in technical logs. */
export function summarizeMavenCompilationErrors(raw: string, limit = 5): string {
  const lines = raw.split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[ERROR\]\s*/i, "").trim())
    .filter((line) => /\.java:\[\d+,\d+\]/i.test(line))
    .map((line) => line.replace(/\\/g, "/"));
  const unique = [...new Set(lines)];
  if (unique.length === 0) return "请查看技术日志中的 Maven 编译诊断。";
  const shown = unique.slice(0, limit).join("；");
  return unique.length > limit ? `${shown}；另有 ${unique.length - limit} 处错误` : shown;
}

/** A previous interrupted run may already have produced a complete Agent-owned file. */
export function generatedFileCoversCases(projectPath: string, group: GenerationGroup): boolean {
  const absolute = resolve(projectPath, group.outputPath);
  if (!existsSync(absolute)) return false;
  try {
    const content = readFileSync(absolute, "utf8");
    return content.includes(GENERATED_TEST_MARKER) && group.cases.every((item) => content.includes(`[CASE:${item.id}]`));
  } catch {
    return false;
  }
}

/** Preload the target and its project-local direct imports so the model does not rediscover obvious dependencies. */
function buildGenerationContext(projectPath: string, sourcePath: string): string {
  const sourceAbsolute = resolve(projectPath, sourcePath);
  if (!existsSync(sourceAbsolute)) return "";
  let source = "";
  try { source = readFileSync(sourceAbsolute, "utf8"); } catch { return ""; }
  const sections = [`### ${sourcePath}\n${source}`];
  const imports = [...source.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("java.") && !name.startsWith("javax.") && !name.startsWith("jakarta.") && !name.startsWith("org."))
    .slice(0, 10);
  for (const imported of imports) {
    const candidate = join(projectPath, "src/main/java", ...imported.split(".")) + ".java";
    if (!existsSync(candidate)) continue;
    try {
      const relativePath = relative(projectPath, candidate).replace(/\\/g, "/");
      sections.push(`### ${relativePath}\n${readFileSync(candidate, "utf8")}`);
    } catch { /* Optional context only. */ }
  }
  const combined = sections.join("\n\n");
  return combined.length > 60_000 ? `${combined.slice(0, 60_000)}\n\n[上下文已截断]` : combined;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  const settled = await Promise.allSettled(runners);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

interface ProviderConfig {
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
  };
  models: Array<{ id: string; reasoning?: boolean }>;
}

interface AiConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider?: string;
  defaultModel?: string;
  /** 用户自定义场景表（覆盖或扩展内置场景）。 */
  scenarios?: Record<string, ScenarioConfig>;
}

function defaultConfigPath(): string {
  const env = process.env.TEST_AGENT_AI_CONFIG;
  if (env) return env;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return join(home, ".test-agent", "ai-config.json");
}

function loadAiConfig(): AiConfig | null {
  const path = defaultConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AiConfig;
    if (!parsed.providers || typeof parsed.providers !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildModel(config: AiConfig, providerId?: string, modelId?: string): { model: Model<"openai-completions">; apiKey: string } | null {
  const pid = providerId ?? config.defaultProvider ?? Object.keys(config.providers)[0];
  const provider = config.providers[pid];
  if (!provider) return null;
  const mid = modelId ?? config.defaultModel ?? provider.models[0]?.id;
  const modelDef = provider.models.find((m) => m.id === mid);
  if (!modelDef) return null;
  const model: Model<"openai-completions"> = {
    id: modelDef.id,
    name: modelDef.id,
    provider: pid,
    api: "openai-completions",
    baseUrl: provider.baseUrl,
    reasoning: modelDef.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32768,
    ...(provider.compat ? { compat: provider.compat } : {}),
  };
  return { model, apiKey: provider.apiKey };
}

// ---------------------------------------------------------------------------
// Harness tool → Agent tool 适配
// ---------------------------------------------------------------------------

function bindToolContext<TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, any, TDetails>,
  context: ExecutionToolContext,
): AgentTool<any, TDetails> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    async execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

/**
 * 根据场景配置的工具列表，构造 AgentTool 数组。
 * 只注入场景允许的工具，未列出的工具不注入 Agent。
 */
function buildToolsForScenario(
  scenario: ScenarioConfig,
  testToolContext: TestToolContext,
  execContext: ExecutionToolContext,
  testTypes?: readonly TestType[],
  projectKind: ProjectKind = 'unknown',
  executionOnly = false,
): AgentTool<any>[] {
  const toolSet = new Set(scenario.tools);
  const allowedTestTools = allowedTestToolNamesForProject(testTypes, projectKind);
  const tools: AgentTool<any>[] = [];

  // 测试工具
  const allTestTools = createTestTools(testToolContext);
  for (const tool of allTestTools) {
    if (!toolSet.has(tool.name)) continue;
    if (allowedTestTools && !allowedTestTools.has(tool.name)) continue;
    tools.push(tool);
  }
  // 通用工具
  if (!executionOnly && toolSet.has("read")) tools.push(bindToolContext(createReadTool(), execContext));
  if (!executionOnly && toolSet.has("write")) tools.push(bindToolContext(createWriteTool(), execContext));
  if (!executionOnly && toolSet.has("edit")) tools.push(bindToolContext(createEditTool(), execContext));

  return tools;
}

// ---------------------------------------------------------------------------
// 测试工具名 → TestType 映射
// ---------------------------------------------------------------------------

const TEST_TOOL_NAMES = new Set(["maven_test", "node_test", "playwright_test", "api_test", "reflect_test"]);

function isTestTool(toolName: string): boolean {
  return TEST_TOOL_NAMES.has(toolName);
}

function toolToTestType(toolName: string): TestType | null {
  switch (toolName) {
    case "maven_test":
    case "node_test":
    case "reflect_test":
      return "unit";
    case "playwright_test":
      return "ui";
    case "api_test":
      return "api";
    default:
      return null;
  }
}

type RawCaseResult = { caseId: string; status: "passed" | "failed" | "skipped"; evidence: string };

/**
 * 将工具返回的真实测试名回链到计划用例。
 * 仅接受显式稳定 ID，禁止根据标题或测试总数推断。
 */
export function linkCaseResultsToPlan(cases: TestCase[] | undefined, results: RawCaseResult[]): RawCaseResult[] {
  if (!cases?.length || !results.length) return [];
  return results.flatMap((result) => {
    const raw = result.caseId.trim();
    const matched = cases.find((item) =>
      raw === item.id || raw.startsWith(`${item.id}#`) || raw.includes(`[CASE:${item.id}]`) || raw.includes(`case_${item.id}`),
    );
    return matched ? [{ ...result, caseId: matched.id }] : [];
  });
}

// ---------------------------------------------------------------------------
// 场景推断：按 GUI 选择的 testTypes 选专用场景
// ---------------------------------------------------------------------------

/**
 * 按 GUI 选择的 testTypes 推断专用场景。
 *
 * - 单选 UI → ui-test（只给 playwright_test，聚焦 Playwright）
 * - 单选 API → api-test（只给 api_test，聚焦接口测试）
 * - 单选 unit → unit-test（只给 maven_test/node_test，聚焦单元测试）
 * - 多选或空 → undefined（走默认 generate-and-run 通用场景）
 *
 * 设计依据：用户在 GUI 选的是"测什么"，不是"怎么测"。单选时用专用
 * 场景的 systemPrompt 更聚焦，工具集更窄，LLM 误用概率更低。多选时
 * 通用场景 + testTypes 裁剪工具（见 buildToolsForScenario）。
 */
function inferScenarioFromTestTypes(testTypes: readonly TestType[] | undefined): string | undefined {
  if (!testTypes || testTypes.length === 0) return undefined;
  if (testTypes.length === 1) {
    switch (testTypes[0]) {
      case "ui":
        return "ui-test";
      case "api":
        return "api-test";
      case "unit":
        return "unit-test";
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * testTypes 允许的测试工具名集合（用于多选时裁剪工具集）。
 * 单选时专用场景已限定工具，不需要裁剪；多选时通用场景工具全量，按此裁剪。
 */
function allowedTestToolNames(testTypes: readonly TestType[] | undefined): Set<string> | undefined {
  if (!testTypes || testTypes.length === 0) return undefined;
  const allowed = new Set<string>();
  for (const type of testTypes) {
    switch (type) {
      case "unit":
        allowed.add("maven_test");
        allowed.add("node_test");
        allowed.add("reflect_test");
        break;
      case "ui":
        allowed.add("playwright_test");
        break;
      case "api":
        allowed.add("api_test");
        break;
      case "regression":
        // regression 语义是全回归，跑全部已有测试，映射所有测试工具
        allowed.add("maven_test");
        allowed.add("node_test");
        allowed.add("playwright_test");
        allowed.add("api_test");
        break;
    }
  }
  return allowed;
}

/** 项目清单是测试适配器的硬边界，避免 Node 子项目误调 Maven/JVM 工具。 */
export function allowedTestToolNamesForProject(
  testTypes: readonly TestType[] | undefined,
  projectKind: ProjectKind,
): Set<string> | undefined {
  const byType = allowedTestToolNames(testTypes);
  const byProject = new Set<string>(
    projectKind === 'node'
      ? ['node_test', 'playwright_test', 'api_test']
      : projectKind === 'maven'
        ? ['maven_test', 'reflect_test', 'api_test']
        : projectKind === 'gradle'
          ? ['maven_test', 'api_test']
          : ['maven_test', 'node_test', 'playwright_test', 'api_test', 'reflect_test'],
  );
  if (!byType) return byProject;
  return new Set([...byType].filter((name) => byProject.has(name)));
}

const GENERATED_TEST_ROOTS = ['.test-agent', 'tests', 'test', 'e2e', 'src/test', 'src/__tests__'];
const GENERATED_TEST_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.java', '.kt', '.groovy']);

/** 只有磁盘上的测试产物确实包含当前计划 ID，才允许跳过测试准备阶段。 */
export function missingGeneratedCaseIds(projectPath: string, cases: TestCase[]): string[] {
  const expected = cases.filter((item) => item.layer === 'unit' || item.layer === 'ui').map((item) => item.id);
  if (expected.length === 0) return [];
  const found = new Set<string>();
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!GENERATED_TEST_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      try {
        if (statSync(path).size > 2_000_000) continue;
        const text = readFileSync(path, 'utf8');
        for (const id of expected) if (text.includes(id)) found.add(id);
      } catch { /* unreadable generated file: treat its IDs as missing */ }
    }
  };
  for (const root of GENERATED_TEST_ROOTS) visit(join(resolve(projectPath), ...root.split('/')));
  return expected.filter((id) => !found.has(id));
}

// ---------------------------------------------------------------------------
// 报告聚合
// ---------------------------------------------------------------------------

/**
 * 从 tool_execution_end 事件收集的 TestToolDetails 聚合为 AgentRunResult。
 *
 * 每个 test tool 可能被调用多次（失败→修复→重跑），取每个 toolName 的最后一次结果。
 * lanes 按 TestType 合并（maven_test 和 node_test 都映射到 unit）。
 */
function aggregateReport(toolResults: TestToolDetails[], cases?: TestCase[], timeline?: TimelineEntry[]): AgentRunResult {
  // 按 tool 分组，取最后一次有测试数据的结果（跳过 0 tests 的空跑，避免覆盖前面的真实结果）
  const latest = new Map<string, TestToolDetails>();
  for (const r of toolResults) {
    const existing = latest.get(r.tool);
    // 优先保留有测试数据的结果；如果新结果有测试数据则覆盖，否则只在没已有结果时存
    if (r.tests > 0) {
      latest.set(r.tool, r);
    } else if (!existing) {
      latest.set(r.tool, r);
    }
  }

  // 聚合 report + 结构化产物（screenshots/recording/uiSteps）
  let passed = 0;
  let failed = 0;
  let coverage: number | null = null;
  let branchCoverage: number | null = null;
  let coverageEvidence: AgentRunResult['report']['coverageEvidence'];
  const screenshots: string[] = [];
  let recording: { video?: string; trace?: string } | undefined;
  const uiSteps: NonNullable<TestToolDetails["uiSteps"]> = [];
  const caseResults: NonNullable<AgentRunResult['report']['caseResults']> = [];
  for (const r of latest.values()) {
    passed += r.pass;
    failed += r.fail;
    if (r.coverage !== null) coverage = r.coverage;
    if (r.branchCoverage !== null && r.branchCoverage !== undefined) branchCoverage = r.branchCoverage;
    if (r.coverageEvidence) coverageEvidence = r.coverageEvidence;
    if (r.screenshots) screenshots.push(...r.screenshots);
    if (r.recording) recording = r.recording;
    if (r.uiSteps) uiSteps.push(...r.uiSteps);
    if (r.caseResults) {
      caseResults.push(...linkCaseResultsToPlan(cases, r.caseResults).map((item) => ({ ...item, tool: r.tool })));
    }
  }

  // 构造 lanes（按 TestType 合并，同一 type 有多个工具时任一失败则 lane 失败）
  const laneMap = new Map<TestType, AgentLaneResult>();
  for (const [toolName, r] of latest) {
    const type = toolToTestType(toolName);
    if (!type) continue;
    const existing = laneMap.get(type);
    const status: "passed" | "failed" = r.ok ? "passed" : "failed";
    const summary = `${r.pass}/${r.tests} 通过${r.fail > 0 ? `，${r.fail} 失败` : ""}`;
    if (!existing) {
      laneMap.set(type, { type, status, summary });
    } else if (status === "failed") {
      // 同 type 已有结果，当前失败 → 合并为失败
      laneMap.set(type, { type, status: "failed", summary: `${existing.summary}；${summary}` });
    }
  }

  // 结构化产物聚合为 fullReport（GUI 读 outcome.fullReport 展示截图/录像/步骤/时间线）
  const hasTimeline = timeline && timeline.length > 0;
  const fullReport: AgentFullReport | undefined =
    screenshots.length > 0 || recording || uiSteps.length > 0 || hasTimeline
      ? {
          screenshots: [...new Set(screenshots)],
          ...(recording ? { recording } : {}),
          ...(uiSteps.length > 0 ? { uiSteps } : {}),
          ...(hasTimeline ? { timeline } : {}),
        }
      : undefined;

  return {
    lanes: [...laneMap.values()],
    report: { passed, failed, coverage, ...(branchCoverage !== null ? { branchCoverage } : {}), ...(coverageEvidence ? { coverageEvidence } : {}), ...(caseResults.length ? { caseResults } : {}) },
    artifacts: [],
    ...(cases && cases.length > 0 ? { cases } : {}),
    ...(fullReport ? { fullReport } : {}),
  };
}

/** Reject malformed plans and plans that silently omit a selected test layer. */
export function validatePlanCoverage(input: TaskInput, cases: TestCase[]): void {
  if (cases.length === 0) throw new Error('计划完整性门禁未通过：没有测试用例')

  const issues: string[] = []
  const seenIds = new Set<string>()
  for (const [index, item] of cases.entries()) {
    const label = item.id?.trim() || `第 ${index + 1} 条用例`
    const id = item.id?.trim() ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      issues.push(`${label} 的 ID 非法（仅允许 1-64 位字母、数字、下划线和连字符）`)
    } else if (seenIds.has(id)) {
      issues.push(`用例 ID 重复：${id}`)
    }
    seenIds.add(id)

    if (!item.title?.trim()) issues.push(`${label} 缺少标题`)
    if (!item.scenario?.trim()) issues.push(`${label} 缺少场景描述`)
    if (!Array.isArray(item.steps) || item.steps.length === 0 || item.steps.some((step) => !String(step).trim())) {
      issues.push(`${label} 缺少有效执行步骤`)
    }
    if (!item.expected?.trim()) issues.push(`${label} 缺少可验证的预期结果`)
    if (item.layer !== 'unit' && item.layer !== 'api' && item.layer !== 'ui') {
      issues.push(`${label} 使用了非法测试层级：${String(item.layer)}`)
    }
    if (item.layer === 'api') {
      if (!item.method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(item.method.toUpperCase())) issues.push(`${label} 缺少有效 HTTP 方法`)
      if (!item.path?.startsWith('/')) issues.push(`${label} 缺少有效 API 路径`)
      if (!Number.isInteger(item.expectedStatus) || (item.expectedStatus ?? 0) < 100 || (item.expectedStatus ?? 0) > 599) issues.push(`${label} 缺少有效期望状态码`)
      const hasTextAssertion = item.expectedBodyContains?.some((value) => value.trim()) === true
      const hasJsonAssertion = Boolean(item.expectedJsonSubset && Object.keys(item.expectedJsonSubset).length > 0)
      if (!hasTextAssertion && !hasJsonAssertion) issues.push(`${label} 缺少响应内容断言（expectedBodyContains 或 expectedJsonSubset）`)
    }
    const structuredTarget = item.structuredScenario?.target
    const hasStructuredTarget = Boolean(structuredTarget?.className?.trim() && structuredTarget?.method?.trim())
    if (!item.target?.trim() && !hasStructuredTarget) issues.push(`${label} 缺少明确的被测目标`)
  }
  if (issues.length > 0) {
    throw new Error(`计划质量门禁未通过：${issues.join('；')}`)
  }

  const plannedLayers = new Set(cases.map((item) => item.layer))
  const requiredLayers = [...new Set(input.testTypes.filter((type): type is 'unit' | 'api' | 'ui' => type === 'unit' || type === 'api' || type === 'ui'))]
  const missing = requiredLayers.filter((layer) => !plannedLayers.has(layer))
  if (missing.length > 0) {
    throw new Error(`计划完整性门禁未通过：所选测试层级没有用例：${missing.join(', ')}`)
  }
}

/** Tell case-designer exactly which concrete layers the user selected. */
export function buildCaseDesignScopePrompt(testTypes: readonly TestType[]): string {
  const concrete = [...new Set(testTypes.map((type) => type === 'regression' ? 'unit' : type))]
    .filter((type): type is 'unit' | 'api' | 'ui' => type === 'unit' || type === 'api' || type === 'ui')
  const labels: Record<'unit' | 'api' | 'ui', string> = { unit: '单元测试', api: '接口测试', ui: 'UI 测试' }
  const selected = concrete.map((type) => `${type}（${labels[type]}）`).join('、')
  const uiRules = concrete.includes('ui')
    ? `\n- UI 用例必须写 \"layer\": \"ui\"，steps 至少包含页面导航、用户交互和可验证的页面断言；target 指向实现该页面或交互的源码 path:line。`
    : ''
  const apiRules = concrete.includes('api')
    ? `\n- API 用例必须写 \"layer\": \"api\"，并包含 method、path、expectedStatus 及响应内容断言。`
    : ''
  return `## 本次用户选择的测试层级（强约束）
仅设计以下层级：${selected || '未指定'}。
- 每个已选层级至少输出 1 条用例；不得遗漏任何已选层级。
- 不得输出未选择层级的用例。${uiRules}${apiRules}
- layer 字段只能使用 unit / api / ui，并且必须与用例实际执行方式一致。`
}

/** Prevent a completed task from claiming success when selected test lanes produced no real result. */
export function validateExecutionOutcome(input: TaskInput, result: AgentRunResult): void {
  const executed = result.report.passed + result.report.failed
  if (executed < 1) {
    throw new Error('执行证据门禁未通过：测试工具没有产出任何通过或失败结果；全跳过、空测试集或仅启动工具不能视为测试完成')
  }
  const present = new Set(result.lanes.map((lane) => lane.type))
  const required = [...new Set(input.testTypes.filter((type) => type !== 'regression'))]
  const missing = required.filter((type) => !present.has(type))
  if (missing.length > 0) {
    throw new Error(`执行证据门禁未通过：所选测试通道未执行：${missing.join(', ')}`)
  }
  const emptyRequiredLanes = required.filter((type) => {
    const matching = result.lanes.filter((lane) => lane.type === type)
    return matching.length > 0 && matching.every((lane) => /(?:^|；)0\/0 通过(?:；|$)/.test(lane.summary))
  })
  if (emptyRequiredLanes.length > 0) {
    throw new Error(`执行证据门禁未通过：${emptyRequiredLanes.join(', ')} 通道未收集到任何测试（0/0）；请查看该测试工具的原始输出，不应继续按用例 ID 缺失诊断`)
  }
  const factlessFailures = result.lanes.filter((lane) => lane.status === 'failed' && result.report.failed === 0)
  if (factlessFailures.length > 0) {
    throw new Error(`执行证据门禁未通过：${factlessFailures.map((lane) => lane.type).join(', ')} 通道失败，但没有结构化失败结果`)
  }
  const plannedCases = result.cases ?? []
  if (plannedCases.length > 0) {
    const caseResults = result.report.caseResults ?? []
    const allowedTools: Record<'unit' | 'api' | 'ui', ReadonlySet<string>> = {
      unit: new Set(['node_test', 'maven_test', 'reflect_test']),
      api: new Set(['api_test']),
      ui: new Set(['playwright_test'])
    }
    const evidenceFor = (planned: TestCase) => caseResults.filter((item) =>
      item.caseId === planned.id
      && item.status !== 'skipped'
      && item.evidence.trim().length > 0
      && allowedTools[planned.layer].has(item.tool))
    const missingCaseEvidence = plannedCases.filter((item) => evidenceFor(item).length === 0).map((item) => item.id)
    if (missingCaseEvidence.length > 0) {
      throw new Error(`执行证据门禁未通过：计划用例缺少对应测试层级的可核验执行结果：${missingCaseEvidence.join(', ')}`)
    }
    const failedPlanned = plannedCases.filter((item) => evidenceFor(item).some((evidence) => evidence.status === 'failed'))
    if (failedPlanned.length > 0 && result.report.failed === 0) {
      throw new Error(`执行证据门禁未通过：逐用例证据显示失败，但汇总失败数为 0：${failedPlanned.map((item) => item.id).join(', ')}`)
    }
    if (plannedCases.length > executed) {
      throw new Error(`执行证据门禁未通过：执行汇总仅 ${executed} 条，少于计划用例 ${plannedCases.length} 条`)
    }
  }
  if (input.testTypes.includes('ui')) {
    const uiSteps = result.fullReport?.uiSteps ?? []
    const screenshots = result.fullReport?.screenshots ?? []
    if (uiSteps.length === 0 && screenshots.length === 0) {
      throw new Error('执行证据门禁未通过：UI 通道没有步骤或截图证据')
    }
  }
  if (input.testTypes.includes('api')) {
    const apiEvidence = (result.report.caseResults ?? []).filter((item) => item.tool === 'api_test' && /HTTP\s+\d{3}/i.test(item.evidence))
    if (apiEvidence.length === 0) throw new Error('执行证据门禁未通过：API 通道没有真实 HTTP 响应证据')
    const plannedApiIds = plannedCases.filter((item) => item.layer === 'api').map((item) => item.id)
    const evidenced = new Set(apiEvidence.filter((item) => item.status !== 'skipped').map((item) => item.caseId))
    const missingApi = plannedApiIds.filter((id) => !evidenced.has(id))
    if (missingApi.length > 0) throw new Error(`执行证据门禁未通过：API 用例缺少 HTTP 结果：${missingApi.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Flaky 重跑执行器（PRD 功能二：可疑用例重跑 N 次）
// ---------------------------------------------------------------------------

/**
 * 创建重跑执行器：重跑测试套件，判定指定用例是否通过。
 *
 * 根据执行阶段使用的测试工具选择对应的 validator 函数重跑：
 * - node_test：runNodeUnitTests，用 failedCases 做用例级匹配
 * - maven_test：runMavenUnitTests，用聚合结果（套件通过→用例通过）
 * - playwright_test：runPlaywrightUiTests，用 uiSteps 做用例级匹配
 *
 * 用例级匹配策略：套件通过→该用例通过；套件失败→检查用例标题是否出现在
 * 失败列表中（includes 模糊匹配）。无法做用例级匹配时，保守返回 false。
 */
function createRerunExecutor(
  testToolContext: TestToolContext,
  usedTools: string[],
): RerunExecutor | undefined {
  const { projectPath, sandbox, extraWritableDirs } = testToolContext;

  if (usedTools.includes("node_test")) {
    return async (_caseId, caseTitle) => {
      const outcome = runNodeUnitTests(projectPath, sandbox, extraWritableDirs);
      if (outcome.ok) return true;
      if (outcome.failedCases && outcome.failedCases.length > 0) {
        return !outcome.failedCases.some(
          (fc) => fc.name === caseTitle || fc.name.includes(caseTitle) || caseTitle.includes(fc.name),
        );
      }
      return false;
    };
  }

  if (usedTools.includes("maven_test")) {
    return async (_caseId, _caseTitle) => {
      try {
        const outcome = await runMavenUnitTests(projectPath, undefined, sandbox, extraWritableDirs);
        return outcome.ok;
      } catch {
        return false;
      }
    };
  }

  // reflect_test 重跑：从 caseId 定位持久化场景文件 .test-agent/scenarios/<caseId>.json
  // 依赖 scenario.id 与 caseId 硬对齐（见 r1-反射引擎-实现方案.md 6.1）
  if (usedTools.includes("reflect_test")) {
    return async (caseId, _caseTitle) => {
      const scenarioFile = join(projectPath, ".test-agent", "scenarios", `${caseId}.json`);
      if (!existsSync(scenarioFile)) return false; // 无持久化场景则跳过
      try {
        const spec = reflectMavenCommandSpec(projectPath, scenarioFile);
        const outcome = await runMavenCommand(projectPath, spec, undefined, sandbox, extraWritableDirs);
        return outcome.ok;
      } catch {
        return false;
      }
    };
  }

  if (usedTools.includes("playwright_test")) {
    return async (_caseId, caseTitle) => {
      const outcome = runPlaywrightUiTests(projectPath, {}, sandbox, extraWritableDirs);
      if (outcome.ok) return true;
      if (outcome.uiSteps && outcome.uiSteps.length > 0) {
        return !outcome.uiSteps.some(
          (s) => s.status === "failed" && (s.name === caseTitle || s.name.includes(caseTitle) || caseTitle.includes(s.name)),
        );
      }
      return false;
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class Runner implements AgentAdapter {
  readonly name = "ai-native";

  /** Escalation handler（run() 时从 context 存入，供 runScout/runCaseDesign 使用，它们无 context 参数）。 */
  private escalationHandler?: EscalationHandler;

  constructor(
    private readonly config: AiConfig,
    private readonly providerId?: string,
    private readonly modelId?: string,
    private readonly scenarioName?: string,
  ) {}

  /** Backward-compat：一次性计划+执行（worker-mode 等非分阶段调用方用）。 */
  async run(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    // 存储 escalation handler（供 runScout/runCaseDesign 使用，它们无 context 参数）
    if (context?.escalationHandler) {
      this.escalationHandler = context.escalationHandler as EscalationHandler;
    }

    // Fitness-driven 开关：context.fitnessDriven=true 时用 runFitnessDrivenExecute 替代 runExecute
    const exec = (cases: TestCase[]): Promise<AgentRunResult> =>
      context?.fitnessDriven
        ? this.runFitnessDrivenExecute(input, cases, emit, signal, context)
        : this.runExecute(input, cases, emit, signal, context);

    // 质量趋势看板聚合（PRD 功能二片3）：任务完成后聚合一次，不在 runExecute 内部（避免 fitness 多轮污染）
    const execWithMetrics = async (cases: TestCase[]): Promise<AgentRunResult> => {
      const result = await exec(cases);
      try {
        const metricsProjectHash = computeProjectHash(input.projectPath);
        const metricsBaseDir = join(input.projectPath, ".test-agent", "metrics");
        const timelineDuration = sumTimelineDuration(result.fullReport?.timeline ?? undefined);
        const metricsInput = extractMetricsInput(
          result.report,
          new Date().toISOString(),
          cases.length,
          timelineDuration,
        );
        appendTaskToWeekly(metricsBaseDir, metricsProjectHash, metricsInput);
      } catch (err) {
        emit(log("warning", `质量趋势聚合异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "GENERATING"));
      }
      return result;
    };

    // Coordinator 调度层（planner-worker 架构，coordinatorEnabled=true 启用，默认 false 向后兼容）
    if (context?.coordinatorEnabled) {
      const { Coordinator } = await import("./coordinator.js");
      // 切片 6C：emitMessage 回调发 coordinator-message 事件（GUI dispatchMessages 从真实记录读）。
      const coordinator = new Coordinator(
        this,
        context.escalationHandler as EscalationHandler | undefined,
        (msg) => {
          emit({ type: "coordinator-message", messageType: msg.type, from: msg.from, to: msg.to, content: msg.content, role: "planner" });
        },
      );
      return coordinator.run(input, emit, signal, context);
    }

    // 角色分工架构：scout → case-designer → execute（替代旧 runPlan → execute）
    // 向后兼容：无 runScout/runCaseDesign 时降级旧 runPlan（cimicode 等旧 adapter）
    if (typeof this.runScout === "function" && typeof this.runCaseDesign === "function") {
      // 用例库 100% 命中检查（review P2-4）：命中时跳过 scout + case-designer LLM，直接执行
      const reused = this.checkLibraryReuse(input, emit);
      if (reused) {
        this.persistScenariosIfNeeded(input, reused, emit);  // P4-7
        return execWithMetrics(reused);
      }
      const scoutResult = await this.runScout(input, emit, signal);
      if (!scoutResult?.report) throw new Error("scout 未产出侦察报告，无法继续用例设计");
      const planResult = await this.runCaseDesign(input, scoutResult.report, emit, signal);
      if (planResult.cases.length === 0) {
        throw new Error("用例设计未产出任何测试用例，无法继续执行。");
      }
      return execWithMetrics(planResult.cases);
    }
    // 降级：旧单 Agent 两阶段（runPlan → runExecute）
    const planResult = await this.runPlan(input, emit, signal);
    if (planResult.cases.length === 0) {
      throw new Error("计划阶段未产出任何测试用例，无法继续执行。");
    }
    return execWithMetrics(planResult.cases);
  }

  /**
   * 用例库 100% 命中检查（review P2-4）。
   *
   * codeHash 匹配 + 库中有用例 → 返回标记为 reuse 的用例列表，调用方跳过 scout + LLM。
   * 不匹配或库空 → 返回 undefined，调用方走正常 scout → case-designer 流程。
   */
  private checkLibraryReuse(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
  ): TestCase[] | undefined {
    const library = new CaseLibrary(input.projectPath);
    const storedCodeHash = library.getStoredCodeHash();
    if (!storedCodeHash) return undefined;
    const { codeHash: currentCodeHash } = computeCodeHash(input.projectPath);
    if (storedCodeHash.codeHash !== currentCodeHash) return undefined;
    const storedCases = library.load().map((s) => s.case);
    if (storedCases.length === 0) return undefined;
    const reusedCases = storedCases.map((c) => ({ ...c, source: "reuse" as const }));
    emit(log("info", `用例库命中（code hash 匹配），复用 ${reusedCases.length} 条用例，跳过 scout + 用例设计`, "PLANNING"));
    return reusedCases;
  }

  /**
   * P4-7: 持久化结构化场景到 .test-agent/scenarios/<caseId>.json。
   * 同步 structuredScenario.id 与 case.id（修复 ID 重分配后不一致），
   * 然后调 persistScenarios 落盘。非 reflect 模式或无 structuredScenario 时 no-op。
   */
  private persistScenariosIfNeeded(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
  ): void {
    if (input.testStrategy !== 'reflect') return;
    const scenarios = cases
      .filter((c) => c.structuredScenario)
      .map((c) => ({ ...c.structuredScenario!, id: c.id }));
    if (scenarios.length === 0) return;
    try {
      persistScenarios(input.projectPath, scenarios);
      emit(log("info", `已持久化 ${scenarios.length} 条场景到 .test-agent/scenarios/`, "PLANNING", "case-designer"));
    } catch (err) {
      emit(log("warning", `场景持久化失败，已跳过：${err instanceof Error ? err.message : String(err)}`, "PLANNING", "case-designer"));
    }
  }

  /** 场景+模型+输出目录——runPlan 和 runExecute 共用的初始化。
   *
   * suffix 用于并行隔离：fan-out 子代理传入 testType 后缀追加到 stamp（照现有 stamp 模式），
   * 防并行子代理共享同一 results 目录（照 pi-subagents runs.all fresh-context 隔离）。 */
  private initRun(input: TaskInput, suffix?: string) {
    const scenarioName =
      this.scenarioName ??
      (input.testStrategy === 'reflect' ? 'reflect-test' : undefined) ??
      inferScenarioFromTestTypes(input.testTypes) ??
      process.env.TEST_AGENT_SCENARIO ??
      "generate-and-run";
    const scenario = getScenario(scenarioName, this.config.scenarios);
    const built = buildModel(this.config, scenario.providerId ?? this.providerId, scenario.modelId ?? this.modelId);
    if (!built) throw new Error("内置 LLM: 无法从 ai-config.json 构造模型，请检查配置");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-") + (suffix ? `-${suffix}` : "");
    const outputDirectory = join(input.projectPath, ".test-agent", "results", stamp);
    mkdirSync(outputDirectory, { recursive: true });
    const testToolContext: TestToolContext = {
      projectPath: input.projectPath,
      extraWritableDirs: [input.projectPath],
    };
    const env = new NodeExecutionEnv({ cwd: resolve(input.projectPath) });
    const execContext: ExecutionToolContext = { env };
    const streamFn = streamOpenAICompletionsSimple as unknown as StreamFn;
    return { scenario, built, outputDirectory, testToolContext, execContext, streamFn };
  }

  /** 创建事件处理器——转发结构化事件 + 收集 timeline/toolResults。 */
  private makeEventHandler(
    emit: (event: AgentEvent) => void,
    phase: "planning" | "executing",
    state: { eventLog: string[]; toolResults: TestToolDetails[]; turnCounter: { count: number }; timeline: TimelineEntry[]; toolTimers: Map<string, number> },
    role: string,
  ) {
    const { eventLog, toolResults, turnCounter, timeline, toolTimers } = state;
    function toolToStage(toolName: string): string {
      if (toolName === "read") return "读取源码";
      if (toolName === "write") return "生成测试代码";
      if (toolName === "edit") return "调整测试代码";
      if (toolName === "escalate") return "人工确认";
      if (isTestTool(toolName)) return "执行测试";
      return toolName;
    }
    return function handleAgentEvent(event: any): void {
      switch (event.type) {
        case "agent_start":
          emit({ type: "agent_start", role });
          eventLog.push("[agent_start]");
          break;
        case "turn_start":
          turnCounter.count++;
          emit({ type: "turn_start", turn: turnCounter.count, role });
          break;
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            emit({ type: "message_update", text: ame.delta, role });
          }
          break;
        }
        case "tool_execution_start":
          emit({
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            role,
          });
          eventLog.push(`[turn ${turnCounter.count}] tool_start: ${event.toolName}`);
          toolTimers.set(event.toolCallId, Date.now());
          break;
        case "tool_execution_end": {
          emit({
            type: "tool_execution_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            role,
          });
          const startedAt = toolTimers.get(event.toolCallId);
          toolTimers.delete(event.toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          if (event.isError) {
            eventLog.push(`[turn ${turnCounter.count}] tool ${event.toolName} 错误`);
          } else {
            eventLog.push(`[turn ${turnCounter.count}] tool_end: ${event.toolName}`);
          }
          // 记录到时间线
          const stage = toolToStage(event.toolName);
          const details = isTestTool(event.toolName)
            ? (event.result as { details?: TestToolDetails })?.details
            : undefined;
          timeline.push({
            stage,
            status: event.isError ? "failed" : details && !details.ok ? "failed" : "passed",
            startedAt: startedAt ? new Date(startedAt).toISOString() : new Date().toISOString(),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(details
              ? { message: `${event.toolName}: ${details.pass}/${details.tests} 通过` }
              : event.toolName === "escalate"
                ? { message: event.isError ? "等待答复超时，已按保守方案继续" : "已收到人工答复" }
                : {}),
          });
          // 收集测试工具结果（仅执行阶段）
          if (isTestTool(event.toolName) && !event.isError) {
            const det = details;
            if (det) {
              toolResults.push(det);
              emit(log(
                det.ok ? "success" : "warning",
                `${event.toolName}: ${det.pass}/${det.tests} 通过${det.fail > 0 ? `，${det.fail} 失败` : ""}${det.coverage !== null ? `，覆盖率 ${det.coverage}%` : ""}`,
                "GENERATING",
                role,
              ));
            }
          }
          break;
        }
        case "turn_end":
          emit({ type: "turn_end", turn: turnCounter.count, role });
          break;
        case "agent_end":
          emit({ type: "agent_end", role });
          eventLog.push(`[agent_end] 共 ${turnCounter.count} 轮`);
          break;
        default:
          break;
      }
    };
  }

  // ===== 阶段0：侦察（read-only，LLM 快速摸清项目 → 产出侦察报告）=====
  async runScout(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<ScoutResult> {
    const { built, execContext, streamFn } = this.initRun(input);
    const { model, apiKey } = built;

    // 从 agents/ 目录加载 scout 角色配置
    const agentsDir = resolveAgentsDir();
    const roles = loadRoles(agentsDir);
    const role = roles["scout"];
    if (!role) throw new Error("scout 角色配置未找到（agents/scout.md）");

    // 存储 escalation handler（若从 context 传入）
    if (context?.escalationHandler) {
      this.escalationHandler = context.escalationHandler as EscalationHandler;
    }

    emit(log("info", `启动侦察角色（scout）…`, "PLANNING", "scout"));

    // turn-budget：轮次上限
    const turnBudget = role.turnBudget ?? { maxTurns: 6, graceTurns: 1 };
    const systemPrompt = appendTurnBudgetSystemPrompt(role.systemPrompt, turnBudget);

    // capability-ceiling：声明式 ceiling + agent 名门禁
    const sessionId = randomUUID();
    let ceilingHandle: { dispose(): void } | undefined;
    try {
      ceilingHandle = registerSubagentCapabilityCeiling({
        sessionId,
        source: "test-agent.scout",
        ceiling: { allowedTools: role.tools, denyExtensions: true },
      });
      assertAgentAllowedByCapabilityCeiling("scout", resolveSubagentCapabilityCeiling(sessionId));
    } catch {
      ceilingHandle = undefined;
    }

    // 工具注入：read + bash（只读检查）
    const tools: AgentTool<any>[] = [
      bindToolContext(createReadTool(), execContext),
      bindToolContext(createBashTool(), execContext),
    ];

    // escalation 工具注入（角色 .md 配 escalation:true 且 handler 可用时）
    if (role.escalation && this.escalationHandler) {
      tools.push(createEscalateTool(this.escalationHandler, "scout"));
    }

    const scoutAgent = new Agent({
      streamFn,
      getApiKey: () => apiKey,
      initialState: {
        systemPrompt,
        model,
        tools,
        thinkingLevel: role.thinking ?? "off",
      },
      shouldStopAfterTurn: (context: any) => {
        const turnCount = context.turn;
        const hasToolCalls = context.message.content.some((p: any) => p.type === "toolCall");
        const terminalStop = !hasToolCalls;
        try {
          const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);
          if (decision === "abort") {
            console.warn(turnBudgetExceededMessage(turnBudget, turnCount));
            return true;
          }
        } catch {
          // turn-budget 异常不阻断
        }
        return false;
      },
    });

    // 注册 Agent 到 escalation handler（供 reply 时 steer，§7 不确定点 5）
    if (role.escalation && this.escalationHandler) {
      this.escalationHandler.registerAgent("scout", scoutAgent);
      // 片C：steer 默认关闭，仅 role.escalationSteer=true 时开启
      if (role.escalationSteer) this.escalationHandler.setSteerEnabled("scout", true);
    }

    let scoutTurnCount = 0;
    const unsubScout = scoutAgent.subscribe((event: any) => {
      // 转发关键事件（照 runPlan/runExecute 模式，自己计轮次）
      if (event.type === "agent_start") emit({ type: "agent_start", role: "scout" });
      else if (event.type === "turn_start") { scoutTurnCount++; emit({ type: "turn_start", turn: scoutTurnCount, role: "scout" }); }
      else if (event.type === "turn_end") emit({ type: "turn_end", turn: scoutTurnCount, role: "scout" });
      else if (event.type === "message_update") emit({ type: "message_update", text: event.assistantMessageEvent?.delta ?? "", role: "scout" });
      else if (event.type === "tool_execution_start") emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, role: "scout" });
      else if (event.type === "tool_execution_end") emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, role: "scout" });
    });

    try {
      const projectContext = scanProjectContext(input.projectPath);
      const scoutPrompt = `请对以下项目进行侦察，摸清项目结构、入口点、高风险路径、测试设施现状。\n\n项目路径：${input.projectPath}\n项目上下文：\n${projectContext}`;
      await scoutAgent.prompt(scoutPrompt);
      await scoutAgent.waitForIdle();
    } finally {
      unsubScout();
      ceilingHandle?.dispose();
    }

    if (signal?.aborted) { emit({ type: "agent_end", role: "scout" }); throw new Error("任务已取消"); }

    // 从 LLM 回复提取侦察报告（取最后一条 assistant 消息文本，reasoning 模型 fallback 取 thinking）
    const messages = scoutAgent.state.messages as Message[];
    const report = extractAssistantText(messages);

    if (report.length === 0) {
      // 侦察报告为空——不静默"成功"，报错（防 GUI 以为成功进 case-designer / host-mode 死循环）
      emit(log("error", `侦察完成：侦察报告为空（scout 轮次耗尽未输出文本报告）`, "PLANNING", "scout"));
      emit({ type: "agent_end", role: "scout" });
      return { report, artifacts: [] };
    }
    emit(log("success", `侦察完成：已产出侦察报告`, "PLANNING", "scout"));
    emit({ type: "agent_end", role: "scout" });

    return { report, artifacts: [] };
  }

  // ===== 阶段1：用例设计（read-only，case-designer 角色，读 scout 报告 → 产出 cases）=====
  async runCaseDesign(
    input: TaskInput,
    scoutReport: string,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<PlanResult> {
    const { built, outputDirectory, execContext, streamFn } = this.initRun(input);
    const { model, apiKey } = built;

    // ===== 用例库复用检查（PRD 功能一：命中跳过 LLM 生成） =====
    const library = new CaseLibrary(input.projectPath);
    const storedCodeHash = library.getStoredCodeHash();
    const { codeHash: currentCodeHash, fileHashes: currentFileHashes } = computeCodeHash(input.projectPath);
    if (storedCodeHash && storedCodeHash.codeHash === currentCodeHash) {
      const storedCases = library.load().map((s) => s.case);
      if (storedCases.length > 0) {
        const reusedCases = storedCases.map((c) => ({ ...c, source: "reuse" as const }));
        emit(log("info", `用例库命中（code hash 匹配），复用 ${reusedCases.length} 条用例，跳过 LLM 生成`, "PLANNING", "case-designer"));
        writeFileSync(join(outputDirectory, "test-plan.json"), JSON.stringify(reusedCases, null, 2), "utf8");
        this.persistScenariosIfNeeded(input, reusedCases, emit);  // P4-7
        emit({ type: "planning_end", caseCount: reusedCases.length, cases: reusedCases, role: "case-designer" });
        emit(log("success", `用例设计完成（库复用）：${reusedCases.length} 条用例`, "PLANNING", "case-designer"));
        emit({ type: "agent_end", role: "case-designer" });
        return {
          phase: "plan",
          cases: reusedCases,
          artifacts: [relative(input.projectPath, join(outputDirectory, "test-plan.json"))],
        } as PlanResult;
      }
    }

    // 从 agents/ 目录加载 case-designer 角色配置
    const agentsDir = resolveAgentsDir();
    const roles = loadRoles(agentsDir);
    const role = roles["case-designer"];
    if (!role) throw new Error("case-designer 角色配置未找到（agents/case-designer.md）");

    // 存储 escalation handler（若从 context 传入）
    if (context?.escalationHandler) {
      this.escalationHandler = context.escalationHandler as EscalationHandler;
    }

    emit(log("info", `启动用例设计角色（case-designer）…`, "PLANNING", "case-designer"));

    // turn-budget
    const turnBudget = role.turnBudget ?? { maxTurns: 8, graceTurns: 1 };
    const systemPrompt = appendTurnBudgetSystemPrompt(role.systemPrompt, turnBudget);

    // capability-ceiling
    const sessionId = randomUUID();
    let ceilingHandle: { dispose(): void } | undefined;
    try {
      ceilingHandle = registerSubagentCapabilityCeiling({
        sessionId,
        source: "test-agent.case-designer",
        ceiling: { allowedTools: role.tools, denyExtensions: true },
      });
      assertAgentAllowedByCapabilityCeiling("case-designer", resolveSubagentCapabilityCeiling(sessionId));
    } catch {
      ceilingHandle = undefined;
    }

    // 工具注入：read-only（read + grep/find/ls 用 bash 只读）
    const tools: AgentTool<any>[] = [
      bindToolContext(createReadTool(), execContext),
      bindToolContext(createBashTool(), execContext),
    ];

    // escalation 工具注入（角色 .md 配 escalation:true 且 handler 可用时）
    if (role.escalation && this.escalationHandler) {
      tools.push(createEscalateTool(this.escalationHandler, "case-designer"));
    }

    const designAgent = new Agent({
      streamFn,
      getApiKey: () => apiKey,
      initialState: {
        systemPrompt,
        model,
        tools,
        thinkingLevel: role.thinking ?? "high",
      },
      shouldStopAfterTurn: (context: any) => {
        const turnCount = context.turn;
        const hasToolCalls = context.message.content.some((p: any) => p.type === "toolCall");
        const terminalStop = !hasToolCalls;
        try {
          const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);
          if (decision === "abort") {
            console.warn(turnBudgetExceededMessage(turnBudget, turnCount));
            return true;
          }
        } catch {
          // turn-budget 异常不阻断
        }
        return false;
      },
    });

    // 注册 Agent 到 escalation handler（供 reply 时 steer，§7 不确定点 5）
    if (role.escalation && this.escalationHandler) {
      this.escalationHandler.registerAgent("case-designer", designAgent);
      // 片C：steer 默认关闭，仅 role.escalationSteer=true 时开启
      if (role.escalationSteer) this.escalationHandler.setSteerEnabled("case-designer", true);
    }

    let designTurnCount = 0;
    const handleDesignEvent = (event: any) => {
      if (event.type === "agent_start") emit({ type: "agent_start", role: "case-designer" });
      else if (event.type === "turn_start") { designTurnCount++; emit({ type: "turn_start", turn: designTurnCount, role: "case-designer" }); }
      else if (event.type === "turn_end") emit({ type: "turn_end", turn: designTurnCount, role: "case-designer" });
      else if (event.type === "message_update") emit({ type: "message_update", text: event.assistantMessageEvent?.delta ?? "", role: "case-designer" });
      else if (event.type === "tool_execution_start") emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, role: "case-designer" });
      else if (event.type === "tool_execution_end") emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, role: "case-designer" });
    };

    try {
      const projectContext = scanProjectContext(input.projectPath);
      const openApiSummary = await loadOpenApiSummary(input.openApiUrl, input.projectPath);
      // 注入 scout 侦察报告作为上下文（previousSummary 模式）
      const designPrompt = `你是测试用例设计角色。请基于以下侦察报告和项目信息，设计结构化测试用例。

【⚠️ 设用例前必读——何时 escalate（不得自行合理化）】
读完 scoutReport 后用 read 读取实际代码，遇到以下情况必须调 escalate 工具停下提问，不得为了把任务做完而自行合理化：
- scoutReport 与实际代码矛盾（如 scoutReport 说 Java Spring 但实际是 JS 文件、或 scoutReport 指出的入口/服务在代码里找不到）→ 必须 escalate，不得以实际代码为准自行设计用例
- target 指向的代码不存在或结构有歧义，无法确定被测对象 → escalate
- 需在多个 equally reasonable 的设计方向间选择且影响面大 → escalate
- 任何让你想"猜一下"的用例 → escalate
不要 escalate：常规设计进度/能从代码明确读出答案（前提是 scoutReport 与代码一致无矛盾时）
调 escalate 时：question 写清问题+你看到的现状，fallback 给保守方案建议（超时降级时用）。escalate 是提问非终止，收到降级文本后必须继续设计用例。

## 项目路径
${input.projectPath}

## 项目上下文
${projectContext}

## Scout 侦察报告
${scoutReport}

${buildCaseDesignScopePrompt(input.testTypes)}

${openApiSummary ? `## 已校验的 OpenAPI 接口清单\n${openApiSummary}\n` : ''}

请用 read 工具读取被测源码，用等价类划分、边界值分析、决策表方法论设计测试用例。
每条用例必须包含 target 字段（被测代码 path:line）。
${input.testTypes.includes('api') ? `API 用例还必须包含 method、path、expectedStatus；有请求体时填写 body；按契约填写 expectedBodyContains 或 expectedJsonSubset 作为响应断言。不得只写“成功”。\n` : ''}
输出 JSON 数组。
${input.testStrategy === 'reflect' ? `
## 反射模式（testStrategy=reflect）特殊要求

本任务使用反射场景驱动测试，你不写测试代码——你设计 JSON 场景，由 tester 调 reflect_test 工具确定性执行。

每条用例**必须**包含 structuredScenario 字段（与传统用例的 scenario/expected 并列），结构如下：

\`\`\`json
{
  "structuredScenario": {
    "id": "TC001",
    "target": {
      "className": "全限定类名（从代码读，如 com.cxmt.order.service.OrderService）",
      "method": "方法名"
    },
    "setup": { "springContext": false },
    "params": [
      { "name": "参数名", "type": "全限定参数类型", "value": "参数值或 null" }
    ],
    "assertion": {
      "type": "return",
      "expected": "期望返回值",
      "expectedType": "期望返回值全限定类型"
    }
  }
}
\`\`\`

assertion.type=exception 时用 expectedException/expectedMessage 替代 expected。

### 适用范围
- ✅ Service/Util 计算逻辑 / 参数化边界值 / 异常路径 / 静态方法
- ✅ Spring Service 设 setup.springContext=true（反射引擎通过 SpringApplication.run 加载 Context + getBean）
- ❌ 异步方法 / 复杂 mock 链 / 需完整数据库 fixture（这些用传统 JUnit 路径）

### 关键约束
- target.className 必须是全限定类名（从 read 读到的 import/package 推断）
- params.type 必须是全限定类型名（如 java.lang.String / int / com.cxmt.order.dto.OrderRequest）
- params.value 的 JSON 类型必须与 params.type 匹配（int→number, boolean→boolean, String→string, 自定义对象→JSON object）
- assertion.type=return 时必须填 expected + expectedType
- assertion.type=exception 时必须填 expectedException
- 每条用例的 id 必须与 structuredScenario.id 一致

仍需输出 title/scenario/expected/priority/layer/target 字段（供 GUI 展示和追溯），structuredScenario 是附加字段。
` : ''}
【重要】escalate 是提问非终止——调 escalate 后会收到降级文本（含保守方案），你**必须继续设计用例**，按保守方案或以实际代码为准产出 cases，不得停止设计返回空数组。`;
      await runAgentWithIdleWatchdog({
        agent: designAgent,
        prompt: designPrompt,
        onEvent: handleDesignEvent,
        signal,
        timeoutMs: 3 * 60 * 1000,
        timeoutMessage: "用例设计阶段连续 3 分钟没有新事件，已自动中止；项目分析结果已保留，可重试当前阶段",
        onTimeout: () => emit(log("error", "用例设计阶段连续 3 分钟没有模型或工具事件，已自动中止。项目分析结果已保留，可重试当前阶段。", "PLANNING", "case-designer")),
        isPaused: () => (this.escalationHandler?.pendingCount ?? 0) > 0,
      });
    } finally {
      ceilingHandle?.dispose();
    }

    if (signal?.aborted) { emit({ type: "agent_end", role: "case-designer" }); throw new Error("任务已取消"); }

    // 从 LLM 回复解析 cases（复用 parseCasesFromResponse）
    let cases = parseCasesFromResponse(designAgent.state.messages as Message[]);

    // ===== 增量复用合并（PRD 功能一场景 B：代码变更时复用未变 target 的旧用例） =====
    if (storedCodeHash && storedCodeHash.codeHash !== currentCodeHash) {
      const reusable = library.findReusableCases(currentFileHashes);
      if (reusable.length > 0) {
        const reusableTitles = new Set(reusable.map((c) => c.title));
        const newCases = cases.filter((c) => !reusableTitles.has(c.title));
        cases = [
          ...reusable.map((c) => ({ ...c, source: "reuse" as const })),
          ...newCases.map((c) => ({ ...c, source: "incremental" as const })),
        ];
        emit(log("info", `增量复用 ${reusable.length} 条旧用例 + 新生成 ${newCases.length} 条`, "PLANNING", "case-designer"));
      }
    }

    // 用例 ID 重分配为稳定 hash（projectHash + title）
    const projectHash = library.projectHashValue;
    cases = cases.map((c) => {
      const id = computeCaseId(projectHash, c.title);
      return { ...c, id, ...(c.structuredScenario ? { structuredScenario: { ...c.structuredScenario, id } } : {}) };
    });

    if (cases.length > 0) validatePlanCoverage(input, cases);
    writeFileSync(join(outputDirectory, "test-plan.json"), JSON.stringify(cases, null, 2), "utf8");
    this.persistScenariosIfNeeded(input, cases, emit);  // P4-7
    emit({ type: "planning_end", caseCount: cases.length, cases, role: "case-designer" });

    if (cases.length === 0) {
      const messages = designAgent.state.messages as Message[];
      writeFileSync(join(outputDirectory, "plan-conversation.json"), JSON.stringify(messages, null, 2), "utf8");
      // 截断/错误检测：透出真实 stopReason 给用户区分根因
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const stopReason = (lastAssistant as { stopReason?: string; errorMessage?: string } | undefined)?.stopReason;
      const errorMessage = (lastAssistant as { errorMessage?: string } | undefined)?.errorMessage;
      if (stopReason === "length") {
        emit(log("error", `LLM 输出被 max_tokens 截断（stopReason=length），JSON 不完整解析失败。已设计用例但被截断。请提高 max_tokens 或分批设计。对话已保存到产物目录。`, "PLANNING", "case-designer"));
        emit({ type: "agent_end", role: "case-designer" });
        throw new Error("用例设计阶段 LLM 输出被 max_tokens 截断，JSON 不完整致 0 用例。已提高 max_tokens 到 32768，若仍截断需分批设计。");
      }
      if (stopReason === "error") {
        emit(log("error", `LLM API 调用失败（stopReason=error）：${errorMessage ?? "未知错误"}。请检查网络/API 状态后重试。对话已保存到产物目录。`, "PLANNING", "case-designer"));
        emit({ type: "agent_end", role: "case-designer" });
        throw new Error(`用例设计阶段 LLM API 调用失败：${errorMessage ?? "未知错误"}。请检查网络/API 状态后重试。`);
      }
      emit(log("error", `用例设计未产出任何测试用例。对话已保存到产物目录。`, "PLANNING", "case-designer"));
      emit({ type: "agent_end", role: "case-designer" });
      throw new Error("用例设计阶段未产出任何测试用例。可能原因：LLM 未按 JSON 格式输出、模型能力不足、或 API 异常。");
    }

    emit(log("success", `用例设计完成：${cases.length} 条用例`, "PLANNING", "case-designer"));
    emit({ type: "agent_end", role: "case-designer" });

    return {
      phase: "plan",
      cases,
      artifacts: [relative(input.projectPath, join(outputDirectory, "test-plan.json"))],
    } as PlanResult;
  }

  // ===== 阶段1（旧）：计划（read-only，LLM 读源码 → 产出 cases）=====
  async runPlan(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<PlanResult> {
    const { scenario, built, outputDirectory, execContext, streamFn } = this.initRun(input);
    const { model, apiKey } = built;

    // ===== 用例库复用检查（PRD 功能一：命中跳过 LLM 生成） =====
    const library = new CaseLibrary(input.projectPath);
    const storedCodeHash = library.getStoredCodeHash();
    const { codeHash: currentCodeHash, fileHashes: currentFileHashes } = computeCodeHash(input.projectPath);
    if (storedCodeHash && storedCodeHash.codeHash === currentCodeHash) {
      const storedCases = library.load().map((s) => s.case);
      if (storedCases.length > 0) {
        const reusedCases = storedCases.map((c) => ({ ...c, source: "reuse" as const }));
        validatePlanCoverage(input, reusedCases);
        emit(log("info", `用例库命中（code hash 匹配），复用 ${reusedCases.length} 条用例，跳过 LLM 生成`, "PLANNING", "case-designer"));
        writeFileSync(join(outputDirectory, "test-plan.json"), JSON.stringify(reusedCases, null, 2), "utf8");
        this.persistScenariosIfNeeded(input, reusedCases, emit);  // P4-7
        emit({ type: "planning_end", caseCount: reusedCases.length, cases: reusedCases, role: "case-designer" });
        emit(log("success", `测试计划已生成（库复用）：${reusedCases.length} 条用例`, "PLANNING", "case-designer"));
        emit({ type: "agent_end", role: "case-designer" });
        return {
          phase: "plan",
          cases: reusedCases,
          artifacts: [relative(input.projectPath, join(outputDirectory, "test-plan.json"))],
        };
      }
    }

    emit(log("info", `内置 LLM 开始调用 ${model.provider}/${model.id}（场景: ${scenario.name}）`, "GENERATING", "case-designer"));

    const eventLog: string[] = [];
    const toolResults: TestToolDetails[] = [];
    const turnCounter = { count: 0 };
    const timeline: TimelineEntry[] = [];
    const toolTimers = new Map<string, number>();
    const handleAgentEvent = this.makeEventHandler(emit, "planning", { eventLog, toolResults, turnCounter, timeline, toolTimers }, "case-designer");

    emit({ type: "planning_start", role: "case-designer" });
    emit(log("info", "正在分析项目，生成测试计划…", "PLANNING", "case-designer"));
    const planStartedAt = Date.now();
    timeline.push({ stage: "测试计划", status: "running", startedAt: new Date(planStartedAt).toISOString() });

    const projectContext = scanProjectContext(input.projectPath);
    const openApiSummary = await loadOpenApiSummary(input.openApiUrl, input.projectPath);
    const planPrompt = buildPlanPrompt(input, openApiSummary);
    const planSystemPrompt = `你是测试计划设计代理。阅读源码后设计结构化测试计划，不写代码不跑测试。
所有回复必须使用中文。

以下是项目上下文：
${projectContext}`;
    const planTools: AgentTool<any>[] = [bindToolContext(createReadTool(), execContext)];

    const planAgent = new Agent({
      streamFn,
      getApiKey: () => apiKey,
      initialState: { systemPrompt: planSystemPrompt, model, tools: planTools, thinkingLevel: "off" },
    });
    const unsubPlan = planAgent.subscribe(handleAgentEvent);
    try {
      await planAgent.prompt(planPrompt);
      await planAgent.waitForIdle();
    } finally {
      unsubPlan();
    }
    if (signal?.aborted) { emit({ type: "agent_end", role: "case-designer" }); throw new Error("任务已取消"); }

    // 从 LLM 回复解析 cases
    let cases = parseCasesFromResponse(planAgent.state.messages as Message[]);

    // ===== 增量复用合并（PRD 功能一场景 B） =====
    if (storedCodeHash && storedCodeHash.codeHash !== currentCodeHash) {
      const reusable = library.findReusableCases(currentFileHashes);
      if (reusable.length > 0) {
        const reusableTitles = new Set(reusable.map((c) => c.title));
        const newCases = cases.filter((c) => !reusableTitles.has(c.title));
        cases = [
          ...reusable.map((c) => ({ ...c, source: "reuse" as const })),
          ...newCases.map((c) => ({ ...c, source: "incremental" as const })),
        ];
        emit(log("info", `增量复用 ${reusable.length} 条旧用例 + 新生成 ${newCases.length} 条`, "PLANNING", "case-designer"));
      }
    }

    // 用例 ID 重分配为稳定 hash（projectHash + title）
    const projectHash = library.projectHashValue;
    cases = cases.map((c) => {
      const id = computeCaseId(projectHash, c.title);
      return { ...c, id, ...(c.structuredScenario ? { structuredScenario: { ...c.structuredScenario, id } } : {}) };
    });

    if (cases.length > 0) validatePlanCoverage(input, cases);
    writeFileSync(join(outputDirectory, "test-plan.json"), JSON.stringify(cases, null, 2), "utf8");
    this.persistScenariosIfNeeded(input, cases, emit);  // P4-7
    emit({ type: "planning_end", caseCount: cases.length, cases, role: "case-designer" });
    timeline[0].status = cases.length > 0 ? "passed" : "failed";
    timeline[0].durationMs = Date.now() - planStartedAt;
    timeline[0].message = `生成 ${cases.length} 条用例`;

    if (cases.length === 0) {
      const messages = planAgent.state.messages as Message[];
      writeFileSync(join(outputDirectory, "plan-conversation.json"), JSON.stringify(messages, null, 2), "utf8");
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      let diag = "";
      if (lastAssistant) {
        const text = extractAssistantText(messages);
        const stop = (lastAssistant as any).stopReason ?? "unknown";
        diag = `stopReason=${stop}${text ? `，返回文本: ${text.slice(0, 300)}` : "，返回空文本"}`;
      }
      emit(log("error", `测试计划生成失败，无法继续执行。${diag}`, "PLANNING", "case-designer"));
      emit({ type: "agent_end", role: "case-designer" });
      throw new Error(`计划阶段未产出任何测试用例（${diag}）。可能原因：LLM 未按 JSON 格式输出、模型能力不足、或 API 异常。对话已保存到产物目录。`);
    }

    emit(log("success", `测试计划已生成：${cases.length} 条用例`, "PLANNING", "case-designer"));
    emit({ type: "agent_end", role: "case-designer" });

    return {
      phase: "plan",
      cases,
      artifacts: [relative(input.projectPath, join(outputDirectory, "test-plan.json"))],
    };
  }

  /**
   * 独立的测试代码生成阶段：按目标类分组、多个 writer 并行；统一 test-compile
   * 通过后才把控制权交给执行阶段。writer 只能写自己分配的 AgentGeneratedTest 文件。
   */
  async runGenerate(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<GenerationResult> {
    const { built, outputDirectory, testToolContext, execContext, streamFn } = this.initRun(input, "generate");
    const { model, apiKey } = built;
    const groups = groupCasesForGeneration(input.projectPath, cases);
    if (groups.length === 0) throw new Error("没有可生成测试代码的目标类");
    for (const group of groups) assertGeneratedFileWritable(input.projectPath, group.outputPath);
    const concurrency = 2;
    emit(log("info", `进入测试代码生成阶段：${cases.length} 条用例聚合为 ${groups.length} 个目标类，最多 ${concurrency} 个 worker 并行`, "GENERATING", "test-generator"));
    groups.forEach((group) => emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed: 0, total: groups.length, status: "queued", role: "test-generator" }));

    const escalationHandler = (context?.escalationHandler ?? this.escalationHandler) as EscalationHandler | undefined;
    let completed = 0;
    await runWithConcurrency(groups, concurrency, async (group, index) => {
      signal?.throwIfAborted();
      if (generatedFileCoversCases(input.projectPath, group)) {
        completed++;
        emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed, total: groups.length, status: "reused", message: "复用上次已完成文件", role: "test-generator" });
        emit(log("success", `复用已完成测试 ${completed}/${groups.length}：${group.outputPath}`, "GENERATING", "test-generator"));
        return;
      }
      const tools: AgentTool<any>[] = [
        bindToolContext(createReadTool(), execContext),
        bindToolContext(createWriteTool(), execContext),
      ];
      if (escalationHandler) tools.push(createEscalateTool(escalationHandler, "tester"));
      const workerState = { eventLog: [] as string[], toolResults: [] as TestToolDetails[], turnCounter: { count: 0 }, timeline: [] as TimelineEntry[], toolTimers: new Map<string, number>() };
      let readCalls = 0;
      const readBudget = generationReadBudget(group.cases.length);
      let lastBlockedRead = "";
      let wroteAssignedFile = false;
      const assignedAbsolute = resolve(input.projectPath, group.outputPath);
      const targetClassName = basename(group.sourcePath, extname(group.sourcePath));
      const workerRole = `test-generator:${index + 1}:${targetClassName}`;
      emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed, total: groups.length, status: "running", role: workerRole });
      const handleEvent = this.makeEventHandler(emit, "executing", workerState, workerRole);
      const relatedTestRoot = resolve(input.projectPath, dirname(group.outputPath));
      const agent = new Agent({
        streamFn,
        getApiKey: () => apiKey,
        initialState: {
          model,
          thinkingLevel: "off",
          tools,
          systemPrompt: `你是并行测试代码生成 worker。只负责一个目标类；不得运行测试、不得修改生产代码、POM、现有测试或其他 worker 文件。必须把完整 Java 测试写入指定的 AgentGeneratedTest.java，文件首行固定写 // ${GENERATED_TEST_MARKER}。所有测试必须用 @DisplayName(\"[CASE:<用例ID>] 标题\") 且方法名以 case_<用例ID>_ 开头。遇到用例与代码冲突时使用 escalate，不得自行改 expected。`,
        },
        beforeToolCall: async ({ toolCall, args }) => {
          const payload = args as { path?: string };
          if (toolCall.name === "read") {
            const requested = resolve(input.projectPath, payload.path ?? "");
            const mainRoot = resolve(input.projectPath, "src/main");
            const pom = resolve(input.projectPath, "pom.xml");
            const relatedExistingTest = requested.startsWith(relatedTestRoot) && requested.endsWith(".java") && basename(requested).includes(targetClassName);
            if (!requested.startsWith(mainRoot) && requested !== pom && !relatedExistingTest) {
              lastBlockedRead = "请求超出目标源码、pom.xml 和同包相关测试的只读范围";
              return { block: true, reason: `${lastBlockedRead}。请基于已提供上下文生成测试。` };
            }
            if (readCalls >= readBudget) {
              lastBlockedRead = `已用完 ${readBudget} 次动态读取预算`;
              return { block: true, reason: `${lastBlockedRead}。目标类与直接依赖已预加载，请立即写入分配的测试文件。` };
            }
            readCalls++;
          }
          if (toolCall.name === "write") {
            const requested = resolve(input.projectPath, payload.path ?? "");
            if (requested !== assignedAbsolute) return { block: true, reason: `本 worker 只能写入 ${group.outputPath}` };
            wroteAssignedFile = true;
          }
          return undefined;
        },
        shouldStopAfterTurn: ({ turn, message }: any) => Boolean(wroteAssignedFile) && turn >= 1 && !message.content.some((part: any) => part.type === "toolCall"),
      });
      const unsubscribe = agent.subscribe(handleEvent);
      const caseLines = group.cases.map((item) => `- ${item.id} | ${item.title} | 场景=${item.scenario} | 预期=${item.expected}`).join("\n");
      const generationContext = buildGenerationContext(input.projectPath, group.sourcePath);
      const generationPrompt = `目标源码：${group.sourcePath}\n唯一允许写入：${group.outputPath}\n动态补充读取预算：${readBudget} 次。目标源码和直接依赖已在下方预加载；仅在确有缺失时再调用 read。\n\n已确认用例：\n${caseLines}\n\n预加载源码上下文：\n${generationContext || "（预加载失败，请定向读取目标源码）"}\n\n写入完整、可编译的 JUnit 5 + Mockito 测试。不要运行 Maven。`;
      try {
        await agent.prompt(generationPrompt);
        await agent.waitForIdle();
        if (!wroteAssignedFile || !existsSync(assignedAbsolute)) {
          emit(log("warning", `${targetClassName} 首次未写入测试文件，自动补充指令重试 1 次`, "GENERATING", workerRole));
          emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed, total: groups.length, status: "retrying", message: "首次未写入，正在自动重试", role: workerRole });
          signal?.throwIfAborted();
          await agent.prompt(`上一轮没有完成必须的写入操作。现在不要解释、不要继续浏览；请立即调用 write，把完整 JUnit 测试写入唯一允许路径 ${group.outputPath}。源码上下文与已确认用例沿用上一轮。`);
          await agent.waitForIdle();
        }
      } finally {
        unsubscribe();
      }
      if (!wroteAssignedFile || !existsSync(assignedAbsolute)) {
        const contextHint = lastBlockedRead ? `；最后一次读取受限原因：${lastBlockedRead}` : "";
        emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed, total: groups.length, status: "failed", message: "模型重试后仍未写入测试文件", role: workerRole });
        throw new Error(`测试生成 worker 自动重试后仍未写入 ${group.outputPath}（已完成 ${readCalls}/${readBudget} 次补充读取${contextHint}）`);
      }
      completed++;
      emit({ type: "generation_progress", target: group.sourcePath, outputPath: group.outputPath, completed, total: groups.length, status: "completed", role: workerRole });
      emit(log("success", `测试代码生成 ${completed}/${groups.length}：${group.outputPath}`, "GENERATING", "test-generator"));
      void index;
    });

    const compileSpec = process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", "mvn.cmd -DskipTests test-compile"], cwd: input.projectPath }
      : { command: "mvn", args: ["-DskipTests", "test-compile"], cwd: input.projectPath };
    emit(log("info", `生成完成，开始统一编译门禁（${groups.length} 个测试文件）`, "GENERATING", "test-generator"));
    let compile = await runMavenCommand(input.projectPath, compileSpec, signal, testToolContext.sandbox, testToolContext.extraWritableDirs);

    // 编译错误只允许在本轮 AgentGeneratedTest 文件内定向修复，最多两轮。
    const allowedGenerated = new Set(groups.map((group) => resolve(input.projectPath, group.outputPath)));
    const generatedFailure = (): boolean => {
      const output = compile.raw.replace(/\\/g, "/");
      return groups.some((group) => output.includes(group.outputPath.replace(/\\/g, "/")) || output.includes(basename(group.outputPath)));
    };
    for (let attempt = 1; !compile.ok && compile.compileError && generatedFailure() && attempt <= 2; attempt++) {
      emit(log("warning", `测试代码编译失败，开始第 ${attempt}/2 轮定向修复`, "GENERATING", "test-generator"));
      const repairTools: AgentTool<any>[] = [bindToolContext(createReadTool(), execContext), bindToolContext(createWriteTool(), execContext)];
      const repairAgent = new Agent({
        streamFn,
        getApiKey: () => apiKey,
        initialState: { model, thinkingLevel: "off", tools: repairTools, systemPrompt: "你只修复本轮 Test Agent 生成的测试文件编译错误。不得修改生产代码、pom.xml 或用户已有测试；不得运行测试。使用 write 写回完整文件。" },
        beforeToolCall: async ({ toolCall, args }) => {
          if (toolCall.name !== "read" && toolCall.name !== "write") return undefined;
          const requested = resolve(input.projectPath, String((args as { path?: string }).path ?? ""));
          if (!allowedGenerated.has(requested)) return { block: true, reason: "只能读取或写入本轮生成的 AgentGeneratedTest 文件。" };
          return undefined;
        },
      });
      const repairState = { eventLog: [] as string[], toolResults: [] as TestToolDetails[], turnCounter: { count: 0 }, timeline: [] as TimelineEntry[], toolTimers: new Map<string, number>() };
      const unsubscribe = repairAgent.subscribe(this.makeEventHandler(emit, "executing", repairState, "test-generator"));
      try {
        await repairAgent.prompt(`允许修复的文件：\n${groups.map((group) => `- ${group.outputPath}`).join("\n")}\n\nMaven test-compile 输出：\n${compile.raw.slice(-12000)}\n\n仅修复明确的测试代码编译问题。`);
        await repairAgent.waitForIdle();
      } finally {
        unsubscribe();
      }
      compile = await runMavenCommand(input.projectPath, compileSpec, signal, testToolContext.sandbox, testToolContext.extraWritableDirs);
    }
    if (!compile.ok && compile.compileError && !generatedFailure()) {
      emit(log("error", `Maven test-compile 完整输出：\n${compile.raw}`, "GENERATING", "test-generator"));
      throw new Error(`本轮生成成功，但项目已有测试编译失败。本轮生成的 ${groups.length} 个测试文件已保留。${summarizeMavenCompilationErrors(compile.raw)}。完整输出保留在技术日志中。`);
    }
    if (!compile.ok) throw new Error(`生成的测试代码未通过编译门禁：\n${compile.raw.slice(-5000)}`);

    const generatedFiles = groups.map((group) => group.outputPath);
    writeFileSync(join(outputDirectory, "generated-tests.json"), JSON.stringify({ generatedFiles, caseIds: cases.map((item) => item.id) }, null, 2), "utf8");
    emit(log("success", `测试代码生成并编译通过：${generatedFiles.length} 个文件，准备执行测试`, "GENERATING", "test-generator"));
    return {
      phase: "generate",
      cases,
      generatedFiles,
      groups: groups.length,
      artifacts: [relative(input.projectPath, join(outputDirectory, "generated-tests.json")), ...generatedFiles],
    };
  }

  // ===== 阶段2：执行（按 cases 锚点写测试 + 跑测试）=====
  async runExecute(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    validatePlanCoverage(input, cases);
    const provenance = captureRunProvenance(input);
    // fan-out 并行隔离：context.outputDirectorySuffix 由 Coordinator 按 testType 传入（照 pi-subagents runs.all fresh-context 隔离）
    const { scenario, built, outputDirectory, testToolContext, execContext, streamFn } = this.initRun(input, context?.outputDirectorySuffix);
    const { model, apiKey } = built;
    const eventsPath = join(outputDirectory, "runner-events.jsonl");

    emit(log("info", input.testCodeGenerated
      ? `进入纯测试执行阶段（场景: ${scenario.name}）：不再读取源码或生成测试`
      : `内置 LLM 开始执行测试（场景: ${scenario.name}）`, "GENERATING", "tester"));

    // ===== 变更影响分析（PRD 功能三：文件级粗粒度，默认增量） =====
    // 全量跑开关：context.fullRun 或环境变量 TEST_AGENT_FULL_RUN=true 时强制全量
    const forceFullRun = input.fullRun === true || context?.fullRun === true || process.env.TEST_AGENT_FULL_RUN === "true";
    let executionCases = cases;
    let impactMode: "incremental" | "full" = "incremental";
    let changedFiles: string[] = [];
    let skippedCaseCount = 0;
    if (forceFullRun) {
      impactMode = "full";
      emit(log("info", `全量跑模式（fullRun=true）：跳过用例筛选，跑全部 ${cases.length} 条用例`, "GENERATING", "tester"));
    } else {
      changedFiles = getChangedFiles(input.projectPath);
      const selection = selectAffectedCases(cases, changedFiles);
      executionCases = selection.affected;
      skippedCaseCount = selection.skipped.length;
      if (cases.length > 0 && executionCases.length === 0) {
        throw new Error(`增量筛选零命中：${changedFiles.length} 个变更文件与 ${cases.length} 条计划用例均未匹配。没有启动测试；请返回计划页选择全量执行，或调整用例 target。`);
      }
      if (selection.fallbackReason) {
        impactMode = "full";
        emit(log("info", `变更影响分析：${selection.fallbackReason}，跑全部 ${executionCases.length} 条用例`, "GENERATING", "tester"));
      } else if (skippedCaseCount > 0) {
        emit(log("info", `变更影响分析：检测到 ${changedFiles.length} 个变更文件，选中 ${executionCases.length}/${cases.length} 条用例（跳过 ${skippedCaseCount} 条）`, "GENERATING", "tester"));
      } else {
        emit(log("info", `变更影响分析：检测到 ${changedFiles.length} 个变更文件，选中 ${executionCases.length}/${cases.length} 条用例`, "GENERATING", "tester"));
      }
    }

    // ===== P3-5：用户标记跳过的用例（skipCaseIds 从 TaskInput 传入） =====
    const userSkipIds = new Set(input.skipCaseIds ?? []);
    if (userSkipIds.size > 0) {
      const beforeSkip = executionCases.length;
      executionCases = executionCases.filter((c) => !userSkipIds.has(c.id));
      emit(log("info", `用户跳过 ${beforeSkip - executionCases.length} 条用例，实际执行 ${executionCases.length} 条`, "GENERATING", "tester"));
    }
    if (executionCases.length === 0) {
      throw new Error("没有可执行用例：请返回计划页调整范围或取消跳过后重试");
    }

    // 从 agents/ 目录加载 tester 角色配置（.md 驱动）
    const agentsDir = resolveAgentsDir();
    const roles = loadRoles(agentsDir);
    const testerRole = roles["tester"];
    const turnBudget = testerRole?.turnBudget ?? { maxTurns: 10, graceTurns: 1 };

    // capability-ceiling：声明式 ceiling，allowedTools = scenario.tools
    const sessionId = randomUUID();
    let ceilingHandle: { dispose(): void } | undefined;
    try {
      ceilingHandle = registerSubagentCapabilityCeiling({
        sessionId,
        source: "test-agent.tester",
        ceiling: { allowedTools: scenario.tools, denyExtensions: true },
      });
    } catch {
      ceilingHandle = undefined;
    }

    // mutation-evidence：baseline 快照（tester 是 writer，追踪改了哪些文件）
    let mutationBaseline: ReturnType<typeof snapshotTrackedMutations> | undefined;
    try {
      mutationBaseline = snapshotTrackedMutations(input.projectPath);
    } catch {
      mutationBaseline = undefined;
    }

    const eventLog: string[] = [];
    const toolResults: TestToolDetails[] = [];
    const turnCounter = { count: 0 };
    const timeline: TimelineEntry[] = [];
    const toolTimers = new Map<string, number>();
    const handleAgentEvent = this.makeEventHandler(emit, "executing", { eventLog, toolResults, turnCounter, timeline, toolTimers }, "tester");

    const projectContext = scanProjectContext(input.projectPath);
    const projectKind = inspectProjectSupport(input.projectPath).kind;
    const missingGeneratedIds = missingGeneratedCaseIds(input.projectPath, executionCases);
    const canReuseGeneratedTests = input.testCodeGenerated === true && missingGeneratedIds.length === 0;
    if (input.testCodeGenerated && !canReuseGeneratedTests) {
      emit(log('warning', `已生成测试与当前计划不匹配（缺少 ${missingGeneratedIds.length} 个用例 ID），重新进入测试准备`, 'GENERATING', 'tester'));
    }
    const tools = buildToolsForScenario(
      scenario,
      testToolContext,
      execContext,
      input.testTypes,
      projectKind,
      canReuseGeneratedTests,
    );

    // escalation 工具注入（tester 角色配 escalation:true 且 handler 可用时）
    const execEscalationHandler = (context?.escalationHandler ?? this.escalationHandler) as EscalationHandler | undefined;
    if (testerRole?.escalation && execEscalationHandler) {
      tools.push(createEscalateTool(execEscalationHandler, "tester"));
    }

    const execPrompt = canReuseGeneratedTests
      ? `测试代码已经由独立生成阶段生成并通过 test-compile。现在只执行真实测试并返回结果。立即调用与项目匹配的测试工具；禁止分析、读取或修改任何代码。测试类型：${input.testTypes.join(", ")}。`
      : buildExecutionPrompt(input, executionCases, context?.knowledge, !!(testerRole?.escalation && execEscalationHandler));
    // systemPrompt 拼接：tester.md 通用段 + scenario 专精段 + 项目上下文 + turn-budget
    const testerGeneric = testerRole?.systemPrompt ?? "";
    const scenarioSpecialized = scenario.systemPrompt ?? "";
    const basePrompt = canReuseGeneratedTests
      ? "你是确定性测试执行器。测试代码已生成并完成编译门禁；唯一职责是立即调用测试工具，不得读取或修改代码。"
      : (testerGeneric ? `${testerGeneric}\n\n${scenarioSpecialized}` : scenarioSpecialized);
    const execSystemPrompt = appendTurnBudgetSystemPrompt(
      canReuseGeneratedTests
        ? basePrompt
        : `${basePrompt}\n\n以下是项目上下文，你不需要再探索项目结构，直接开始读源码和写测试：\n${projectContext}`,
      turnBudget,
    );

    let testerReadCalls = 0;
    const maxTesterReadCalls = 8;
    const execAgent = new Agent({
      streamFn,
      getApiKey: () => apiKey,
      initialState: { systemPrompt: execSystemPrompt, model, tools, thinkingLevel: testerRole?.thinking ?? "off" },
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name !== "read") return undefined;
        testerReadCalls++;
        if (testerReadCalls <= maxTesterReadCalls) return undefined;
        return {
          block: true,
          reason: `执行阶段读取源码已达到 ${maxTesterReadCalls} 次上限。请停止继续探索，立即基于已有上下文写测试并调用测试工具。`,
        };
      },
      shouldStopAfterTurn: (ctx: any) => {
        const turnCount = ctx.turn;
        const hasToolCalls = ctx.message.content.some((p: any) => p.type === "toolCall");
        const terminalStop = !hasToolCalls;
        try {
          const decision = turnBudgetDecision(turnBudget, turnCount, terminalStop, hasToolCalls, true);
          if (decision === "abort") {
            console.warn(turnBudgetExceededMessage(turnBudget, turnCount));
            return true;
          }
        } catch {
          // turn-budget 异常不阻断
        }
        return false;
      },
    });

    // 注册 Agent 到 escalation handler（供 reply 时 steer，§7 不确定点 5）
    if (testerRole?.escalation && execEscalationHandler) {
      execEscalationHandler.registerAgent("tester", execAgent);
      // 片C：steer 默认关闭，仅 role.escalationSteer=true 时开启
      if (testerRole.escalationSteer) execEscalationHandler.setSteerEnabled("tester", true);
    }

    try {
      let nextPrompt = execPrompt;
      let transientRecoveryCount = 0;
      while (true) {
        await runAgentWithIdleWatchdog({
          agent: execAgent,
          prompt: nextPrompt,
          onEvent: handleAgentEvent,
          signal,
          timeoutMs: 3 * 60 * 1000,
          timeoutMessage: "执行阶段连续 3 分钟没有新事件，已自动中止；请返回测试计划后重试",
          onTimeout: () => emit(log("error", "执行阶段连续 3 分钟没有模型或工具事件，已自动中止。可从测试计划重新执行。", "GENERATING", "tester")),
          isPaused: () => (execEscalationHandler?.pendingCount ?? 0) > 0,
        });

        const messages = execAgent.state.messages as Message[];
        if (!shouldRecoverTransientExecution(messages, toolResults.length, transientRecoveryCount)) break;

        const interrupted = getLastAssistantMessage(messages);
        transientRecoveryCount++;
        emit(log(
          "warning",
          `模型响应被临时中断（${interrupted?.errorMessage ?? "未知传输错误"}），正在从已有上下文自动恢复（${transientRecoveryCount}/1）`,
          "GENERATING",
          "tester",
        ));
        nextPrompt = buildTransientExecutionRecoveryPrompt(interrupted?.errorMessage);
      }
    } finally {
      ceilingHandle?.dispose();
    }

    if (signal?.aborted) { emit({ type: "agent_end", role: "tester" }); throw new Error("任务已取消"); }

    // 写事件日志到产物目录（供排查）
    writeFileSync(eventsPath, eventLog.join("\n") + "\n", "utf8");

    // mutation-evidence：收集 tester 改了哪些文件（writer 角色追踪）
    if (mutationBaseline) {
      try {
        const mutationEvidence = collectTrackedMutationEvidence(mutationBaseline);
        if (mutationEvidence.attemptedMutation && mutationEvidence.changedFiles.length > 0) {
          emit(log("info", `tester 修改了 ${mutationEvidence.changedFiles.length} 个文件：${mutationEvidence.changedFiles.join(", ")}`, "GENERATING", "tester"));
        }
      } catch {
        // mutation-evidence 异常不阻断
      }
    }

    // 从工具结果聚合报告
    if (toolResults.length === 0) {
      const messages = execAgent.state.messages as Message[];
      writeFileSync(join(outputDirectory, "runner-conversation.json"), JSON.stringify(messages, null, 2), "utf8");
      const lastAssistant = getLastAssistantMessage(messages);
      let diag = "";
      if (lastAssistant) {
        const text = extractAssistantText(messages);
        const stop = (lastAssistant as any).stopReason ?? "unknown";
        // hasTextContent 检查是否有 text content block（不含 thinking fallback），
        // 用于判断模型是否产出了正文回复（vs 只在 thinking 中推理）
        const hasTextContent = (lastAssistant.content ?? []).some((c: any) => c.type === "text" && ((c as any).text ?? "").trim().length > 0);
        if (stop === "error") {
          const errorMessage = (lastAssistant as any).errorMessage;
          diag = `LLM 返回错误（stopReason=error${errorMessage ? `，error=${errorMessage}` : ""}）。`;
          if (text) diag += ` LLM 返回文本: ${text.slice(0, 200)}`;
        } else if (stop === "length") {
          diag = `LLM 输出被 token 上限截断（stopReason=length）。`;
        } else if (!hasTextContent) {
          // 无正文回复（text content block 为空）——检查是否调用了工具
          const hasToolCall = (lastAssistant.content ?? []).some((c: any) => c.type === "toolCall");
          if (hasToolCall) {
            diag = `LLM 调用了非测试工具（stopReason=${stop}），未执行测试工具。可能 LLM 读代码过多未开始写测试。`;
          } else {
            diag = `LLM 返回空响应（stopReason=${stop}）。可能原因：API Key 无效或模型不可用。`;
          }
        } else {
          diag = `LLM stopReason=${stop}，返回文本: ${text.slice(0, 200)}`;
        }
      }
      emit({ type: "agent_end", role: "tester" });
      throw new Error(`内置 LLM 未产出测试工具结果（${turnCounter.count} 轮对话已保存到产物目录）。${diag}`);
    }

    const result = aggregateReport(toolResults, executionCases, timeline);
    result.report.provenance = provenance;
    validateExecutionOutcome(input, result);
    result.phase = "execute";
    result.artifacts = [relative(input.projectPath, eventsPath), relative(input.projectPath, join(outputDirectory, "test-plan.json"))];

    emit(log("success", `测试完成：${result.report.passed} 通过，${result.report.failed} 失败${result.report.coverage !== null ? `，覆盖率 ${result.report.coverage}%` : ""}`, "GENERATING", "tester"));
    emit({ type: "test_execution_complete", passed: result.report.passed, failed: result.report.failed, role: "tester" });

    // ===== 通过的用例 100% 入库（PRD 功能一场景 A） =====
    // 执行完成后将用例集持久化到 Worker 本地用例库，并更新代码指纹。
    // 全过时全部入库；有失败时仍入库（用例集是回归基线，版本历史管理变更）。
    // taskId 从 AgentRunContext 传入（worker-mode/hand-mode 来源），写入 CaseVersion.taskId（PRD 5.5 场景A）。
    try {
      const execLibrary = new CaseLibrary(input.projectPath);
      const taskId = context?.taskId;
      for (const c of cases) {
        execLibrary.saveCase(c, taskId);
      }
      const { codeHash: execCodeHash, fileHashes: execFileHashes } = computeCodeHash(input.projectPath);
      execLibrary.updateCodeHash(execCodeHash, execFileHashes);
      emit(log("info", `用例库已更新：${cases.length} 条用例入库，code hash=${execCodeHash.slice(0, 8)}`, "GENERATING", "tester"));
    } catch (err) {
      // 用例库写入失败不阻断主流程
      emit(log("warning", `用例库更新异常，已跳过：${err instanceof Error ? err.message : String(err)}`, "GENERATING", "tester"));
    }

    // 失败诊断：failed > 0 时触发 read-only 诊断 Agent（PRD 场景 A：全过不触发）
    if (result.report.failed > 0) {
      try {
        // 从 toolResults 提取失败用例 raw 事实。TestToolDetails 无 per-case 明细（fail 只是数字），
        // UI 测试从 uiSteps 提取逐条失败步骤；其余工具构造汇总条目，让 reviewer 用 read 主动调查。
        // 与 aggregateReport 用同一批去重后的最新结果，避免诊断已自修复的旧失败（reviewer P1）
        const latestToolResults = new Map<string, TestToolDetails>();
        for (const r of toolResults) {
          const existing = latestToolResults.get(r.tool);
          if (r.tests > 0) {
            latestToolResults.set(r.tool, r);
          } else if (!existing) {
            latestToolResults.set(r.tool, r);
          }
        }
        const failedToolResults = [...latestToolResults.values()].filter((r) => r.fail > 0);
        const failedCaseInputs: FailedCaseInput[] = [];
        for (const r of failedToolResults) {
          const layer = toolToTestType(r.tool) ?? "unit";
          let addedFromUiSteps = false;
          if (r.uiSteps) {
            for (const step of r.uiSteps) {
              if (step.status === "failed") {
                failedCaseInputs.push({ name: step.name, layer: "ui", error: step.error ?? "" });
                addedFromUiSteps = true;
              }
            }
          }
          if (!addedFromUiSteps) {
            // P1 修复：尝试将测试输出的失败名称匹配到用例标题（模糊匹配），
            // 使诊断产出的 failedCases[].name 使用真实用例标题，而非合成聚合名。
            // 这样 Flaky 检测的历史记录和可疑识别才能按用例标题匹配。
            const actualFailures = r.failedCases ?? [];
            let matchedCount = 0;
            for (const fc of actualFailures) {
              const matchedTitle = executionCases.find(
                (c) => fc.name === c.title || fc.name.includes(c.title) || c.title.includes(fc.name),
              );
              if (matchedTitle) {
                failedCaseInputs.push({
                  name: matchedTitle.title,
                  layer,
                  error: fc.error ?? `测试失败（测试工具: ${r.tool}）`,
                  caseId: matchedTitle.id,  // P1-5：端到端透传 TestCase.id → FailedCaseRecord.caseId
                });
                matchedCount++;
              }
            }
            // 无匹配时回退合成名（maven_test 无 per-case 数据等场景）
            if (matchedCount === 0) {
              failedCaseInputs.push({
                name: `${r.tool} 失败用例`,
                layer,
                error: `共 ${r.fail} 个失败（测试工具: ${r.tool}）`,
              });
            }
          }
        }

        emit(log("info", `检测到 ${result.report.failed} 个失败，启动失败诊断…`, "DIAGNOSING", "result-reviewer"));
        const diagnosis = await runDiagnosis(
          { streamFn, model, apiKey, execContext, projectPath: input.projectPath, turnBudget: { maxTurns: 8, graceTurns: 1 }, sessionId: randomUUID(), escalationHandler: roles["result-reviewer"]?.escalation ? execEscalationHandler : undefined, escalationSteer: roles["result-reviewer"]?.escalationSteer ? true : undefined, roleEscalation: !!roles["result-reviewer"]?.escalation, emit },
          failedCaseInputs,
          JSON.stringify(failedToolResults, null, 2),
          [input.projectPath],
        );
        result.report.failedCases = diagnosis.failedCases;
        if (diagnosis.riskPoints) result.report.riskPoints = diagnosis.riskPoints;
        if (diagnosis.fixes) result.report.fixes = diagnosis.fixes;
        if (diagnosis.readOnlyViolation) result.report.readOnlyViolation = diagnosis.readOnlyViolation;
        // 诊断先行架构：计算分层修复决策，供 host-mode 分流
        const fixDecision = decideFixAction(diagnosis);
        result.fixDecision = fixDecision;
        result.diagnosis = diagnosis;
        emit(log("success", `失败诊断完成：${diagnosis.failedCases.length} 条诊断记录（修复决策：${fixDecision.action}）`, "DIAGNOSING", "result-reviewer"));
      } catch (err) {
        // 诊断失败不中断主流程——降级为无诊断，主测试结果照常返回（PRD 第7节退路）
        emit(log("warning", `失败诊断异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "DIAGNOSING", "result-reviewer"));
      }
    }

    // ===== Flaky 检测与隔离（PRD 功能二） =====
    // 1. 记录每次执行历史到 runs.jsonl
    // 2. 对可疑用例（诊断标 flaky 或 近10次通过率<90%）重跑 5 次
    // 3. 重跑通过率<80% 判 flaky，隔离出主门禁
    try {
      const flakyProjectHash = computeProjectHash(input.projectPath);
      const runsBaseDir = join(input.projectPath, ".test-agent", "cases", flakyProjectHash);

      // 1. 记录执行历史（实际执行的用例）
      const failedNames = new Set((result.report.failedCases ?? []).map((c) => c.name));
      // P1 修复：非 UI 测试若 failedCases 使用合成名（如 "maven_test 失败用例"），
      // 无法按用例标题归因失败 → 跳过本次历史记录，避免写入错误的“全过”数据。
      const canAttributeFailures = result.report.failed === 0 ||
        executionCases.some((c) => failedNames.has(c.title));
      if (canAttributeFailures) {
        for (const c of executionCases) {
          const passed = result.report.failed === 0 || !failedNames.has(c.title);
          recordRun(runsBaseDir, c.id, passed);
        }
      }

      // 2. 可疑用例识别 + Flaky 检测
      // P2d 修复：不仅在本轮失败时触发，也检测历史不稳定但本轮通过的用例（PRD 场景 B）。
      const diagnosisByTitle = new Map(
        (result.report.failedCases ?? []).map((fc) => [fc.name, fc.category]),
      );
      const cfg = defaultFlakyConfig();

      // 筛选可疑用例：诊断标 flaky 或 近10次历史通过率<90%（且历史>=3）
      const suspiciousCases = executionCases.filter((c) => {
        const diagCat = diagnosisByTitle.get(c.title);
        const runs = loadRuns(runsBaseDir, c.id, cfg.historyWindowSize);
        return identifySuspiciousReasons(runs, diagCat, cfg).length > 0;
      });

      if (suspiciousCases.length > 0) {
        emit(log("info", `检测到 ${suspiciousCases.length} 个可疑用例，启动 Flaky 重跑检测…`, "DIAGNOSING", "tester"));

        // 创建重跑执行器（根据执行阶段使用的测试工具）
        const usedTools = [...new Set(toolResults.map((r) => r.tool))];
        const rerunExecutor = createRerunExecutor(testToolContext, usedTools);

        if (rerunExecutor) {
          const flakyRecords: FlakyRecord[] = [];
          for (const c of suspiciousCases) {
            const diagCat = diagnosisByTitle.get(c.title);
            const record = await detectFlaky(runsBaseDir, c.id, c.title, diagCat, rerunExecutor);
            flakyRecords.push(record);
            if (record.isFlaky) {
              emit(log("warning", `Flaky 确认：${c.title}（${record.reason}）`, "DIAGNOSING", "tester"));
            }
          }

          result.report.flakyCases = flakyRecords;

          // 3. 质量门禁评估：flaky 失败隔离出主门禁
          const qualityGate = evaluateQualityGate(executionCases.length, result.report.failedCases ?? [], flakyRecords);
          result.report.qualityGate = qualityGate;

          const flakyCount = flakyRecords.filter((r) => r.isFlaky).length;
          emit(log("success", `Flaky 检测完成：${flakyCount} 个 flaky，门禁状态：${qualityGate.status}（${qualityGate.summary}）`, "DIAGNOSING", "tester"));
        } else {
          emit(log("info", `无可用的重跑执行器（测试工具: ${usedTools.join(",")}），Flaky 检测降级跳过`, "DIAGNOSING", "tester"));
        }
      }
    } catch (err) {
      // Flaky 检测异常不中断主流程
      emit(log("warning", `Flaky 检测异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "DIAGNOSING", "tester"));
    }

    // ===== 增量覆盖率计算（PRD 功能三：变更代码行 ∩ 覆盖行） =====
    try {
      const changedLines = getChangedLines(input.projectPath);
      const incrementalCoverage = computeIncrementalCoverage(
        input.projectPath,
        changedLines,
        executionCases.length,
        cases.length,
        impactMode,
      );
      result.report.incrementalCoverage = incrementalCoverage;
      if (incrementalCoverage.percentage !== null) {
        emit(log("info", `增量覆盖率：${incrementalCoverage.percentage}%（变更 ${incrementalCoverage.changedLineCount} 行，覆盖 ${incrementalCoverage.coveredChangedLineCount} 行）`, "GENERATING", "tester"));
      } else if (incrementalCoverage.fallbackReason) {
        emit(log("info", `增量覆盖率：${incrementalCoverage.fallbackReason}`, "GENERATING", "tester"));
      }
    } catch (err) {
      // 增量覆盖率异常不中断主流程
      emit(log("warning", `增量覆盖率计算异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "GENERATING", "tester"));
    }

    // 收集 escalation 记录填 report.escalations（从 EscalationHandler.getRecords() 取本任务全部 ask/降级记录）
    if (execEscalationHandler && execEscalationHandler.getRecords().length > 0) {
      result.report.escalations = [...execEscalationHandler.getRecords()];
    }

    const finalGate = finalizeQualityGate(input, result);
    emit(log(finalGate.status === 'passed' ? 'success' : 'warning', `最终质量门禁：${finalGate.summary}`, "GENERATING", "tester"));

    return result;
  }

  // ===== 诊断先行架构：修复阶段（按诊断结果修复，修完重跑验证）=====
  async runFix(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    // 从 input.diagnosis 拿 GUI 传回的诊断结果
    const inputDiagnosis = input.diagnosis;
    if (!inputDiagnosis || !inputDiagnosis.failedCases || inputDiagnosis.failedCases.length === 0) {
      emit(log("warning", "修复阶段未收到诊断结果，跳过修复", "FIXING", "fixer"));
      return {
        phase: "fix",
        report: { passed: 0, failed: 0, coverage: null, failedCases: [], fixActions: [] },
        lanes: [],
        artifacts: [],
      };
    }

    const { built, outputDirectory, testToolContext, execContext, streamFn } = this.initRun(input);
    const { model, apiKey } = built;

    // 加载角色配置（检查 fixer 是否配 escalation:true）
    const fixRoles = loadRoles(resolveAgentsDir());

    emit(log("info", `修复阶段：按诊断修复 ${inputDiagnosis.failedCases.length} 条失败用例…`, "FIXING", "fixer"));

    try {
      const diagnosis: DiagnosisResult = {
        failedCases: inputDiagnosis.failedCases as FailedCaseRecord[],
      };
      const deps: FixDeps = {
        streamFn,
        model,
        apiKey,
        execContext,
        testToolContext,
        projectPath: input.projectPath,
        diagnosis,
        turnBudget: { maxTurns: 8, graceTurns: 1 },
        sessionId: randomUUID(),
        escalationHandler: fixRoles["fixer"]?.escalation ? (context?.escalationHandler as EscalationHandler | undefined) ?? this.escalationHandler : undefined,
        escalationSteer: fixRoles["fixer"]?.escalationSteer ? true : undefined,
        roleEscalation: !!fixRoles["fixer"]?.escalation,
        emit,
      };
      const fixResult = await runFixByDiagnosis(deps);

      const reportHandler = (context?.escalationHandler as EscalationHandler | undefined) ?? this.escalationHandler;
      const result: AgentRunResult = {
        phase: "fix",
        report: {
          passed: fixResult.finalReport.passed,
          failed: fixResult.finalReport.failed,
          coverage: fixResult.finalReport.coverage,
          failedCases: inputDiagnosis.failedCases as FailedCaseRecord[],
          fixActions: fixResult.fixActions,
          ...(reportHandler && reportHandler.getRecords().length > 0
            ? { escalations: [...reportHandler.getRecords()] }
            : {}),
        },
        lanes: [],
        artifacts: [],
      };
      emit(log("success", `修复完成：${fixResult.fixActions.length} 条修复动作，重跑 ${fixResult.finalReport.passed} 通过 / ${fixResult.finalReport.failed} 失败`, "FIXING", "fixer"));
      return result;
    } catch (err) {
      // 修复失败不中断——降级返回空 fixActions，诊断仍在报告里
      emit(log("warning", `修复异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "FIXING", "fixer"));
      return {
        phase: "fix",
        report: {
          passed: 0, failed: 0, coverage: null,
          failedCases: inputDiagnosis.failedCases as FailedCaseRecord[],
          fixActions: [],
        },
        lanes: [],
        artifacts: [],
      };
    }
  }

  // ===== Fitness-driven 自修复编排（PRD 功能一：execute→fix→retest 循环 + 双指标判停）=====
  /**
   * 外层观测层：包裹 execute→fix→retest 修复循环，只观测不干预 loop 内部决策。
   *
   * 流程：
   * 1. 先调 runExecute 拿初始结果（基线观测点，iter=0）
   * 2. failed>0 时循环 {runFix + runExecute 重测}，每轮追加观测点，用 evaluateFitness 判停
   * 3. 将 fitness 写入 result.report.fitness
   *
   * 不修改 runExecute/runFix 内部工具调用逻辑，只做外层编排与观测。
   * maxIterations 上限（默认 10，可配 TEST_AGENT_FITNESS_MAX_ITER）防失控。
   */
  async runFitnessDrivenExecute(
    input: TaskInput,
    cases: TestCase[],
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    const k = Number(process.env.TEST_AGENT_FITNESS_K ?? "3") || 3;
    const maxIterations = Number(process.env.TEST_AGENT_FITNESS_MAX_ITER ?? "10") || 10;
    const coverageTarget = typeof input.coverageTarget === "number" ? input.coverageTarget : undefined;

    emit(log("info", `启动 Fitness-driven 自修复（K=${k}，上限 ${maxIterations} 轮）…`, "GENERATING", "tester"));

    // 1. 初始 execute——拿基线观测点
    let result = await this.runExecute(input, cases, emit, signal, context);

    const curve: import("./types.js").FitnessCurvePoint[] = [];
    curve.push(
      makeCurvePoint(0, result.report.passed, result.report.failed, result.report.coverage),
    );

    // 无失败 → 直接收敛，不进循环
    if (result.report.failed <= 0) {
      const decision = evaluateFitness(curve, k, coverageTarget);
      result.report.fitness = buildFitnessReport(curve, k, 0, decision, null);
      emit(log("success", `Fitness 完成：${decision.message}`, "GENERATING", "tester"));
      return result;
    }

    // 2. fix+retest 循环
    let iterations = 0;
    let decision: FitnessDecision = evaluateFitness(curve, k, coverageTarget);

    while (result.report.failed > 0 && !decision.shouldStop && iterations < maxIterations) {
      if (signal?.aborted) { emit({ type: "agent_end", role: "tester" }); throw new Error("任务已取消"); }

      iterations++;
      emit(log("info", `Fitness 迭代第 ${iterations} 轮：执行修复 → 重测…`, "FIXING", "fixer"));

      // 把上一轮诊断结果回填到 input.diagnosis，供 runFix 使用
      const failedCases = result.report.failedCases ?? [];
      const fixInput: TaskInput = {
        ...input,
        diagnosis: { failedCases },
      };

      // 修复阶段（不修改 runFix 内部逻辑）
      try {
        await this.runFix(fixInput, emit, signal, context);
      } catch (err) {
        emit(log("warning", `第 ${iterations} 轮修复异常，已降级跳过：${err instanceof Error ? err.message : String(err)}`, "FIXING", "fixer"));
      }

      // 重测阶段（复用 runExecute，不修改其内部逻辑）
      const retestResult = await this.runExecute(input, cases, emit, signal, context);

      // 取重测结果作为当前轮观测点；保留重测结果的 lanes/artifacts/fullReport（最新状态）
      result = retestResult;

      curve.push(
        makeCurvePoint(iterations, retestResult.report.passed, retestResult.report.failed, retestResult.report.coverage, curve[curve.length - 1]),
      );

      decision = evaluateFitness(curve, k, coverageTarget);
      emit(log("info", `Fitness 第 ${iterations} 轮：通过率 ${curve[curve.length - 1].passRate}%（Δ${curve[curve.length - 1].passRateDelta}），覆盖率 ${curve[curve.length - 1].coverage ?? "N/A"}% — ${decision.shouldStop ? "停止" : "继续"}`, "GENERATING", "tester"));
    }

    // 达 maxIterations 上限但未收敛 → 标记 max-iterations
    if (iterations >= maxIterations && !decision.converged && result.report.failed > 0) {
      decision = {
        shouldStop: true,
        converged: false,
        stoppedReason: "max-iterations",
        message: `自修复未收敛，需人工：达到最大迭代轮次 ${maxIterations}（通过率 ${curve[curve.length - 1].passRate}%，覆盖率 ${curve[curve.length - 1].coverage ?? "N/A"}%）`,
      };
    }

    // 3. 写入 fitness 报告
    result.report.fitness = buildFitnessReport(curve, k, iterations, decision, null);

    if (decision.converged) {
      emit(log("success", `Fitness 完成（收敛）：${decision.message}`, "GENERATING", "tester"));
    } else {
      emit(log("warning", `Fitness 完成（未收敛）：${decision.message}`, "GENERATING", "tester"));
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Prompt 构建（不含"写结果文件"指令）
// ---------------------------------------------------------------------------

/**
 * 计划阶段 prompt：让 LLM 读源码后产出结构化测试计划（cases）。
 * 只给 read 工具，不写代码不跑测试。
 */
function buildPlanPrompt(input: TaskInput, openApiSummary?: string): string {
  const layerHints: string[] = [];
  if (input.testTypes.includes("unit")) layerHints.push("unit（单元测试，针对函数/类/服务）");
  if (input.testTypes.includes("api")) layerHints.push("api（接口测试，针对 HTTP 接口）");
  if (input.testTypes.includes("ui")) layerHints.push("ui（UI 测试，针对页面交互）");
  if (input.testTypes.includes("regression")) layerHints.push("regression（回归测试，针对核心场景）");

  const lines: string[] = [
    `你是测试计划设计代理。你的任务是阅读项目源码，设计结构化测试计划。`,
    `所有回复必须使用中文。`,
    ``,
    `系统：${input.systemName}`,
    `版本：${input.version || "未识别"}`,
    `测试类型：${input.testTypes.join(", ")}`,
    ``,
    `执行步骤：`,
    `1. 用 read 工具阅读项目的核心源码文件（1-3 个关键文件即可）`,
    `2. 分析代码逻辑，设计 3-8 条结构化测试用例`,
    `3. 以 JSON 数组格式输出测试计划，用 \`\`\`json 代码块包裹`,
    ``,
    `测试用例 JSON 格式：`,
    "```json",
    "[",
    "  {",
    '    "id": "TC001",',
    '    "title": "用例标题",',
    '    "scenario": "测试场景描述",',
    '    "steps": ["步骤1", "步骤2"],',
    '    "expected": "预期结果",',
    '    "priority": "low|medium|high",',
    '    "layer": "unit|api|ui",',
    '    "target": "目标类/方法/接口路径",',
    '    "method": "API 用例可填 GET|POST|PUT|PATCH|DELETE",',
    '    "path": "API 用例可填 /api/resource",',
    '    "body": { "API请求字段": "值" },',
    '    "expectedStatus": 200,',
    '    "expectedBodyContains": ["响应必须包含的文本"],',
    '    "expectedJsonSubset": { "响应字段": "期望值" }',
    "  }",
    "]",
    "```",
    ``,
    `规则：`,
    `- 优先设计高价值用例：核心业务逻辑、边界条件、错误处理`,
    `- layer 只能是：${layerHints.join("、")}`,
    `- 用例数量 3-8 条，不要过多也不要太少`,
    `- target 字段指明要测的具体类名/方法名/接口路径`,
    `- API 用例必须填写 method、path、expectedStatus；有请求体时填写 body，并至少使用 expectedBodyContains 或 expectedJsonSubset 校验响应内容`,
    `- 【重要】JSON 字符串值内禁止使用双引号，如需引用请用中文引号“”或单引号`,
    `- 不要执行任何测试，不要写任何测试代码，只输出测试计划 JSON`,
    `- 输出必须是合法 JSON，用 \`\`\`json 代码块包裹`,
  ];

  if (input.targetClasses && input.targetClasses.length > 0) {
    lines.push(`- 重点测试目标：${input.targetClasses.join(", ")}`);
  }
  if (input.apiBaseUrl) {
    lines.push(`- API 基础 URL：${input.apiBaseUrl}`);
  }
  if (openApiSummary) {
    lines.push(``, `【已校验的 OpenAPI 接口清单】`, openApiSummary, `- API 用例必须来自以上真实操作，不得编造路径或方法`);
  }
  if (input.uiEntryUrl) {
    lines.push(`- UI 入口 URL：${input.uiEntryUrl}`);
  }

  return lines.join("\n");
}

/** 从 LLM 回复中解析 cases JSON。优先提取 ```json 代码块，回退正则匹配。 */
export function parseCasesFromResponse(messages: Message[]): TestCase[] {
  const text = extractAssistantText(messages);
  if (!text) return [];

  // 1. 优先提取 ```json ... ``` 代码块
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  let jsonStr: string | null = null;
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  } else {
    // 2. 回退：匹配第一个 [ 到最后一个 ]
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      jsonStr = text.slice(start, end + 1).trim();
    }
  }
  if (!jsonStr) return [];

  const normalizeCases = (parsed: unknown): TestCase[] => {
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item, i) => ({
        id: String(item.id ?? `TC${String(i + 1).padStart(3, "0")}`),
        title: String(item.title ?? "未命名用例"),
        scenario: String(item.scenario ?? ""),
        steps: Array.isArray(item.steps) ? item.steps.map((s) => String(s)) : [],
        expected: String(item.expected ?? ""),
        priority: (item.priority === "low" || item.priority === "high" ? item.priority : "medium") as "low" | "medium" | "high",
        layer: (item.layer === "unit" || item.layer === "api" || item.layer === "ui" ? item.layer : "unit") as "unit" | "api" | "ui",
        ...(typeof item.target === "string" ? { target: item.target } : {}),
        ...(typeof item.method === 'string' ? { method: item.method } : {}),
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(item.body !== undefined ? { body: item.body } : {}),
        ...(typeof item.expectedStatus === 'number' ? { expectedStatus: item.expectedStatus } : {}),
        ...(Array.isArray(item.expectedBodyContains) ? { expectedBodyContains: item.expectedBodyContains.map(String) } : {}),
        ...(item.expectedJsonSubset && typeof item.expectedJsonSubset === 'object' && !Array.isArray(item.expectedJsonSubset) ? { expectedJsonSubset: item.expectedJsonSubset as Record<string, unknown> } : {}),
        ...(item.structuredScenario && typeof item.structuredScenario === "object" ? { structuredScenario: item.structuredScenario as StructuredScenario } : {}),
      }));
  };

  try {
    return normalizeCases(JSON.parse(jsonStr) as unknown);
  } catch {
    // JSON 解析失败——尝试修复 LLM 常见的未转义引号问题
    // LLM 常在字符串值内用未转义的 " 引用内容（如 选择"需求透明化协作平台"后）
    // 修复策略：非结构性引号（前后都不是 JSON 结构字符 : , { } [ ] 和空白，且前面不是 \）视为内容引号，转义为 \"
    try {
      let prev = jsonStr;
      let fixed = jsonStr;
      let pass = 0;
      do {
        prev = fixed;
        fixed = fixed.replace(/([^\s:,\[\]{}\\])"([^\s:,\[\]{}])/g, '$1\\"$2');
        pass++;
      } while (fixed !== prev && pass < 20);
      return normalizeCases(JSON.parse(fixed) as unknown);
    } catch {
      // 更宽容的字符级修复：字符串中的裸双引号，仅当其后是 JSON
      // 结构字符（, } ] :）或输入末尾时才视为字符串结束，否则转义为内容。
      // 例如 LLM 常输出："expected": "以(\"\", "空eventKey)调用"。
      try {
        let repaired = "";
        let inString = false;
        let escaped = false;
        for (let i = 0; i < jsonStr.length; i++) {
          const ch = jsonStr[i];
          if (!inString) {
            repaired += ch;
            if (ch === '"') inString = true;
            continue;
          }
          if (escaped) {
            repaired += ch;
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            repaired += ch;
            escaped = true;
            continue;
          }
          if (ch !== '"') {
            repaired += ch;
            continue;
          }
          let next = i + 1;
          while (next < jsonStr.length && /\s/.test(jsonStr[next])) next++;
          const nextChar = jsonStr[next];
          if (next >= jsonStr.length || nextChar === "," || nextChar === "}" || nextChar === "]" || nextChar === ":") {
            repaired += ch;
            inString = false;
          } else {
            repaired += '\\"';
          }
        }
        return normalizeCases(JSON.parse(repaired) as unknown);
      } catch {
        return [];
      }
    }
  }
}

/** 执行阶段 prompt：把 cases 作为锚点注入，LLM 按计划逐条实现测试。 */
export function buildExecutionPrompt(input: TaskInput, cases: TestCase[], knowledge?: string, hasEscalation?: boolean): string {
  // hasEscalation：tester 角色配 escalation:true 且 EscalationHandler 可用时为 true。
  // 顶部 escalate 提示块（hasEscalation 条件）已替代原 escalateAction 变量逻辑：
  // 引导 LLM 在写测试前先做 target/expected 校验 gate，不符则 escalate
  // （无 escalate 工具时标"target 未找到"跳过，同现状行为）。
  const lines: string[] = [
    `你是测试执行代理。在当前项目内完成真实测试，不得虚构结果。`,
    `所有回复必须使用中文。`,
    "",
    `系统：${input.systemName}`,
    `版本：${input.version || "未识别"}`,
    `测试类型：${input.testTypes.join(", ")}`,
    "",
    ...(hasEscalation
      ? [
          `【⚠️ 写测试前必读——何时 escalate（不得自行合理化）】`,
          `遇到以下情况必须调 escalate 工具停下提问，不得为了把任务做完而自行替换被测对象、改写 expected、或测能测的：`,
          `- target 指向的文件/函数不存在，或与代码结构严重不符 → escalate，不得自行替换目标`,
          `- expected 与代码行为有张力（如 target 指向 add 但 expected 描述乘法 add(3,4)===12）→ escalate，不得自行改写 expected`,
          `- 需在多个 equally reasonable 的测试写法间选择且影响面大 → escalate`,
          `- 任何让你想"猜一下"或"测个能过的交差"的情况 → escalate`,
          `不要 escalate：常规进度/能从代码明确读出答案/target 与 expected 一致无张力。`,
          `调 escalate 时：question 写清哪条用例、target/expected 如何不符、代码现状；fallback 给保守方案（超时则按 expected 字面写断言让测试失败报告原始结果）。`,
          "",
        ]
      : [
          `【⚠️ 写测试前必读】target 不存在或与代码结构严重不符 → 标"target 未找到"跳过该用例，不自行替换被测对象或改写 expected。`,
          "",
        ]),
    `以下是已确认的测试计划，你必须严格按计划执行，不得增减用例。下面每一行是一条独立用例，target= 是该用例必须 read 校验的代码路径，预期= 是该用例的断言依据：`,
    "",
    ...cases.map((c) => {
      if (input.testStrategy === 'reflect' && c.structuredScenario) {
        return `- ${c.id} | layer=${c.layer} | target=${c.structuredScenario.target?.className ? c.structuredScenario.target.className + '#' + c.structuredScenario.target.method : c.title}\n  场景 JSON: ${JSON.stringify(c.structuredScenario)}\n  → 用 reflect_test 工具执行（传 scenarios 数组传入所有场景），不写 Java 测试代码`;
      }
      const apiContract = c.layer === 'api'
        ? ` | API契约=${JSON.stringify({ method: c.method, path: c.path, body: c.body, expectedStatus: c.expectedStatus, expectedBodyContains: c.expectedBodyContains, expectedJsonSubset: c.expectedJsonSubset })}`
        : '';
      return `- ${c.id} | layer=${c.layer} | target=${c.target ?? c.title}（写测试前必须 read 此路径校验存在）| 场景: ${c.scenario} | 预期: ${c.expected}${apiContract}`;
    }),
    "",
    ...(input.testStrategy === 'reflect'
      ? [
          "执行步骤（每轮都必须调用工具，禁止只读不写）：",
          "1. 逐条校验 target.className/method 存在（read 源码确认方法签名）",
          "2. 最多 read 2-3 个核心源码文件，确认参数类型和返回类型",
          "3. 用 reflect_test 工具执行（传 scenarios 数组，把所有用例的 structuredScenario 一次性传入）",
          "4. 根据 reflect_test 返回结果报告通过/失败，不写 Java 测试代码",
          "5. 结束任务，无论通过还是失败",
          "",
          "规则：",
          "- 【最高优先级】必须调 reflect_test 执行测试，不写 Java 代码",
          "- 严格按测试计划执行，不增减用例",
          "- 不用 write 创建测试文件，不用 maven_test",
          "- reflect_test 返回的失败结果直接报告，不修复（诊断修复由独立阶段处理）",
        ]
      : [
          "执行步骤（每轮都必须调用工具，禁止只读不写）：",
          "1. 逐条校验 target 存在 + expected 与代码一致（见上方【写测试前必读】，不符则 escalate/标未找到，不得跳过校验）",
          "2. 最多 read 2-3 个核心源码文件，校验通过后写测试",
          "3. 用 write 创建测试文件（一个文件覆盖多条用例即可）",
          "4. 用测试工具执行测试（maven_test/node_test/playwright_test/api_test，不要用 bash）",
          "5. 跑完报告结果，不修改任何代码（不调 edit）",
          "6. 结束任务，无论通过还是失败",
          "",
          "规则：",
          "- 【最高优先级】前 2 轮内必须开始校验+写测试，不得连续 3 轮只 read",
          "- 严格按测试计划执行，不增减用例",
          "- 【证据链】每个生成的测试必须携带对应计划用例 ID：Java/JUnit 同时使用 @DisplayName(\"[CASE:<用例ID>] 用例标题\")，测试方法名以 case_<用例ID>_ 开头；Node/Playwright/API 的测试标题以 [CASE:<用例ID>] 开头。不得省略或改写 ID",
          "- 必须调测试工具执行真实测试，不用 bash，不虚构结果",
          '- 无测试设施时建最小可编译测试覆盖 1-2 个核心类，不以"无测试设施"跳过',
          "- 测试产物写项目目录内（建议 .test-agent/results）",
          "- 不修代码（不调 edit），不修测试配置文件（playwright/vitest/jest.config）",
          "- playwright_test 必须传 file 参数指定你写的测试文件",
          "- 失败数=总数时先查原始输出（dev server/语法错误/跑错文件），不盲目重试",
          "- 失败不修复，报告原始结果（诊断修复由独立阶段处理）",
          "- 连续 3 次失败数不减少则收敛，接受部分通过（如 4/7）",
        ]),
  ];

  if (input.coverageTarget) {
    lines.push(`- 覆盖率目标：${input.coverageTarget}%`);
  }
  if (input.targetClasses && input.targetClasses.length > 0) {
    lines.push(`- 重点测试目标：${input.targetClasses.join(", ")}`);
  }
  if (input.apiBaseUrl) {
    lines.push(`- API 基础 URL：${input.apiBaseUrl}`);
  }
  if (input.uiEntryUrl) {
    lines.push(`- UI 入口 URL：${input.uiEntryUrl}`);
  }
  if (knowledge) {
    lines.push("", "【知识库参考】", knowledge);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createRunner(): AgentAdapter | null {
  const config = loadAiConfig();
  if (!config) return null;
  const providerId = process.env.TEST_AGENT_NATIVE_PROVIDER;
  const modelId = process.env.TEST_AGENT_NATIVE_MODEL;
  const scenarioName = process.env.TEST_AGENT_SCENARIO;
  return new Runner(config, providerId, modelId, scenarioName);
}
