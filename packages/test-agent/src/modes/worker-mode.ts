/**
 * Worker mode — 无人值守领任务跑测试。
 *
 * 从 control-server HTTP API 领任务 → 用 AgentAdapter（cimicode/ai-native/...）
 * 执行 → 上报结果 + 制品。
 *
 * 与旧 worker-cli.ts 的区别：不再走 test-kernel pipeline（runTestWorkflow），
 * 而是直接调 adapter.run()。agent-core agentLoop 内部已有多轮工具调用 + 自修复
 * 循环，替代了 test-kernel 的 for-attempt feedback 循环。
 *
 * 参考 pi 的 modes/print-mode.ts（headless 单次执行模式），但不依赖 AgentSession。
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createAgentAdapter } from "../core/factory.js";
import { inspectProjectSupport } from '../core/project-support.js'
import type { AgentEvent, AgentRunContext, AgentRunResult } from "../core/types.js";
import { log } from "../core/types.js";
import { EscalationHandler } from "../core/escalation-handler.js";
import { resolveBundledPlaywrightCli } from "../core/validator.js";
import type { TaskInput } from "@cxmt/protocol";
import { authorizeProjectPath, parseAllowedProjectRoots } from "../core/security.js";
import { configuredCapabilities, playwrightRuntimeAvailable } from './capabilities.js'

// ---------------------------------------------------------------------------
// 配置（从环境变量读取）
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  serverUrl: string;
  apiToken?: string;
  dataDirectory: string;
  capabilities: string[];
  allowedProjectRoots: string[];
  workerName: string;
}

export function parseWorkerConfig(): WorkerConfig {
  const serverUrl = (process.env.TEST_AGENT_SERVER_URL ?? "http://127.0.0.1:8088").replace(/\/$/, "");
  const apiToken = process.env.TEST_AGENT_WORKER_API_TOKEN ?? process.env.TEST_AGENT_API_TOKEN;
  const dataDirectory = resolve(
    process.env.TEST_AGENT_WORKER_DATA_DIR ?? join(process.cwd(), ".test-agent-worker"),
  );
  const capabilities = configuredCapabilities(process.env.TEST_AGENT_WORKER_CAPABILITIES);
  const allowedProjectRoots = parseAllowedProjectRoots(process.env.TEST_AGENT_ALLOWED_PROJECT_ROOTS);
  const workerName = process.env.TEST_AGENT_WORKER_NAME ?? `${process.env.COMPUTERNAME ?? "worker"}`;
  return { serverUrl, apiToken, dataDirectory, capabilities, allowedProjectRoots, workerName };
}

// ---------------------------------------------------------------------------
// Worker 身份 + HTTP 客户端
// ---------------------------------------------------------------------------

interface ClaimedTask {
  taskId: string;
  input: TaskInput;
}

interface WorkerClient {
  workerId: string;
  workerSecret: string;
  config: WorkerConfig;
  register(): Promise<void>;
  claimTask(): Promise<ClaimedTask | undefined>;
  emitEvent(taskId: string, event: AgentEvent): Promise<void>;
  uploadArtifacts(task: ClaimedTask, result: AgentRunResult): Promise<void>;
  completeTask(taskId: string, result: AgentRunResult): Promise<void>;
  failTask(taskId: string, error: string): Promise<void>;
  heartbeat(taskId: string): Promise<void>;
  checkCancelled(taskId: string): Promise<boolean>;
}

function createWorkerClient(config: WorkerConfig): WorkerClient {
  const { serverUrl, apiToken, dataDirectory } = config;

  // 持久化 worker 身份
  mkdirSync(dataDirectory, { recursive: true });
  const idPath = join(dataDirectory, "worker-id.txt");
  const workerId = existsSync(idPath) ? readFileSync(idPath, "utf8").trim() : randomUUID();
  if (!existsSync(idPath)) writeFileSync(idPath, workerId, "utf8");
  const secretPath = join(dataDirectory, "worker-secret.txt");
  let workerSecret = existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  if (existsSync(secretPath)) chmodSync(secretPath, 0o600);

  function headers(): Record<string, string> {
    return { "x-worker-id": workerId, "x-worker-secret": workerSecret };
  }

  async function request<T>(path: string, init?: RequestInit, extraHeaders?: Record<string, string>): Promise<T> {
    const response = await fetch(`${serverUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
        ...(extraHeaders ?? {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  return {
    workerId,
    workerSecret,
    config,
    async register(): Promise<void> {
      const response = await request<{ secret?: string }>(
        "/api/workers/register",
        { method: "POST", body: JSON.stringify({ id: workerId, name: config.workerName, capabilities: config.capabilities }) },
        workerSecret ? headers() : undefined,
      );
      if (response.secret) {
        workerSecret = response.secret;
        writeFileSync(secretPath, workerSecret, { encoding: "utf8", mode: 0o600 });
        chmodSync(secretPath, 0o600);
      }
      console.log(`Worker ${config.workerName} registered at ${serverUrl}`);
    },

    async claimTask(): Promise<ClaimedTask | undefined> {
      return request<ClaimedTask | undefined>(
        "/api/worker/tasks/claim",
        { method: "POST", body: JSON.stringify({ workerId, capabilities: config.capabilities }) },
        headers(),
      );
    },

    async emitEvent(taskId: string, event: AgentEvent): Promise<void> {
      await request(`/api/worker/tasks/${taskId}/events`, { method: "POST", body: JSON.stringify(event) }, headers());
    },

    async uploadArtifacts(task: ClaimedTask, result: AgentRunResult): Promise<void> {
      for (const artifact of result.artifacts) {
        const absolute = resolve(task.input.projectPath, artifact);
        const root = resolve(task.input.projectPath);
        const withinRoot = relative(root, absolute);
        if (withinRoot.startsWith("..") || isAbsolute(withinRoot) || !existsSync(absolute)) continue;
        const form = new FormData();
        form.append("file", new Blob([readFileSync(absolute)]), basename(absolute));
        const response = await fetch(`${serverUrl}/api/worker/tasks/${task.taskId}/artifacts`, {
          method: "POST",
          body: form,
          headers: { ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}), ...headers() },
        });
        if (!response.ok) throw new Error(`Artifact upload failed: ${response.status} ${await response.text()}`);
      }
    },

    async completeTask(taskId: string, result: AgentRunResult): Promise<void> {
      await request(`/api/worker/tasks/${taskId}/complete`, { method: "POST", body: JSON.stringify({ result }) }, headers());
    },

    async failTask(taskId: string, error: string): Promise<void> {
      await request(`/api/worker/tasks/${taskId}/fail`, { method: "POST", body: JSON.stringify({ error }) }, headers());
    },

    async heartbeat(taskId: string): Promise<void> {
      await request(
        `/api/worker/tasks/${taskId}/heartbeat?workerId=${encodeURIComponent(workerId)}`,
        { method: "POST" },
        headers(),
      );
    },

    async checkCancelled(taskId: string): Promise<boolean> {
      const state = await request<{ status: string }>(`/api/worker/tasks/${taskId}/status`, undefined, headers());
      return state.status === "CANCELLED";
    },
  };
}

// ---------------------------------------------------------------------------
// 环境预检
// ---------------------------------------------------------------------------

const TOOL_CHECKS: Record<string, { command: string; args: string[] }> = {
  node: { command: "node", args: ["--version"] },
  npm: { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["--version"] },
  pnpm: { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: ["--version"] },
  yarn: { command: process.platform === "win32" ? "yarn.cmd" : "yarn", args: ["--version"] },
  bun: { command: process.platform === "win32" ? "bun.exe" : "bun", args: ["--version"] },
  java: { command: "java", args: ["-version"] },
  maven: { command: process.platform === "win32" ? "mvn.cmd" : "mvn", args: ["--version"] },
  gradle: { command: process.platform === "win32" ? "gradle.bat" : "gradle", args: ["--version"] },
  codex: { command: process.platform === "win32" ? "codex.cmd" : "codex", args: ["--version"] },
  playwright: { command: "node", args: [resolveBundledPlaywrightCli(), "--version"] },
};

function toolVersion(command: string, args: string[]): string | null {
  try {
    const windowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    const result = windowsScript
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], { encoding: "utf8", timeout: 10_000, windowsHide: true })
      : spawnSync(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status !== 0) return null;
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

interface PreflightResult {
  ok: boolean;
  issues: string[];
  summary: string;
}

function preflightEnvironment(input: TaskInput, providerName: string, config: WorkerConfig): PreflightResult {
  const issues: string[] = [];
  const details: string[] = [];
  const authorization = authorizeProjectPath(input.projectPath, config.allowedProjectRoots);
  if (!authorization.ok) issues.push(authorization.reason ?? "Project path authorization failed");
  else if (!statSync(authorization.resolvedPath!).isDirectory()) issues.push(`项目路径不是目录：${input.projectPath}`);
  else {
    const support = inspectProjectSupport(authorization.resolvedPath!);
    if (!support.supported) issues.push(support.reason ?? `不支持的项目类型：${support.kind}`);
  }
  for (const capability of input.requiredCapabilities ?? []) {
    const check = TOOL_CHECKS[capability];
    if (!check) continue;
    const version = toolVersion(check.command, check.args);
    if (capability === 'playwright' && version && !playwrightRuntimeAvailable()) {
      issues.push('缺少工具链：playwright（未找到可启动的 Microsoft Edge 或 Playwright Chromium 浏览器）');
    } else if (version) details.push(`${capability} ${version}`);
    else issues.push(`缺少工具链：${capability}`);
  }
  const summary = [`os=${platform()} ${release()}`, `node=${process.version}`, `provider=${providerName}`, `worker=${config.workerName}`, ...details].join(" | ");
  return { ok: issues.length === 0, issues, summary };
}

// ---------------------------------------------------------------------------
// 任务执行
// ---------------------------------------------------------------------------

/**
 * 执行单个任务：预检 → agent adapter.run() → 上报结果。
 *
 * 不再走 test-kernel pipeline。adapter（cimicode/ai-native）内部已用 agent-core
 * agentLoop 实现多轮工具调用 + 自修复。test-kernel 的 feedback 循环 + quality gate
 * 由 agent loop 取代。
 */
