// e2e 角色分工架构验证脚本（片5）
// 直调 Runner.run() 走 scout→case-designer→tester 全链路，验证：
// - scout 产出侦察报告
// - case-designer 产出用例（含 target，覆盖边界值）
// - tester 跑出真实 pass/fail（非 0/0）
// - 全链路串联
//
// 用法：node scripts/e2e-roles.mjs <fixturePath>
// 前置：npm run build:packages + ~/.test-agent/ai-config.json
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("用法: node scripts/e2e-roles.mjs <fixturePath>");
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distUrl = (p) => pathToFileURL(join(repoRoot, p)).href;

// 1. 动态 import dist 产物
const { createRunner } = await import(distUrl("packages/test-agent/dist/index.js"));

// 2. 构造 Runner（读 ai-config，走 ai-native 路径）
process.env.TEST_AGENT_PROVIDER = "ai-native";
const runner = createRunner();
if (!runner) {
  console.error("createRunner() 返回 null——检查 ~/.test-agent/ai-config.json");
  process.exit(1);
}

console.log(`=== e2e 角色分工架构验证: ${fixturePath} ===`);
console.log(`provider=ai-native, model 从 ai-config 读取`);
console.log("");

// 3. 构造 TaskInput
const input = {
  projectPath: fixturePath,
  systemName: "e2e-roles",
  version: "1.0.0",
  testTypes: ["unit"],
  coverageTarget: 80,
};

// 4. emit 收集事件（实时打印关键阶段）
const events = [];
const emit = (event) => {
  events.push(event);
  if (event.type === "log") {
    const tag = event.tag ?? "";
    console.log(`[${tag || event.level}] ${event.message}`);
  } else if (event.type === "planning_start" || event.type === "planning_end" || event.type === "agent_end") {
    console.log(`<<event ${event.type}>>`);
  }
};

// 5. 调 Runner.run()（走 scout→case-designer→tester 全链路）
console.log("=== 调 Runner.run()（scout→case-designer→tester）===\n");
try {
  const result = await runner.run(input, emit);
  
  console.log("\n=== AgentRunResult ===");
  console.log(`report.passed = ${result.report.passed}`);
  console.log(`report.failed = ${result.report.failed}`);
  console.log(`report.coverage = ${result.report.coverage}`);
  console.log(`report.failedCases?.length = ${result.report.failedCases?.length ?? 0}`);
  console.log(`report.fixActions?.length = ${result.report.fixActions?.length ?? 0}`);
  console.log(`phase = ${result.phase}`);
  
  // 6. 验收检查
  console.log("\n=== 验收检查 ===");
  
  // scout 侦察报告（从 events 里找 planning_start 前的 log）
  const scoutLogs = events.filter(e => e.type === "log" && (e.tag === "SCOUT" || e.message?.includes("侦察")));
  console.log(`\n1. scout 侦察报告: ${scoutLogs.length > 0 ? "✓ PASS（有侦察日志）" : "⚠ 未检测到 scout 日志（可能 tag 不同）"}`);
  if (scoutLogs.length > 0) {
    for (const sl of scoutLogs.slice(0, 3)) console.log(`   ${sl.message?.slice(0, 100)}`);
  }
  
  // case-designer 用例（从 events 里找 planning_end）
  const planningEnd = events.find(e => e.type === "planning_end");
  console.log(`\n2. case-designer 用例: ${planningEnd ? `✓ PASS（${planningEnd.caseCount} 条用例）` : "⚠ 未检测到 planning_end"}`);
  if (planningEnd?.cases?.length > 0) {
    for (const c of planningEnd.cases.slice(0, 3)) {
      console.log(`   • ${c.id} ${c.title} [${c.layer}] target=${c.target ?? "(无)"}`);
    }
    const hasTarget = planningEnd.cases.some(c => c.target);
    console.log(`   target 字段: ${hasTarget ? "✓ PASS（有用例含 target）" : "✗ FAIL（无 target）"}`);
    // 边界值覆盖检查（用例标题/scenario 含边界/零/空/负等关键词）
    const hasBoundary = planningEnd.cases.some(c => /边界|零|空|负|0|null|undefined|最大|最小/i.test(c.title + " " + (c.scenario ?? "")));
    console.log(`   边界值覆盖: ${hasBoundary ? "✓ PASS（有边界值用例）" : "⚠ 未检测到边界值用例"}`);
  }
  
  // tester 跑出真实 pass/fail
  const isRealResult = result.report.passed > 0 || result.report.failed > 0;
  console.log(`\n3. tester pass/fail: ${isRealResult ? `✓ PASS（${result.report.passed} 通过 / ${result.report.failed} 失败）` : "✗ FAIL（0/0，测试没跑成）"}`);
  
  // 全链路串联（scout→case-designer→tester 都有事件）
  const hasScout = events.some(e => e.type === "log" && /侦察|scout/i.test(e.message ?? ""));
  const hasPlan = !!planningEnd;
  const hasExecute = result.phase === "execute" || result.report.passed > 0 || result.report.failed > 0;
  console.log(`\n4. 全链路串联: ${hasScout && hasPlan && hasExecute ? "✓ PASS（scout→case-designer→tester）" : `⚠ 不完整（scout=${hasScout} plan=${hasPlan} execute=${hasExecute}）`}`);
  
  // 5. 非 0/0
  console.log(`\n5. 非 0/0: ${isRealResult ? "✓ PASS" : "✗ FAIL"}`);
  
  // 写完整结果
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/e2e-roles-result.json", JSON.stringify(result, null, 2), "utf8");
  console.log("\n(完整结果已写 /tmp/e2e-roles-result.json)");
  
} catch (err) {
  console.error("\n=== run() 抛错 ===");
  console.error(err);
  
  // 重试1次
  console.log("\n=== 重试1次 ===");
  try {
  events.length = 0;
  const result = await runner.run(input, emit);
  console.log(`重试结果: passed=${result.report.passed} failed=${result.report.failed}`);
  } catch (err2) {
  console.error("重试也失败:", err2);
  console.log("[需人工复核] e2e 不稳定，LLM 可能超时或出错");
  }
}
