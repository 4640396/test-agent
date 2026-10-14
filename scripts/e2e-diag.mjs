// e2e 失败诊断验收脚本（第一阶段）
//
// 用途：对一个含失败用例的 fixture 项目，真实跑 node --test 拿失败明细，
// 喂给 runDiagnosis 验证失败诊断功能，并检查场景E（read-only git diff 空）。
//
// 前置：
//   1. 已 build 各 packages（npm run build:packages）——脚本 import dist 产物
//   2. ~/.test-agent/ai-config.json 已配置可用 LLM（provider/model/apiKey）
//   3. fixture 是 git 仓库（git init + commit baseline）才能验场景E
//
// 用法：node scripts/e2e-diag.mjs <fixturePath>
//   fixturePath: 含 src/ + test/ 的 node 项目（type:module），有失败用例
//
// 验收场景对应：
//   场景A（全过不触发）——fixture 全过时脚本会提示"跳过诊断"
//   场景B/C/D（诊断准确）——看输出的 category/evidence/suggestion
//   场景E（read-only）——看末尾"场景E PASS"（git diff 必须空）
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("用法: node scripts/e2e-diag.mjs <fixturePath>");
  console.error("fixturePath: 含失败用例的 node 项目（须为 git 仓库以验场景E）");
  process.exit(1);
}

// 从脚本位置解析仓库根，用动态 import 加载 dist 产物（绕过包 exports 限制）
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distUrl = (p) => pathToFileURL(join(repoRoot, p)).href;
const { runDiagnosis } = await import(distUrl("packages/test-agent/dist/core/orchestrator.js"));
const { streamSimple: streamOpenAICompletionsSimple } = await import(distUrl("packages/ai/dist/api/openai-completions.js"));
const { NodeExecutionEnv } = await import(distUrl("packages/agent-core/dist/node.js"));

// 1. 读 ai-config 构造 model（loadAiConfig/buildModel 未从 runner.ts 导出，这里复刻简化逻辑）
const configPath = join(homedir(), ".test-agent", "ai-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const provider = config.providers[config.defaultProvider];
const modelDef = provider.models.find((m) => m.id === config.defaultModel) ?? provider.models[0];
const model = {
  id: modelDef.id, name: modelDef.id, provider: config.defaultProvider,
  api: "openai-completions", baseUrl: provider.baseUrl,
  reasoning: modelDef.reasoning ?? false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
  ...(provider.compat ? { compat: provider.compat } : {}),
};
const apiKey = provider.apiKey;

// 2. 真实跑 fixture 测试，拿失败明细
console.log(`=== 真实跑 fixture 测试: ${fixturePath} ===`);
let rawOutput = "";
try {
  rawOutput = execSync("node --test", { cwd: fixturePath, encoding: "utf8", timeout: 30000 });
} catch (e) {
  rawOutput = e.stdout ?? e.stderr ?? String(e);
}
console.log(rawOutput.split("\n").slice(-8).join("\n"));

// 解析 node --test 的 TAP 输出（not ok 行 + error/expected/actual）
const lines = rawOutput.split(/\r?\n/);
let current = null;
const failedCases = [];
for (const line of lines) {
  const m = /^not ok\s+\d+\s+-\s+(.+)$/.exec(line.trim());
  if (m) {
    if (current) failedCases.push(current);
    current = { name: m[1].trim(), layer: "unit", error: "" };
    continue;
  }
  if (current && (/^\s+(expected|actual|operator):/.test(line) || /^\s+error:/.test(line) || /Expected values to be strictly equal/.test(line) || /^\s+\d+ !== \d+/.test(line.trim()))) {
    current.error += (current.error ? "\n" : "") + line.trim();
  }
}
if (current) failedCases.push(current);
const failedInputs = failedCases.map((f) => ({ ...f, error: f.error.slice(0, 400) || "(no error detail)" }));

const passN = parseInt(/# pass\s+(\d+)/.exec(rawOutput)?.[1] ?? "0");
const failN = parseInt(/# fail\s+(\d+)/.exec(rawOutput)?.[1] ?? "0");
console.log(`\n测试结果: pass=${passN} fail=${failN}, 解析出 ${failedInputs.length} 条失败用例`);

if (failedInputs.length === 0) {
  console.log(">>> 场景A: 没有失败用例，跳过诊断（全过不触发，零额外开销）");
  process.exit(0);
}

// 3. 场景E baseline（仅 git 仓库有效）
const isGit = (() => { try { execSync(`git -C ${fixturePath} rev-parse`, { stdio: "ignore" }); return true; } catch { return false; } })();
console.log(`\n=== 场景E baseline (fixture 是 git 仓库: ${isGit}) ===`);
if (isGit) {
  console.log(`git status before: ${execSync(`git -C ${fixturePath} status --porcelain`, { encoding: "utf8" }).trim() || "(clean)"}`);
}

// 4. 调 runDiagnosis
const env = new NodeExecutionEnv({ cwd: fixturePath });
const deps = { streamFn: streamOpenAICompletionsSimple, model, apiKey, execContext: { env }, projectPath: fixturePath };
console.log("\n=== 调 runDiagnosis ===");
const result = await runDiagnosis(deps, failedInputs, rawOutput, [fixturePath]);

console.log("\n=== DiagnosisResult ===");
console.log(`failedCases.length = ${result.failedCases.length} (失败数 ${failN})`);
for (const fc of result.failedCases) {
  console.log(`\n  • ${fc.name} [${fc.category}] (置信度: ${fc.confidence ?? "-"}) layer=${fc.layer}`);
  console.log(`    error: ${(fc.error ?? "").slice(0, 100)}`);
  console.log(`    evidence: ${fc.evidence ?? "-"}`);
  console.log(`    suggestion: ${(fc.suggestion ?? "").slice(0, 150)}`);
}

// 5. 场景E 验收：诊断跑完 git diff 必须空（read-only 约束）
console.log("\n=== 场景E 验收 ===");
if (!isGit) {
  console.log(">>> 跳过（fixture 非 git 仓库）—— 场景E 需在 git 仓库 fixture 上验");
} else {
  const afterStatus = execSync(`git -C ${fixturePath} status --porcelain`, { encoding: "utf8" }).trim();
  const afterDiff = execSync(`git -C ${fixturePath} diff`, { encoding: "utf8" }).trim();
  if (!afterStatus && !afterDiff) {
  console.log(">>> 场景E PASS: git status 干净 + git diff 空，诊断未改任何文件（read-only 约束生效）");
  } else {
  console.log(`>>> 场景E FAIL: 诊断改变了文件！git status=${afterStatus}, git diff=${afterDiff.slice(0, 200)}`);
  }
}