async function runTask(task: ClaimedTask, client: WorkerClient): Promise<void> {
  const adapter = createAgentAdapter();
  if (!adapter) throw new Error("No executable Agent Provider is configured");

  const preflight = preflightEnvironment(task.input, adapter.name, client.config);
  if (!preflight.ok) {
    const message = `环境预检未通过：${preflight.issues.join("；")}`;
    await client.emitEvent(task.taskId, log("error", message));
    throw new Error(message);
  }
  await client.emitEvent(task.taskId, log("info", `环境预检通过：${preflight.summary}`));
  await client.emitEvent(task.taskId, log("info", `进入阶段：GENERATING`, "GENERATING"));

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void client.heartbeat(task.taskId).catch(console.error);
    void client.checkCancelled(task.taskId).then((cancelled) => {
      if (cancelled) controller.abort();
    }).catch(console.error);
  }, 15_000);

  try {
    // 构造 EscalationHandler（worker-mode 无人盯，无 notifyFn，依赖 ask 内 setTimeout 超时降级；片C：审计日志 projectPath）
    const escalationHandler = new EscalationHandler(
      (msg, agent) => agent.steer({ role: "user", content: msg, timestamp: Date.now() }),
      undefined, // 无 GUI，不通知
      undefined, undefined,
      { projectPath: task.input.projectPath },
    );

    // Fitness-driven 自修复（PRD 功能一）：adapter 支持 runFitnessDrivenExecute 时启用
    const fitnessDriven = typeof adapter.runFitnessDrivenExecute === "function";
    if (fitnessDriven) {
      await client.emitEvent(task.taskId, log("info", `Fitness-driven 自修复已启用`));
    }
    const result = await adapter.run(
      task.input,
      (event) => client.emitEvent(task.taskId, event),
      controller.signal,
      { taskId: task.taskId, escalationHandler, ...(fitnessDriven ? { fitnessDriven: true } : {}) },
    );

    await client.uploadArtifacts(task, result);
    await client.completeTask(task.taskId, result);
  } catch (error) {
    if (!controller.signal.aborted) {
      await client.failTask(task.taskId, error instanceof Error ? error.message : "Worker execution failed");
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 运行 worker 循环：注册 → 轮询领任务 → 执行 → 重复。
 *
 * @param config Worker 配置（默认从环境变量解析）
 * @param signal 停止信号（如 SIGINT/SIGTERM 触发）
 */
export async function runWorkerMode(config?: WorkerConfig, signal?: AbortSignal): Promise<void> {
  const workerConfig = config ?? parseWorkerConfig();
  const client = createWorkerClient(workerConfig);
  let stopping = false;

  const onAbort = () => { stopping = true; };
  signal?.addEventListener("abort", onAbort, { once: true });

  // register 重试循环（server 短暂不可用是常态，不崩溃）
  while (!stopping) {
    try {
      if (signal?.aborted) break;
      await client.register();
      break; // register 成功，进 main loop
    } catch (error) {
      console.error(`[worker] register 失败，5s 后重试：${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
    }
  }

  while (!stopping) {
    try {
      if (signal?.aborted) break;
      const task = await client.claimTask();
      if (task) {
        await runTask(task, client);
      } else {
        await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
      }
    } catch (error) {
      console.error(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
    }
  }

  signal?.removeEventListener("abort", onAbort);
}

// ---------------------------------------------------------------------------
// CLI 入口（可直接 node 执行）
// ---------------------------------------------------------------------------

export async function runWorkerCli(): Promise<void> {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await runWorkerMode(undefined, controller.signal);
}

// 自启动：node packages/test-agent/dist/modes/worker-mode.js 直接执行时触发
// Importing @cxmt/test-agent from the desktop Host must not start the remote Worker.
// Bundled host-cli output also has import.meta.url === process.argv[1], so require
// the dedicated worker-mode filename in addition to the direct-entry comparison.
export function isDirectWorkerEntry(moduleUrl: string, entryArg: string | undefined): boolean {
  return Boolean(entryArg && /^worker-mode\.(?:js|ts)$/.test(basename(entryArg)) &&
    resolve(entryArg) === fileURLToPath(moduleUrl));
}

if (isDirectWorkerEntry(import.meta.url, process.argv[1])) {
  void runWorkerCli();
}
