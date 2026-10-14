import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { TestCase } from "../src/core/types.js";
import {
  getChangedFiles,
  getChangedLines,
  parseDiffForAddedLines,
  selectAffectedCases,
  findCoverageReport,
  parseIstanbulCoverage,
  parseJacocoCoverage,
  computeIncrementalCoverage,
  type ChangedFileLines,
} from "../src/core/impact.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeCase(title: string, target?: string): TestCase {
  return {
    id: "temp-id",
    title,
    scenario: `测试 ${title}`,
    steps: ["步骤1"],
    expected: "预期结果",
    priority: "medium",
    layer: "unit",
    ...(target ? { target } : {}),
  };
}

/** 初始化临时 git 仓库并写入初始文件。 */
function makeGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "impact-"));
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "OrderService.ts"), "export class OrderService {\n  calc() {\n    return 42;\n  }\n}\n");
  spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: dir, encoding: "utf8" });
  return dir;
}

/** 修改文件并提交（或仅修改工作区）。 */
function modifyFile(dir: string, file: string, content: string, commit = false): void {
  writeFileSync(join(dir, file), content);
  if (commit) {
    spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "change"], { cwd: dir, encoding: "utf8" });
  }
}

// ---------------------------------------------------------------------------
// getChangedFiles
// ---------------------------------------------------------------------------

