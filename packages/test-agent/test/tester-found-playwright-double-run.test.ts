/**
 * tester-found bug 复现测试：runProjectPlaywright 无条件额外执行 runGenericPlaywrightSmoke
 * （每次项目 playwright 测试都跑两遍，耗时翻倍 + uiSteps 被通用 smoke 覆盖）
 *
 * 发现者：tester（持续 bug 修复循环第 5 轮）
 * 模块：packages/test-agent/src/core/validator.ts runProjectPlaywright（line 690）
 *
 * bug 描述：
 *   runProjectPlaywright（line 634）末尾 line 690 无条件调
 *   `const genericOutcome = runGenericPlaywrightSmoke(projectPath, cli, options, undefined, extraWritableDirs)`。
 *   runGenericPlaywrightSmoke（line 696）会 scaffold 一个通用 smoke 测试（mkdirSync .test-agent/pw/<stamp>/tests +
 *   写 pw.config.js + smoke.spec.js）+ spawn playwright cli 执行它（line 786 spawnSync）+ finally rmSync scaffold 清理。
 *   即：每次项目 playwright 测试都额外跑一遍通用 smoke。
 *
 *   影响：
 *   1. 耗时翻倍：项目测试 300s timeout + 通用 smoke 300s timeout = 最长 600s
 *   2. 资源浪费：双浏览器实例、双截图、双 trace
 *   3. 结果混淆（line 694）：`uiSteps: genericOutcome.uiSteps?.length ? genericOutcome.uiSteps : [...hintSteps, ...uiSteps]`
 *      —— 若通用 smoke 产了 uiSteps，**覆盖项目测试的真实 uiSteps**，导致 flaky 检测/诊断用错数据
 *   4. 端口冲突可能：通用 smoke 访问 entryUrl/5199，与项目测试并发可能冲突
 *
 *   正确做法应是：项目测试有结果时不用 generic，项目测试空/失败时才 fallback generic。
 *
 * 严重性建议：P1——耗时翻倍 + uiSteps 结果混淆影响 flaky/诊断。非 P0（功能仍跑通，但性能+数据准确性受损）。
 *
 * 复现策略：runGenericPlaywrightSmoke 的 mkdirSync 创建 .test-agent/pw/（scaffold 跑完后 rmSync 清理 stamp 子目录，
 * 但父目录 .test-agent/pw/ 不删）。项目测试 runProjectPlaywright 不创建 .test-agent/pw/（用项目 playwright config）。
 * 故 .test-agent/pw/ 存在 = generic smoke 被无条件执行。mock spawnSync 避免 真 run playwright。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mock child_process.spawnSync 避免 真 run playwright（项目测试 + generic smoke 都调 spawnSync）
vi.mock("node:child_process", () => ({
  spawnSync: () => ({
    status: 0,
    stdout: '{"stats": {"tests": 1, "pass": 1, "fail": 0}, "tests": []}',
    stderr: "",
    pid: 12345,
    output: [null, "", ""],
    signal: null,
  }),
  spawn: () => ({ on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} }, pid: 1 }),
}));

describe("[tester-found] runProjectPlaywright 无条件双跑 generic smoke", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tester-pw-"));
    // 构造有 playwright config 的项目（触发 runProjectPlaywright 路径，非 generic fallback）
    writeFileSync(join(tmpDir, "playwright.config.ts"), "export default {}", "utf8");
    mkdirSync(join(tmpDir, "node_modules", "@playwright", "test"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "@playwright", "test", "cli.js"), "// mock cli", "utf8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runPlaywrightUiTests（有 playwright config）→ 不再创建 .test-agent/pw/（移除无条件 generic 双跑，修复后回归守卫）", async () => {
    const { runPlaywrightUiTests } = await import("../src/core/validator.js");
    runPlaywrightUiTests(tmpDir, {});

    // runGenericPlaywrightSmoke 会 mkdirSync .test-agent/pw/<stamp>/tests + 写 smoke.spec.js + spawn + finally rmSync scaffold
    // scaffold 跑完被清理，但父目录 .test-agent/pw/ 不会删（mkdirSync recursive 只创建不清理父目录）
    // 项目测试 runProjectPlaywright 不创建 .test-agent/pw/——它用项目的 playwright config
    // 故 .test-agent/pw/ 存在 = generic smoke 被无条件执行（bug）
    const pwScaffoldDir = join(tmpDir, ".test-agent", "pw");
    const pwDirExists = existsSync(pwScaffoldDir);

    // 期望：项目测试有结果时不应跑 generic smoke（不应创建 .test-agent/pw/）
    // 实际（bug）：无条件调 runGenericPlaywrightSmoke → mkdirSync .test-agent/pw/ → scaffold 被清理但父目录留下
    expect(pwDirExists).toBe(false); // ← FAIL：pwDirExists=true，证明 generic 被无条件执行
  });
});
