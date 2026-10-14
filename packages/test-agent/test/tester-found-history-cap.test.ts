/**
 * tester-found bug #11 回归守卫：CaseLibrary/DatasetLibrary history 加 MAX_HISTORY 上限
 *
 * 发现者：tester（持续 bug 修复循环第 11 轮）
 * 模块：packages/test-agent/src/core/cases.ts CaseLibrary.saveCase + datasets.ts DatasetLibrary.saveDataset
 *
 * bug 回顾：
 *   saveCase/saveDataset 每次追加版本无上限，history 无限增长（文件膨胀 + O(n) 写入）。
 *   修复（commit 81b0a18）：MAX_HISTORY=50（可配 TEST_AGENT_MAX_HISTORY）+ slice(-MAX_HISTORY) LRU 淘汰。
 *
 * 回归守卫：saveCase N 次（N > MAX_HISTORY）后 history.length <= MAX_HISTORY。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseLibrary, computeCaseId } from "../src/core/cases.js";
import { DatasetLibrary } from "../src/core/datasets.js";

describe("[tester-found] bug #11 回归守卫：history MAX_HISTORY 上限", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tester-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("CaseLibrary：saveCase 60 次（>MAX_HISTORY=50）后 history.length <= 50", () => {
    const lib = new CaseLibrary(tmpDir);
    const testCase = { id: "TC1", title: "测试用例", scenario: "s", steps: ["a"], expected: "e", priority: "medium" as const };
    for (let i = 0; i < 60; i++) {
      lib.saveCase(testCase, `task-${i}`);
    }
    const caseId = computeCaseId(lib.projectHashValue, "测试用例");
    const history = lib.getHistory(caseId);
    expect(history.length).toBeLessThanOrEqual(50); // 修复后：上限 50
    expect(history.length).toBe(50); // 60 次后保留最近 50
  });

  it("DatasetLibrary：saveDataset 60 次（>MAX_HISTORY=50）后 history.length <= 50", () => {
    const lib = new DatasetLibrary(tmpDir);
    const rows = [{ a: "1" }];
    for (let i = 0; i < 60; i++) {
      lib.saveDataset("ds1", rows);
    }
    const history = lib.getHistory("ds1");
    expect(history.length).toBeLessThanOrEqual(50); // 修复后：上限 50
    expect(history.length).toBe(50); // 60 次后保留最近 50
  });

  it("CaseLibrary：saveCase 30 次（<MAX_HISTORY=50）后 history.length === 30（不裁剪）", () => {
    const lib = new CaseLibrary(tmpDir);
    const testCase = { id: "TC2", title: "用例2", scenario: "s", steps: ["a"], expected: "e", priority: "medium" as const };
    for (let i = 0; i < 30; i++) {
      lib.saveCase(testCase);
    }
    const caseId = computeCaseId(lib.projectHashValue, "用例2");
    const history = lib.getHistory(caseId);
    expect(history.length).toBe(30); // 未达上限不裁剪
  });
});
