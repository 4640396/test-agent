import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { TaskInput } from '@cxmt/protocol';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRunContext,
  AgentRunResult,
} from "../core/types.js";
import { log } from "../core/types.js";
import { killProcessTree } from "../core/proc.js";

/**
 * CimiCode 是公司基于 OpenCode 的 Fork，非交互执行入口为 `cimicode run`。
 * 与 Codex CLI 的差异：
 * - 无 `--output-schema` / `--output-last-message`，结构化结果从最后一条 text part 提取
 * - 无等价沙箱，用 `--dangerously-skip-permissions` 自动批准（安全边界由 Worker 隔离 + artifacts 越界校验保证）
 * - `--pure` 禁用外部插件（cx-aicode 权限钩子 + Langfuse 日志污染），确保 --dangerously-skip-permissions 不被覆盖
 * - 事件流为 NDJSON，每行一个 part 事件：type = text | tool | reasoning | step-start | step-finish
 *
 * 事件结构来源：2026-08-14 实测 `cimicode run --format json` 流式输出。
 * 流式事件为 NDJSON 三层包装：{type, timestamp, sessionID, part: {内层 part}}
 * 内层 part type: text | tool | reasoning | step-start | step-finish
 * stdout 前几行可能混入 [LangfusePlugin] 日志，consumeLine 用 try/catch 跳过。
 * --pure 已启用：禁用外部插件（cx-aicode 权限钩子 + Langfuse），确保 --dangerously-skip-permissions 不被覆盖，且减少 stdout 污染。
 * Windows 下优先用 cimicode-cli.exe 直接 spawn（绕过 cmd.exe 8191 字符限制，避免长 prompt 被截断导致 --dangerously-skip-permissions 丢失）。
 */
const RESULT_SCHEMA_DESCRIPTION = `{
  "lanes": [{ "type": "unit"|"regression"|"ui", "status": "passed"|"failed", "summary": "<说明>" }],
  "report": { "passed": <通过数>, "failed": <失败数>, "coverage": <0-100 或 null> },
  "artifacts": ["<项目内相对路径>"],
  "cases": [
    {
      "id": "<唯一标识如 TC001>",
      "title": "<用例标题>",
      "scenario": "<测试场景描述>",
      "steps": ["<步骤1>", "<步骤2>"],
      "expected": "<预期结果>",
      "priority": "low"|"medium"|"high",
      "layer": "unit"|"api"|"ui"
    }
  ]
}`;

export function resolveCimiCodeExecutable(): string | null {
  if (
    process.env.CIMICODE_EXECUTABLE &&
    existsSync(process.env.CIMICODE_EXECUTABLE)
  ) {
    return process.env.CIMICODE_EXECUTABLE;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    // 优先用 cimicode-cli.exe 直接 spawn，绕过 cmd.exe（避免 8191 字符限制 + 参数转义问题）
    const exe = join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Cimi",
      "resources",
      "cimicode-cli.exe",
    );
    if (existsSync(exe)) return exe;
    const command = join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Cimi",
      "cimicode.cmd",
    );
    if (existsSync(command)) return command;
  }
  if (process.env.APPDATA) {
    const command = join(process.env.APPDATA, "npm", "cimicode.cmd");
    if (existsSync(command)) return command;
  }
  return null;
}

