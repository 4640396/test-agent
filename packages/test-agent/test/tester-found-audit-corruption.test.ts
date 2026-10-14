/**
 * tester-found bug 复现测试：loadEscalationAudit 单行损坏致全部历史丢失
 * （整体 try-catch + .map(JSON.parse)，任一行损坏抛错 → return [] 全丢）
 *
 * 发现者：tester（持续 bug 修复循环第 3 轮）
 * 模块：packages/test-agent/src/core/escalation-audit.ts loadEscalationAudit
 *
 * bug 描述：
 *   loadEscalationAudit 读 audit.jsonl 用 `raw.split("\n").filter(...).map(JSON.parse)`，
 *   整体包一个 try-catch。.map(JSON.parse) 遇任一损坏行抛 SyntaxError → catch return []，
 *   导致**单行损坏致全部历史丢失**（9 条好记录 + 1 条损坏 → 返回空，而非 9 条）。
 *
 *   对比同项目 loadRuns（flaky.ts:131）/ loadWeeklyPoints（metrics.ts:288）/
 *   DatasetLibrary.load（datasets.ts:322）都用**逐行 try-catch 跳损坏行保留好的**，
 *   audit 是唯一整体 catch 的，不一致 + 鲁棒性差。
 *
 *   实际触发场景：audit.jsonl 追加写（appendEscalationAudit），进程中途崩溃/磁盘满
 *   致末行截断非完整 JSON。下次加载时整体 catch → 全丢，审计历史断档。
 *
 * 严重性建议：P2（审计日志鲁棒性，非功能性中断；但审计是合规/追溯依据，全丢影响排查）。
 *
 * 预期修复方向（reviewer/worker 定）：
 *   改逐行 try-catch 跳损坏行（与 loadRuns/loadWeeklyPoints 一致）：
 *   ```ts
 *   for (const line of raw.split("\n")) {
 *     if (!line.trim()) continue;
 *     try { result.push(JSON.parse(line) as EscalationAuditEntry); }
 *     catch { /* 跳过损坏行 *\/ }
 *   }
 *   ```
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEscalationAudit, appendEscalationAudit, type EscalationAuditEntry } from "../src/core/escalation-audit.js";
import { computeProjectHash } from "../src/core/cases.js";

describe("[tester-found] loadEscalationAudit 单行损坏致全部历史丢失", () => {
  let tmpDir: string;
  let projectHash: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tester-audit-"));
    projectHash = computeProjectHash(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("9 条完好 + 1 条损坏（末行截断）→ loadEscalationAudit 跳损坏行返回 9 条（修复后回归守卫）", () => {
    // 写 9 条完好记录
    for (let i = 0; i < 9; i++) {
      appendEscalationAudit(tmpDir, {
        timestamp: new Date().toISOString(),
        escalationId: `esc-${i}`,
        role: "tester",
        question: `问题 ${i}`,
        resolved: false,
        degraded: false,
      }, projectHash);
    }
    // 手动追加 1 条损坏记录（截断的 JSON，模拟进程崩溃致末行不完整）
    const auditPath = join(tmpDir, ".test-agent", "escalations", projectHash, "audit.jsonl");
    writeFileSync(auditPath, '{"timestamp":"2026-09-07T00:00:00.000Z","escalationId":"broken","role":"teste', { flag: "a" });

    const loaded = loadEscalationAudit(tmpDir, projectHash);

    // 期望：跳过损坏行，返回 9 条完好的
    // 实际（bug）：整体 catch → 返回 []
    expect(loaded.length).toBe(9); // ← FAIL，复现 bug（实际 0）
    expect(loaded.every((e) => e.escalationId.startsWith("esc-"))).toBe(true);
  });

  it("对照：全完好的 5 条 → loadEscalationAudit 正常返回 5 条", () => {
    for (let i = 0; i < 5; i++) {
      appendEscalationAudit(tmpDir, {
        timestamp: new Date().toISOString(),
        escalationId: `ok-${i}`,
        role: "tester",
        question: `q${i}`,
        resolved: true,
        degraded: false,
      }, projectHash);
    }
    const loaded = loadEscalationAudit(tmpDir, projectHash);
    expect(loaded.length).toBe(5); // ← PASS（对照，无损坏时正常）
  });
});
