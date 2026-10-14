// e2e 修复验收脚本（诊断先行架构片8）
// 直调 runFixByDiagnosis 验修复逻辑：喂诊断数据 → 修复 Agent 跑 → 改对文件 → 产 fixActions → 回滚
// 用法：node scripts/e2e-fix.mjs <fixturePath>
// fixturePath: 含真实 bug 的项目（git 仓库），修复 Agent 会按诊断改生产代码
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("用法: node scripts/e2e-fix.mjs <fixturePath>");
  console.error("fixturePath: 含真实 bug 的 node 项目（须为 git 仓库）");
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distUrl = (p) => pathToFileURL(join(repoRoot, p)).href;
const { runFixByDiagnosis } = await import(distUrl("packages/test-agent/dist/core/fix-orchestrator.js"));
const { streamSimple: streamOpenAICompletionsSimple } = await import(distUrl("packages/ai/dist/api/openai-completions.js"));
const { NodeExecutionEnv } = await import(distUrl("packages/agent-core/dist/node.js"));

// 1. 读 ai-config 构造 model
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

// 2. 构造诊断数据（模拟 real-bug 高置信诊断——对应 fixture 的 2 个 bug）
console.log(`=== e2e 修复验收: ${fixturePath} ===`);
console.log("诊断数据（模拟 result-reviewer 产出，2 个 real-bug 高置信）:");
const diagnosis = {
  failedCases: [
    {
      name: "calc 应减去折扣",
      layer: "unit",
      error: "AssertionError: expected 80, actual 100",
      category: "real-bug",
      confidence: "high",
      evidence: "被测代码 src/order.js:2 中 calc 函数 `return totalAmount` 忽略了 discount 参数",
      suggestion: "将 src/order.js:2 改为 `return totalAmount - discount`",
    },
    {
      name: "totalForZero 应返回 0",
      layer: "unit",
      error: "AssertionError: expected 0, actual NaN",
      category: "real-bug",
      confidence: "high",
      evidence: "被测代码 src/order.js:4 中 totalForZero 函数 `return 0 / 0` 结果为 NaN",
      suggestion: "将 src/order.js:4 改为 `return 0`",
    },
  ],
};
for (const fc of diagnosis.failedCases) {
  console.log(`  • ${fc.name} [${fc.category}] (${fc.confidence}) → ${fc.suggestion}`);
}

// 3. 场景E baseline（修复前 git diff）
const isGit = (() => { try { execSync(`git -C ${fixturePath} rev-parse`, { stdio: "ignore" }); return true; } catch { return false; } })();
console.log(`\n=== 修复前 baseline (git=${isGit}) ===`);
if (isGit) {
  console.log(`git status: ${execSync(`git -C ${fixturePath} status --porcelain`, { encoding: "utf8" }).trim() || "(clean)"}`);
  console.log(`src/order.js 修复前内容:\n${readFileSync(join(fixturePath, "src", "order.js"), "utf8")}`);
}

// 4. 调 runFixByDiagnosis
const env = new NodeExecutionEnv({ cwd: fixturePath });
const deps = {
  streamFn: streamOpenAICompletionsSimple,
  model, apiKey,
  execContext: { env },
  testToolContext: { projectPath: fixturePath, extraWritableDirs: [fixturePath] },
  projectPath: fixturePath,
  diagnosis,
};
console.log("\n=== 调 runFixByDiagnosis ===");
const result = await runFixByDiagnosis(deps);

console.log("\n=== 修复结果 ===");
console.log(`fixActions.length = ${result.fixActions.length}`);
for (const fa of result.fixActions) {
  console.log(`\n  修复动作: ${fa.diagnosisName} [${fa.category}] (${fa.confidence})`);
  console.log(`  改了 ${fa.files.length} 个文件:`);
  for (const f of fa.files) console.log(`    - ${f.path}`);
  console.log(`  重跑结果: ${fa.rerunResult.passed} 通过 / ${fa.rerunResult.failed} 失败`);
  console.log(`  patch 长度: ${fa.patch.length} 字符（回滚用）`);
}

// 5. 修复后文件内容
console.log(`\n=== 修复后 src/order.js ===`);
try {
  console.log(readFileSync(join(fixturePath, "src", "order.js"), "utf8"));
} catch { console.log("(读不到)"); }

// 6. 修复后 git status
if (isGit) {
  console.log(`\n=== 修复后 git status ===`);
  console.log(execSync(`git -C ${fixturePath} status --porcelain`, { encoding: "utf8" }).trim() || "(clean)");
}

// 7. 验收检查
console.log("\n=== 验收检查 ===");
console.log(`fixActions 产出: ${result.fixActions.length > 0 ? "✓ PASS" : "✗ FAIL（无修复动作）"}`);
const changedProdCode = result.fixActions.some(fa => fa.files.some(f => f.path.includes("src/") || f.path.includes("order.js")));
console.log(`修复改了生产代码: ${changedProdCode ? "✓ PASS（real-bug 应改生产代码）" : "✗ FAIL"}`);
const changedTestCode = result.fixActions.some(fa => fa.files.some(f => f.path.includes("test/") || f.path.includes("test.")));
console.log(`修复没改测试代码: ${!changedTestCode ? "✓ PASS" : "⚠ 注意（real-bug 修复不该改测试）"}`);
const hasPatch = result.fixActions.every(fa => fa.patch !== undefined);
console.log(`每条 fixAction 有 patch: ${hasPatch ? "✓ PASS（可回滚）" : "✗ FAIL"}`);

// 8. 测回滚（若有 patch）
if (isGit && result.fixActions.length > 0 && result.fixActions[0].patch) {
  console.log("\n=== 回滚测试 ===");
  try {
    execSync(`git -C ${fixturePath} apply -R -`, { input: result.fixActions[0].patch, encoding: "utf8" });
    const afterRollback = readFileSync(join(fixturePath, "src", "order.js"), "utf8");
    console.log(`回滚后 src/order.js:\n${afterRollback}`);
    console.log(`回滚成功: ${afterRollback.includes("return totalAmount") || afterRollback.includes("0 / 0") ? "✓ PASS（恢复到修复前 bug 状态）" : "⚠ 回滚后内容不符预期"}`);
  } catch (e) {
    console.log(`回滚失败: ${e.message}`);
  }
}