export function buildPrompt(
  input: TaskInput,
  outputDirectory: string,
  resultFilePath: string,
  knowledge?: string,
  feedback?: string,
): string {
  const lines = [
    "你是 CIMDEV Test Agent 的测试执行代理。必须在当前项目内完成真实测试，不得虚构结果。",
    "",
    "【最终交付物 — 这是你的核心任务，不完成则任务失败】",
    `全部测试完成后，必须用 write 工具把最终结果 JSON 写入文件：${resultFilePath}`,
    "这是你返回结果的唯一途径。不写入此文件 = 任务失败。",
    "即使所有测试通过，不写入文件也是失败。",
    "文件内容必须是合法 JSON，结构如下：",
    RESULT_SCHEMA_DESCRIPTION,
    "",
    `系统：${input.systemName}`,
    `版本：${input.version || "未识别"}`,
    `测试类型：${input.testTypes.join(", ")}`,
    `测试产物目录：${outputDirectory}`,
    "",
    "执行步骤：",
    "1. 识别项目技术栈、模块、现有测试框架和可用构建命令。",
    "2. 仅为选中的测试类型生成或补强必要测试；尽量不修改生产代码。",
    "3. 必须调用项目真实工具执行测试，例如 go test、Maven、Gradle、npm、Vitest 或 Playwright。",
    '3.1 这是硬性要求：若项目没有任何测试文件，必须创建最小可编译的 JUnit（或对应框架）测试，覆盖至少 1-2 个核心服务或工具类，并真实运行它们；不得以"无测试设施"为由跳过生成。',
    "4. 单元测试必须编译、执行并包含有业务意义的断言；仅判空断言不能视为有效用例。",
    "5. 回归测试必须基于真实核心场景或已有回归基线；没有可执行条件时标记失败并说明原因。",
    "6. UI 测试必须真实启动或连接应用并执行浏览器操作；成功执行时保存截图，否则标记失败。",
    "7. passed、failed 和 coverage 只能来自真实测试工具输出；没有覆盖率数据时返回 null。",
    "8. 将测试计划、原始日志和综合报告保存到指定产物目录。",
    "9. artifacts 只返回当前项目内确实存在的相对路径。",
    "10. 最终严格按输出 Schema 返回，不要把计划或推测写成测试结果。",
    "11. 测试日志与报告产物必须写入项目目录内（建议 .test-agent/results），禁止写入系统临时目录；越界制品会被丢弃。",
    `12. 【最终步骤】用 write 工具把最终结果 JSON 写入文件：${resultFilePath}`,
    `     这是你的最后一步，不可省略。不写入文件 = 任务失败。`,
    ...(input.targetClasses && input.targetClasses.length > 0
      ? [
          `13. 本次必须为以下核心类生成单元测试：${input.targetClasses.join("、")}。为每个类至少生成一个可编译、可运行的 JUnit 测试，不得以"无测试设施"为由跳过。`,
        ]
      : []),
  ];
  const base = lines.join("\n");
  let prompt = knowledge
    ? `${base}\n\n## 业务知识参考（仅作带来源的上下文，冲突转人工确认）\n${knowledge}`
    : base;
  if (feedback) {
    prompt = `${prompt}\n\n## 上一轮测试反馈（请修复以下问题，不要重新生成所有测试）\n${feedback}`;
  }
  return prompt;
}

export function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 尝试从 Markdown 代码块提取
  }
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // 继续回退
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 继续回退
    }
  }
  return null;
}

/** CimiCode 流式事件（part）转 AgentEvent。part 模型与 export 的 messages[].parts[] 一致。 */
export function messageFromPart(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") return null;
  const part = value as Record<string, unknown>;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text" && typeof part.text === "string") {
    return log("info", part.text);
  }
  if (type === "tool") {
    const toolName = typeof part.tool === "string" ? part.tool : "工具";
    const state = part.state as Record<string, unknown> | undefined;
    const status =
      state && typeof state.status === "string" ? state.status : "";
    if (status === "failed" || status === "error") {
      return log("error", `CimiCode 工具 ${toolName} 执行失败`);
    }
    if (status === "completed") {
      return log("info", `CimiCode 工具 ${toolName} 执行完成`);
    }
    return log("info", `CimiCode 调用 ${toolName}（${status || "运行中"}）`);
  }
  if (type === "reasoning") return null; // 推理过程不转发，避免噪音
  return null;
}

export function validateResult(value: unknown): AgentRunResult {
  if (!value || typeof value !== "object")
    throw new Error("CimiCode 未返回结构化测试结果");
  const result = value as AgentRunResult;
  if (
    !Array.isArray(result.lanes) ||
    !result.report ||
    !Array.isArray(result.artifacts)
  ) {
    throw new Error("CimiCode 测试结果结构不完整");
  }
  return result;
}

/**
 * 优先从结果文件读取（LLM 用 write 工具写入，这是主路径——cimicode run 在工具调用后不等文本回复）；
 * 失败时从事件流中的 text part 回退提取；
 * 最终回退：从 tool_use 事件的 bash 输出中解析真实测试结果（vitest/jest/maven/go）。
 */