describe("getChangedFiles", () => {
  let dir: string;
  beforeEach(() => { dir = makeGitProject(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY/ENOTEMPTY on Windows — temp dir cleaned by OS */ }
  });

  it("returns changed files for working tree modifications", () => {
    modifyFile(dir, "src/OrderService.ts", "export class OrderService {\n  calc() {\n    return 99;\n  }\n  refund() {\n    return 1;\n  }\n}\n");
    const changed = getChangedFiles(dir);
    expect(changed).toContain("src/OrderService.ts");
  });

  it("returns empty array when no changes", () => {
    const changed = getChangedFiles(dir);
    expect(changed).toEqual([]);
  });

  it("returns empty array for non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const changed = getChangedFiles(nonGit);
      expect(changed).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("supports custom baseRef", () => {
    // Make a second commit, then compare HEAD~1 to HEAD
    modifyFile(dir, "src/OrderService.ts", "export class OrderService {\n  calc() {\n    return 100;\n  }\n}\n", true);
    const changed = getChangedFiles(dir, "HEAD~1");
    expect(changed).toContain("src/OrderService.ts");
  });

  it("scopes parent-repository changes to the selected nested project", () => {
    const frontend = join(dir, "frontend");
    mkdirSync(join(frontend, "src"), { recursive: true });
    writeFileSync(join(frontend, "src", "App.ts"), "export const value = 1;\n");
    writeFileSync(join(dir, "AGENTS.md"), "initial\n");
    spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "add nested project"], { cwd: dir, encoding: "utf8" });

    writeFileSync(join(frontend, "src", "App.ts"), "export const value = 2;\n");
    writeFileSync(join(dir, "AGENTS.md"), "changed outside project\n");

    expect(getChangedFiles(frontend)).toEqual(["src/App.ts"]);
  });

  it("returns no selected-project changes when only the parent repository changed", () => {
    const frontend = join(dir, "frontend");
    mkdirSync(frontend, { recursive: true });
    writeFileSync(join(frontend, "package.json"), "{}\n");
    writeFileSync(join(dir, "AGENTS.md"), "initial\n");
    spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "add nested project"], { cwd: dir, encoding: "utf8" });

    writeFileSync(join(dir, "AGENTS.md"), "changed outside project\n");

    expect(getChangedFiles(frontend)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseDiffForAddedLines
// ---------------------------------------------------------------------------

describe("parseDiffForAddedLines", () => {
  it("extracts added line numbers from unified diff", () => {
    const diff = `diff --git a/src/file.ts b/src/file.ts
index abc..def 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,5 @@
 export class Foo {
-  bar() {
+  bar() {
+    console.log("new");
+    return 42;
   }
 }`;
    const result = parseDiffForAddedLines(diff);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/file.ts");
    // Hunk starts at new line 1: context(line1), delete(doesn't advance), add(line2), add(line3), add(line4)
    expect(result[0].addedLines).toEqual([2, 3, 4]);
    expect(result[0].addedLines).not.toContain(1);
  });

  it("handles multiple hunks in same file", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 line1
+line2
 line3
@@ -10,2 +12,3 @@
 line10
+line11
 line12`;
    const result = parseDiffForAddedLines(diff);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("a.ts");
    expect(result[0].addedLines).toEqual([2, 13]);
  });

  it("handles multiple files", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 old
+new_a
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,2 @@
 old
+new_b`;
    const result = parseDiffForAddedLines(diff);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe("a.ts");
    expect(result[0].addedLines).toEqual([2]);
    expect(result[1].file).toBe("b.ts");
    expect(result[1].addedLines).toEqual([6]);
  });

  it("skips deleted files (/dev/null)", () => {
    const diff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3`;
    const result = parseDiffForAddedLines(diff);
    expect(result).toEqual([]);
  });

  it("returns empty for empty diff", () => {
    expect(parseDiffForAddedLines("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getChangedLines
// ---------------------------------------------------------------------------

describe("getChangedLines", () => {
  let dir: string;
  beforeEach(() => { dir = makeGitProject(); });
  afterEach(() => {
    // Windows: git may still hold locks, retry cleanup
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY on Windows — temp dir cleaned by OS */ }
  });

  it("returns added line numbers for changed files", () => {
    modifyFile(dir, "src/OrderService.ts", "export class OrderService {\n  calc() {\n    return 99;\n  }\n  refund() {\n    return 1;\n  }\n}\n");
    const result = getChangedLines(dir);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/OrderService.ts");
    expect(result[0].addedLines.length).toBeGreaterThan(0);
  });

  it("returns empty array when no changes", () => {
    const result = getChangedLines(dir);
    expect(result).toEqual([]);
  });

  it("returns empty array for non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "no-git-lines-"));
    try {
      expect(getChangedLines(nonGit)).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("filters and rebases changed lines for a nested project", () => {
    const frontend = join(dir, "frontend");
    mkdirSync(join(frontend, "src"), { recursive: true });
    writeFileSync(join(frontend, "src", "App.ts"), "export const value = 1;\n");
    writeFileSync(join(dir, "AGENTS.md"), "initial\n");
    spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "add nested project"], { cwd: dir, encoding: "utf8" });

    writeFileSync(join(frontend, "src", "App.ts"), "export const value = 2;\n");
    writeFileSync(join(dir, "AGENTS.md"), "changed outside project\n");

    const result = getChangedLines(frontend);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/App.ts");
    expect(result[0].addedLines).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// selectAffectedCases — PRD 7.5 场景A
// ---------------------------------------------------------------------------

describe("selectAffectedCases", () => {
  it("zero match is explicit so the runner can stop before execution", () => {
    const cases = [makeCase("用例1", "src/OrderService.ts:10")];
    const result = selectAffectedCases(cases, ["src/Unrelated.ts"]);
    expect(result.affected).toEqual([]);
    expect(result.skipped).toEqual(cases);
  });
  it("selects cases whose target matches changed files", () => {
    const cases = [
      makeCase("用例1", "src/OrderService.ts:10"),
      makeCase("用例2", "src/OtherService.ts:5"),
      makeCase("用例3", "src/OrderService.ts:20"),
    ];
    const result = selectAffectedCases(cases, ["src/OrderService.ts"]);
    expect(result.affected).toHaveLength(2);
    expect(result.affected[0].title).toBe("用例1");
    expect(result.affected[1].title).toBe("用例3");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].title).toBe("用例2");
  });

  it("includes cases without target (conservative — no skip)", () => {
    const cases = [
      makeCase("无目标用例"),
      makeCase("有目标用例", "src/Changed.ts:1"),
      makeCase("未受影响用例", "src/Unchanged.ts:1"),
    ];
    const result = selectAffectedCases(cases, ["src/Changed.ts"]);
    expect(result.affected).toHaveLength(2);
    expect(result.affected.some((c) => c.title === "无目标用例")).toBe(true);
    expect(result.skipped).toHaveLength(1);
  });

  it("includes cases with non-file targets (method/API — conservative)", () => {
    const cases = [
      makeCase("方法用例", "OrderService.calc()"),
      makeCase("API用例", "GET /api/orders"),
    ];
    const result = selectAffectedCases(cases, ["src/Changed.ts"]);
    expect(result.affected).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it("returns all cases when changedFiles is empty (fallback to full)", () => {
    const cases = [makeCase("用例1"), makeCase("用例2")];
    const result = selectAffectedCases(cases, []);
    expect(result.affected).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.fallbackReason).toBeTruthy();
  });

  it("superset guarantee: selected ⊇ truly affected (no missed cases)", () => {
    // Even if mapping is imperfect, cases without file target are included
    const cases = [
      makeCase("隐式依赖用例"), // no target → always included
      makeCase("文件匹配用例", "src/Changed.ts:1"),
    ];
    const result = selectAffectedCases(cases, ["src/Changed.ts"]);
    expect(result.affected.length).toBeGreaterThanOrEqual(1);
    // All cases that could be affected are included
    expect(result.affected).toContainEqual(expect.objectContaining({ title: "隐式依赖用例" }));
  });

  it("normalizes path separators in changed files", () => {
    const cases = [makeCase("用例1", "src/OrderService.ts:10")];
    const result = selectAffectedCases(cases, ["src\\OrderService.ts"]);
    expect(result.affected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findCoverageReport
// ---------------------------------------------------------------------------

describe("findCoverageReport", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cov-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("finds coverage/coverage-final.json", () => {
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "coverage", "coverage-final.json"), "{}");
    const found = findCoverageReport(dir);
    expect(found).toBe(join(dir, "coverage", "coverage-final.json"));
  });

  it("finds .nyc_output/coverage-final.json", () => {
    mkdirSync(join(dir, ".nyc_output"), { recursive: true });
    writeFileSync(join(dir, ".nyc_output", "coverage-final.json"), "{}");
    const found = findCoverageReport(dir);
    expect(found).toBe(join(dir, ".nyc_output", "coverage-final.json"));
  });

  it("finds target/site/jacoco/jacoco.xml", () => {
    mkdirSync(join(dir, "target", "site", "jacoco"), { recursive: true });
    writeFileSync(join(dir, "target", "site", "jacoco", "jacoco.xml"), "<report/>");
    const found = findCoverageReport(dir);
    expect(found).toBe(join(dir, "target", "site", "jacoco", "jacoco.xml"));
  });

  it("returns undefined when no report found", () => {
    expect(findCoverageReport(dir)).toBeUndefined();
  });

  it("finds report in .test-agent/results/*/coverage/", () => {
    const stamp = "2025-01-01T00-00-00-000Z";
  mkdirSync(join(dir, ".test-agent", "results", stamp, "coverage"), { recursive: true });
    writeFileSync(join(dir, ".test-agent", "results", stamp, "coverage", "coverage-final.json"), "{}");
    const found = findCoverageReport(dir);
    expect(found).toBeTruthy();
    expect(found).toContain("coverage-final.json");
  });
});

// ---------------------------------------------------------------------------
// parseIstanbulCoverage
// ---------------------------------------------------------------------------

describe("parseIstanbulCoverage", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "istanbul-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("extracts covered lines from istanbul JSON", () => {
  const filePath = join(dir, "src", "Service.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(filePath, "code");
    const report = {
      [filePath]: {
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
          "1": { start: { line: 3, column: 0 }, end: { line: 5, column: 0 } },
          "2": { start: { line: 7, column: 0 }, end: { line: 7, column: 10 } },
        },
        s: { "0": 3, "1": 0, "2": 1 },
      },
    };
  const reportPath = join(dir, "coverage-final.json");
  writeFileSync(reportPath, JSON.stringify(report));

    const result = parseIstanbulCoverage(reportPath, dir);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/Service.ts");
    // Statement 0 (line 1) covered, Statement 1 (lines 3-5) NOT covered, Statement 2 (line 7) covered
    expect(result[0].coveredLines.has(1)).toBe(true);
    expect(result[0].coveredLines.has(3)).toBe(false);
    expect(result[0].coveredLines.has(4)).toBe(false);
    expect(result[0].coveredLines.has(5)).toBe(false);
    expect(result[0].coveredLines.has(7)).toBe(true);
  });

  it("returns empty array for invalid JSON", () => {
  const reportPath = join(dir, "bad.json");
  writeFileSync(reportPath, "not json");
    expect(parseIstanbulCoverage(reportPath, dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseJacocoCoverage
// ---------------------------------------------------------------------------

describe("parseJacocoCoverage", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jacoco-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("extracts covered lines from jacoco XML (basic parsing)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/example/service">
    <sourcefile name="OrderService.java">
      <line nr="10" mi="0" ci="1" mb="0" cb="0"/>
      <line nr="11" mi="0" ci="0" mb="0" cb="0"/>
      <line nr="12" mi="0" ci="2" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;
    const reportPath = join(dir, "jacoco.xml");
    writeFileSync(reportPath, xml);

    const result = parseJacocoCoverage(reportPath, dir);
    expect(result).toHaveLength(1);
    // package com/example/service → com/example/service/OrderService.java
    expect(result[0].file).toBe("com/example/service/OrderService.java");
    expect(result[0].coveredLines.has(10)).toBe(true);
    expect(result[0].coveredLines.has(11)).toBe(false); // ci=0 → not covered
    expect(result[0].coveredLines.has(12)).toBe(true);
  });

  it("handles multiple packages and sourcefiles", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/example/service">
    <sourcefile name="OrderService.java">
      <line nr="5" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
  <package name="com/example/model">
    <sourcefile name="Order.java">
      <line nr="20" mi="0" ci="1" mb="0" cb="0"/>
      <line nr="21" mi="0" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;
    const reportPath = join(dir, "jacoco.xml");
    writeFileSync(reportPath, xml);

    const result = parseJacocoCoverage(reportPath, dir);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe("com/example/service/OrderService.java");
    expect(result[0].coveredLines.has(5)).toBe(true);
    expect(result[1].file).toBe("com/example/model/Order.java");
    expect(result[1].coveredLines.has(20)).toBe(true);
    expect(result[1].coveredLines.has(21)).toBe(false);
  });

  it("handles dot-separated package names (converts dots to slashes)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com.example.service">
    <sourcefile name="OrderService.java">
      <line nr="3" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;
    const reportPath = join(dir, "jacoco.xml");
    writeFileSync(reportPath, xml);

    const result = parseJacocoCoverage(reportPath, dir);
    expect(result).toHaveLength(1);
    // com.example.service → com/example/service/OrderService.java
    expect(result[0].file).toBe("com/example/service/OrderService.java");
    expect(result[0].coveredLines.has(3)).toBe(true);
  });

  it("returns empty array for empty XML", () => {
    const reportPath = join(dir, "empty.xml");
    writeFileSync(reportPath, "");
    expect(parseJacocoCoverage(reportPath, dir)).toEqual([]);
  });

  it("returns empty array for invalid XML", () => {
    const reportPath = join(dir, "bad.xml");
    writeFileSync(reportPath, "not xml at all");
    expect(parseJacocoCoverage(reportPath, dir)).toEqual([]);
  });

  it("returns empty array for XML with no sourcefiles", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test">
  <package name="com/example">
  </package>
</report>`;
    const reportPath = join(dir, "jacoco.xml");
    writeFileSync(reportPath, xml);
    expect(parseJacocoCoverage(reportPath, dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeIncrementalCoverage — PRD 7.5 场景B
// ---------------------------------------------------------------------------

describe("computeIncrementalCoverage", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "incr-cov-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("computes incremental coverage when report found (scenario B)", () => {
    // Setup: changed lines 3,4 in src/Service.ts, coverage report covers line 3 but not 4
    const filePath = join(dir, "src", "Service.ts");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(filePath, "code");
    mkdirSync(join(dir, "coverage"), { recursive: true });

    const report = {
      [filePath]: {
        statementMap: {
          "0": { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
        },
        s: { "0": 1 }, // line 3 covered
      },
    };
    writeFileSync(join(dir, "coverage", "coverage-final.json"), JSON.stringify(report));

    const changedLines: ChangedFileLines[] = [
      { file: "src/Service.ts", addedLines: [3, 4] }, // line 4 NOT covered
    ];

    const result = computeIncrementalCoverage(dir, changedLines, 2, 5, "incremental");
    expect(result.mode).toBe("incremental");
    expect(result.changedLineCount).toBe(2);
    expect(result.coveredChangedLineCount).toBe(1); // only line 3
    expect(result.percentage).toBe(50);
    expect(result.affectedCaseCount).toBe(2);
    expect(result.totalCaseCount).toBe(5);
  });

  it("returns null percentage when no coverage report found", () => {
  const changedLines: ChangedFileLines[] = [
    { file: "src/Service.ts", addedLines: [1, 2, 3] },
  ];
  const result = computeIncrementalCoverage(dir, changedLines, 1, 3, "incremental");
  expect(result.percentage).toBeNull();
  expect(result.fallbackReason).toBeTruthy();
  expect(result.changedLineCount).toBe(3);
  });

  it("returns null percentage when no changed lines", () => {
  const result = computeIncrementalCoverage(dir, [], 0, 5, "full");
  expect(result.percentage).toBeNull();
  expect(result.changedLineCount).toBe(0);
  expect(result.fallbackReason).toBeTruthy();
  });

  it("handles 100% incremental coverage", () => {
  const filePath = join(dir, "src", "Service.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(filePath, "code");
  mkdirSync(join(dir, "coverage"), { recursive: true });

  const report = {
    [filePath]: {
      statementMap: {
        "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        "1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
      },
      s: { "0": 1, "1": 1 },
    },
  };
  writeFileSync(join(dir, "coverage", "coverage-final.json"), JSON.stringify(report));

  const changedLines: ChangedFileLines[] = [
    { file: "src/Service.ts", addedLines: [1, 2] },
  ];

  const result = computeIncrementalCoverage(dir, changedLines, 2, 2, "incremental");
  expect(result.percentage).toBe(100);
  expect(result.coveredChangedLineCount).toBe(2);
  });

  it("handles 0% incremental coverage", () => {
  const filePath = join(dir, "src", "Service.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(filePath, "code");
  mkdirSync(join(dir, "coverage"), { recursive: true });

  const report = {
    [filePath]: {
      statementMap: {
        "0": { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
      },
      s: { "0": 1 }, // line 10 covered, but changed lines are 1,2
    },
  };
  writeFileSync(join(dir, "coverage", "coverage-final.json"), JSON.stringify(report));

  const changedLines: ChangedFileLines[] = [
    { file: "src/Service.ts", addedLines: [1, 2] },
  ];

  const result = computeIncrementalCoverage(dir, changedLines, 1, 3, "incremental");
  expect(result.percentage).toBe(0);
  expect(result.coveredChangedLineCount).toBe(0);
  });

  it("preserves mode in result", () => {
  const result = computeIncrementalCoverage(dir, [], 0, 0, "full");
  expect(result.mode).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 验收场景对照
// ---------------------------------------------------------------------------

describe("PRD 7.5 验收场景", () => {
  let dir: string;
  beforeEach(() => { dir = makeGitProject(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY/ENOTEMPTY on Windows */ }
  });

  it("场景A：选对用例不漏跑 — changed file → affected cases ⊇ truly affected", () => {
    // Modify OrderService.ts
    modifyFile(dir, "src/OrderService.ts", "export class OrderService {\n  calc() {\n    return 99;\n  }\n  refund() {\n    return 1;\n  }\n}\n");

    const changedFiles = getChangedFiles(dir);
    expect(changedFiles).toContain("src/OrderService.ts");

    const cases = [
      makeCase("OrderServiceTest", "src/OrderService.ts:10"),
      makeCase("OrderIntegrationTest", "src/OrderService.ts:20"),
      makeCase("OtherServiceTest", "src/OtherService.ts:5"),
      makeCase("无目标隐式依赖用例"), // no target → included
    ];

    const result = selectAffectedCases(cases, changedFiles);
    // Superset guarantee: all cases targeting changed file are selected
    expect(result.affected.some((c) => c.title === "OrderServiceTest")).toBe(true);
    expect(result.affected.some((c) => c.title === "OrderIntegrationTest")).toBe(true);
    // Conservative: cases without target are also included
    expect(result.affected.some((c) => c.title === "无目标隐式依赖用例")).toBe(true);
    // Unchanged file cases are skipped
    expect(result.skipped.some((c) => c.title === "OtherServiceTest")).toBe(true);
  });

  it("场景B：增量覆盖率针对变更代码 — not diluted by full coverage", () => {
    // Modify OrderService.ts to add new method
    modifyFile(dir, "src/OrderService.ts", "export class OrderService {\n  calc() {\n    return 42;\n  }\n  refund() {\n    return 1;\n  }\n}\n");

    // Create coverage report that covers refund() (lines 5-6) but not fully
    mkdirSync(join(dir, "coverage"), { recursive: true });
  const filePath = join(dir, "src", "OrderService.ts");
  const report = {
    [filePath]: {
      statementMap: {
        "0": { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } }, // refund line covered
      },
      s: { "0": 1 },
    },
  };
  writeFileSync(join(dir, "coverage", "coverage-final.json"), JSON.stringify(report));

    const changedLines = getChangedLines(dir);
    expect(changedLines.length).toBeGreaterThan(0);

    const result = computeIncrementalCoverage(dir, changedLines, 1, 1, "incremental");
    // Incremental coverage is specific to changed lines, not full coverage
    expect(result.percentage).not.toBeNull();
    expect(result.changedLineCount).toBeGreaterThan(0);
    expect(result.coveredChangedLineCount).toBeGreaterThan(0);
  });

  it("场景C：全量兜底 — no git changes → fallback to full run", () => {
    // No changes in the repo
    const changedFiles = getChangedFiles(dir);
    expect(changedFiles).toEqual([]);

    const cases = [makeCase("用例1", "src/OrderService.ts:1"), makeCase("用例2", "src/OtherService.ts:1")];
    const result = selectAffectedCases(cases, changedFiles);

    // Fallback: all cases are "affected"
    expect(result.affected).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.fallbackReason).toBeTruthy();
  });
});