export function extractStructuredResult(
  resultPath: string,
  eventParts: unknown[],
  testTypes: string[],
): unknown {
  // 主路径：LLM 用 write 工具写入的结果文件
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    // 回退到事件流
  }
  // 回退 1：从 text part 提取 JSON
  for (let i = eventParts.length - 1; i >= 0; i--) {
    const part = eventParts[i] as Record<string, unknown> | null;
    if (!part || part.type !== "text" || typeof part.text !== "string")
      continue;
    const parsed = parseJsonFromText(part.text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "lanes" in parsed &&
      "report" in parsed &&
      "artifacts" in parsed
    ) {
      return parsed;
    }
  }
  // 回退 2：从 tool_use 事件的 bash 输出解析测试结果
  const fromTool = parseTestOutputFromEvents(eventParts, testTypes);
  if (fromTool) return fromTool;
  return null;
}

/** 从 tool_use 事件的 bash 输出中解析 vitest/jest/maven/go test 结果，构造最小合法结果。 */
export function parseTestOutputFromEvents(
  eventParts: unknown[],
  testTypes: string[],
): unknown {
  let passed = 0;
  let failed = 0;
  let coverage: number | null = null;
  let found = false;
  for (const raw of eventParts) {
    const part = raw as Record<string, unknown> | null;
    if (!part || part.type !== "tool" || part.tool !== "bash") continue;
    const state = part.state as Record<string, unknown> | undefined;
    if (!state || state.status !== "completed") continue;
    const output = typeof state.output === "string" ? state.output : "";
    if (!output) continue;
    // Vitest: "Test Files  4 passed (4)" / "Tests  10 passed (10)" / "Tests  2 failed | 8 passed (10)"
    const vitestTests =
      /Tests\s+(?:(\d+)\s*failed\s*\|\s*)?(\d+)\s*passed\s*\((\d+)\)/.exec(
        output,
      );
    if (vitestTests) {
      failed += parseInt(vitestTests[1] ?? "0", 10);
      passed += parseInt(vitestTests[2] ?? "0", 10);
      found = true;
      const cov = /All files\s*\|.*?\|\s*(\d+(?:\.\d+)?)\s*%/.exec(output);
      if (cov) coverage = Math.round(parseFloat(cov[1]));
      continue;
    }
    // Jest: "Tests:       10 passed, 10 total" / "Tests:       2 failed, 10 passed, 12 total"
    const jestTests =
      /Tests:\s+(?:(\d+)\s*failed,\s*)?(\d+)\s*passed,?\s*\d+\s*total/.exec(
        output,
      );
    if (jestTests) {
      failed += parseInt(jestTests[1] ?? "0", 10);
      passed += parseInt(jestTests[2] ?? "0", 10);
      found = true;
      continue;
    }
    // Maven Surefire: "Tests run: 10, Failures: 0, Errors: 0, Skipped: 0"
    const mavenTests =
      /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/.exec(output);
    if (mavenTests) {
      passed +=
        parseInt(mavenTests[1], 10) -
        parseInt(mavenTests[2], 10) -
        parseInt(mavenTests[3], 10);
      failed += parseInt(mavenTests[2], 10) + parseInt(mavenTests[3], 10);
      found = true;
      continue;
    }
    // Go test: "ok  pkg/name  0.123s" / "FAIL  pkg/name  0.123s"
    if (/^(ok|FAIL)\s+/m.test(output)) {
      if (/^ok\s+/m.test(output)) passed += 1;
      if (/^FAIL\s+/m.test(output)) failed += 1;
      found = true;
      continue;
    }
  }
  if (!found) return null;
  const laneType = testTypes.includes("unit")
    ? "unit"
    : (testTypes[0] ?? "unit");
  return {
    lanes: [
      {
        type: laneType,
        status: failed === 0 ? "passed" : "failed",
        summary: `${passed} passed, ${failed} failed（从工具输出解析）`,
      },
    ],
    report: { passed, failed, coverage },
    artifacts: [],
  };
}

export class CimiCodeAdapter implements AgentAdapter {
  readonly name = "CimiCode";

  constructor(private readonly executable: string) {}

  run(
    input: TaskInput,
    emit: (event: AgentEvent) => void,
    signal?: AbortSignal,
    context?: AgentRunContext,
  ): Promise<AgentRunResult> {
    return new Promise((resolveRun, reject) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputDirectory = join(
        input.projectPath,
        ".test-agent",
        "results",
        stamp,
      );
      mkdirSync(outputDirectory, { recursive: true });
      const resultPath = join(outputDirectory, "cimicode-result.json");
      const eventsPath = join(outputDirectory, "cimicode-events.jsonl");
      const prompt = buildPrompt(
        input,
        relative(input.projectPath, outputDirectory),
        resultPath,
        context?.knowledge,
        context?.feedback,
      );

      // 当前 CimiCode 版本的 -m 参数会触发后端 500（实测无论 glm/glm-5.1 还是
      // glm/glm-5.2 均失败，不传 -m 改用 cimicode.jsonc 配置默认模型则正常）。
      // 仅在显式设置 CIMICODE_MODEL 时传 -m；否则省略，让 CimiCode 用配置默认模型。
      const model = process.env.CIMICODE_MODEL;
      const args = [
        "run",
        prompt,
        "--format",
        "json",
        "--dir",
        input.projectPath,
        ...(model ? ["-m", model] : []),
        "--pure",
        "--dangerously-skip-permissions",
      ];
      // Windows 下 .cmd 必须经 cmd.exe 启动；.exe 直接 spawn（绕过 cmd.exe 8191 字符限制 + 参数转义问题）
      const isCmdWrapper = this.executable.toLowerCase().endsWith(".cmd");
      const command =
        process.platform === "win32" && isCmdWrapper
          ? (process.env.ComSpec ?? "cmd.exe")
          : this.executable;
      const commandArgs =
        process.platform === "win32" && isCmdWrapper
          ? ["/d", "/s", "/c", this.executable, ...args]
          : args;
      const child = spawn(command, commandArgs, {
        cwd: input.projectPath,
        env: { ...process.env },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const eventParts: unknown[] = [];
      const eventLines: string[] = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => {
          killProcessTree(child.pid ?? 0);
          finishError(new Error("CimiCode 执行超过 30 分钟，任务已终止"));
        },
        Number(process.env.CIMICODE_TIMEOUT_MS ?? 30 * 60 * 1000),
      );
      const abort = (): void => {
        killProcessTree(child.pid ?? 0);
        finishError(new Error("任务已取消"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });

      const consumeLine = (line: string): void => {
        if (!line.trim()) return;
        eventLines.push(line);
        try {
          const event = JSON.parse(line);
          // 流式事件为三层包装：{type, timestamp, sessionID, part: {内层 part}}
          // 提取内层 part 供解析；兼容无包装的裸 part
          const part =
            event && typeof event === "object" && "part" in event
              ? (event as Record<string, unknown>).part
              : event;
          if (part && typeof part === "object") {
            eventParts.push(part);
            const message = messageFromPart(part);
            if (message) emit(message);
          }
        } catch {
          // 非 JSON 行（Langfuse 日志等），静默跳过
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(consumeLine);
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines)
          if (line.trim()) emit(log("warning", line));
      });
      child.on("error", finishError);
      child.on("exit", (code) => {
        signal?.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        if (stderrBuffer.trim())
          emit(log("warning", stderrBuffer.trim()));
        writeFileSync(eventsPath, `${eventLines.join("\n")}\n`, "utf8");
        if (code !== 0)
          return reject(
            new Error(`CimiCode 执行失败，退出码 ${code ?? "unknown"}`),
          );
        try {
          const parsed = extractStructuredResult(
            resultPath,
            eventParts,
            input.testTypes,
          );
          if (parsed === null)
            return reject(new Error("CimiCode 未返回可解析的结构化测试结果"));
          const result = validateResult(parsed);
          const root = resolve(input.projectPath);
          const validArtifacts = result.artifacts.filter((artifact) => {
            const absolute = resolve(input.projectPath, artifact);
            let isFile = false;
            try {
              isFile = statSync(absolute).isFile();
            } catch {
              isFile = false;
            }
            return (
              (absolute === root || absolute.startsWith(`${root}\\`)) && isFile
            );
          });
          if (validArtifacts.length !== result.artifacts.length) {
            emit(log("warning", `忽略 ${result.artifacts.length - validArtifacts.length} 个越界或不存在制品`));
          }
          result.artifacts = validArtifacts;
          const ownArtifacts = [relative(input.projectPath, eventsPath)];
          result.artifacts = [
            ...new Set([...result.artifacts, ...ownArtifacts]),
          ];
          emit(log("success", "CimiCode 已返回经过真实执行的结构化测试结果"));
          resolveRun(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function createCimiCodeAdapter(): AgentAdapter | null {
  const executable = resolveCimiCodeExecutable();
  return executable ? new CimiCodeAdapter(executable) : null;
}
