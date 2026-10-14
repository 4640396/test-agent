/**
 * 变更影响分析 + 增量覆盖率 — PRD 功能三。
 *
 * 文件级粗粒度（首期，方法级依赖图二期不做）：
 * 1. git diff → 变更文件 → 用例 target 字段映射 → 选受影响用例子集
 * 2. 增量覆盖率 = 变更代码行 ∩ 覆盖行（需行级覆盖率报告）
 * 3. 全量跑开关（默认增量），无 git/无变更时降级全量
 *
 * 控制面零改动：所有逻辑在 Worker 层完成，不依赖 Java 控制面/MySQL/Flyway。
 *
 * 依赖片1：用例库 target 字段映射（cases.ts extractTargetFile）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { TestCase, IncrementalCoverageResult } from "./types.js";
import { extractTargetFile } from "./cases.js";

interface GitProjectScope {
  projectRoot: string;
  projectPrefix: string;
}

function getGitProjectScope(projectPath: string): GitProjectScope | undefined {
  const projectRoot = resolve(projectPath);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;

  const repositoryRoot = resolve(result.stdout.trim());
  const projectPrefix = relative(repositoryRoot, projectRoot).replace(/\\/g, "/");
  if (projectPrefix === ".." || projectPrefix.startsWith("../")) return undefined;
  return { projectRoot, projectPrefix };
}

function toProjectRelativePath(file: string, projectPrefix: string): string | undefined {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!projectPrefix) return normalized;
  const prefix = `${projectPrefix}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

// ---------------------------------------------------------------------------
// Git diff 变更文件
// ---------------------------------------------------------------------------

/**
 * 读取 git diff 识别变更文件（相对路径，正斜杠分隔）。
 *
 * - 无 baseRef：`git diff HEAD --name-only`（工作区 vs HEAD）
 * - 有 baseRef：`git diff <baseRef> HEAD --name-only`
 * - 非 git 仓库 / git 不可用 / 无变更 → 返回空数组（调用方降级全量跑）
 *
 * @param projectPath 项目根目录
 * @param baseRef 对比基准（默认 HEAD）
 * @returns 变更文件相对路径列表
 */
export function getChangedFiles(projectPath: string, baseRef?: string): string[] {
  const ref = baseRef ?? process.env.TEST_AGENT_GIT_BASE_REF ?? "HEAD";
  try {
    const scope = getGitProjectScope(projectPath);
    if (!scope) return [];
    const result = spawnSync("git", ["diff", "--name-only", ref], {
      cwd: scope.projectRoot,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((file) => toProjectRelativePath(file, scope.projectPrefix))
      .filter((file): file is string => file !== undefined);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Git diff 变更行号
// ---------------------------------------------------------------------------

/** 单文件的变更行信息（新增行号列表）。 */
export interface ChangedFileLines {
  file: string;
  addedLines: number[];
}

/**
 * 解析 git diff --unified=0 提取每个变更文件的新增行号。
 *
 * hunk header `@@ -old_start,old_count +new_start,new_count @@` 标记新文件起始行号。
 * `+` 开头的行是新增行，按 new_start 递增计数。
 *
 * @param projectPath 项目根目录
 * @param baseRef 对比基准（默认 HEAD）
 * @returns 每个变更文件的 AddedFileLines（只有有新增行的文件才包含）
 */
export function getChangedLines(projectPath: string, baseRef?: string): ChangedFileLines[] {
  const ref = baseRef ?? process.env.TEST_AGENT_GIT_BASE_REF ?? "HEAD";
  try {
    const scope = getGitProjectScope(projectPath);
    if (!scope) return [];
    const result = spawnSync("git", ["diff", "--unified=0", ref], {
      cwd: scope.projectRoot,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return [];
    return parseDiffForAddedLines(result.stdout).flatMap((entry) => {
      const file = toProjectRelativePath(entry.file, scope.projectPrefix);
      return file ? [{ ...entry, file }] : [];
    });
  } catch {
    return [];
  }
}

/** 解析 unified diff 文本，提取每个文件的新增行号。 */
export function parseDiffForAddedLines(diffText: string): ChangedFileLines[] {
  const results: ChangedFileLines[] = [];
  let currentFile: string | null = null;
  let currentLines: number[] = [];
  let newLineNum = 0;

  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
  // +++ b/path → 新文件路径
  if (line.startsWith("+++ ")) {
      // 保存前一个文件
      if (currentFile && currentLines.length > 0) {
        results.push({ file: currentFile, addedLines: currentLines });
      }
      const pathPart = line.slice(4).trim();
      // "/dev/null" 表示文件被删除，跳过
      if (pathPart === "/dev/null") {
        currentFile = null;
        currentLines = [];
        continue;
      }
      // 去掉 "b/" 前缀
      currentFile = pathPart.replace(/^b\//, "").replace(/\\/g, "/");
      currentLines = [];
      continue;
    }

    if (!currentFile) continue;

    // hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLineNum = Number(hunkMatch[1]);
      continue;
    }

    // 新增行（不以 --- 开头）
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLines.push(newLineNum);
      newLineNum++;
      continue;
    }

    // 删除行（不以 --- 开头）
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    // 上下文行（以空格开头）
    if (line.startsWith(" ") || line === "") {
      newLineNum++;
      continue;
    }

    // 其他行（如 "\ No newline at end of file"）跳过
  }

  // 保存最后一个文件
  if (currentFile && currentLines.length > 0) {
    results.push({ file: currentFile, addedLines: currentLines });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 选受影响用例（文件级粗粒度）
// ---------------------------------------------------------------------------

/** 用例筛选结果。 */
export interface AffectedCasesResult {
  /** 受影响用例（需要执行的子集）。 */
  affected: TestCase[];
  /** 未受影响用例（跳过的子集）。 */
  skipped: TestCase[];
  /** 变更文件列表。 */
  changedFiles: string[];
  /** 降级原因（无 git/无变更时全量跑的原因）。 */
  fallbackReason?: string;
}

/**
 * 按变更文件选受影响用例（文件级粗粒度，PRD 7.5 场景A）。
 *
 * 映射逻辑：
 * - 用例 target → extractTargetFile → 文件路径
 * - 文件路径 ∈ 变更文件集 → 受影响
 * - 无 target 或无法映射文件 → 保守包含（不漏跑）
 *
 * 降级：变更文件为空（无 git/无变更）→ 全量跑，所有用例都受影响。
 *
 * @param cases 全量用例
 * @param changedFiles 变更文件列表（相对路径，正斜杠）
 * @returns 受影响用例子集 + 跳过的用例
 */
export function selectAffectedCases(
  cases: TestCase[],
  changedFiles: string[],
): AffectedCasesResult {
  // 无变更 → 全量跑（降级）
  if (changedFiles.length === 0) {
    return {
      affected: cases,
      skipped: [],
      changedFiles: [],
      fallbackReason: "无变更文件（非 git 仓库或无变更），降级全量跑",
    };
  }

  const normalized = new Set(changedFiles.map((f) => f.replace(/\\/g, "/")));
  const affected: TestCase[] = [];
  const skipped: TestCase[] = [];

  for (const tc of cases) {
    if (!tc.target) {
      // 无 target → 保守包含（不漏跑）
      affected.push(tc);
      continue;
    }
    const targetFile = extractTargetFile(tc.target);
    if (!targetFile) {
      // 无法映射文件（方法名/API 路径等 target）→ 保守包含
      affected.push(tc);
      continue;
    }
    if (normalized.has(targetFile)) {
      affected.push(tc);
    } else {
      skipped.push(tc);
    }
  }

  return { affected, skipped, changedFiles };
}

// ---------------------------------------------------------------------------
// 增量覆盖率计算
// ---------------------------------------------------------------------------

/** 覆盖率报告中单文件的行级覆盖数据。 */
interface FileLineCoverage {
  file: string;
  coveredLines: Set<number>;
}

/**
 * 查找覆盖率报告文件（istanbul JSON 或 jacoco XML）。
 *
 * 搜索路径（相对项目根）：
 * - coverage/coverage-final.json（istanbul/vitest/c8 默认）
 * - .nyc_output/coverage-final.json（nyc）
 * - target/site/jacoco/jacoco.xml（Java jacoco）
 * - .test-agent/results/ 下最新的 coverage 目录
 *
 * @returns 覆盖率报告绝对路径，未找到返回 undefined
 */
export function findCoverageReport(projectPath: string): string | undefined {
  const root = resolve(projectPath);
  const candidates = [
    join(root, "coverage", "coverage-final.json"),
    join(root, ".nyc_output", "coverage-final.json"),
    join(root, "target", "site", "jacoco", "jacoco.xml"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // 搜索 .test-agent/results/*/coverage/coverage-final.json（取最新）
  const resultsDir = join(root, ".test-agent", "results");
  if (existsSync(resultsDir)) {
    try {
      const entries = readdirSync(resultsDir)
        .filter((name) => {
          const p = join(resultsDir, name);
          try { return statSync(p).isDirectory(); } catch { return false; }
        })
        .sort()
        .reverse(); // 最新的在前
      for (const name of entries) {
        const p = join(resultsDir, name, "coverage", "coverage-final.json");
        if (existsSync(p)) return p;
      }
    } catch { /* 忽略目录读取失败 */ }
  }

  return undefined;
}

/**
 * 解析 istanbul coverage-final.json，提取每文件的覆盖行集合。
 *
 * istanbul JSON 格式：每个文件有 statementMap（语句行范围）+ s（执行次数）。
 * 覆盖行 = 执行次数 > 0 的语句覆盖的行范围并集。
 */
export function parseIstanbulCoverage(
  reportPath: string,
  projectRoot: string,
): FileLineCoverage[] {
  try {
    const raw = readFileSync(reportPath, "utf8");
    const data = JSON.parse(raw) as Record<string, {
      statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
      s: Record<string, number>;
    }>;
    const results: FileLineCoverage[] = [];
    const root = resolve(projectRoot);

    for (const [absPath, entry] of Object.entries(data)) {
      const relPath = relative(root, absPath).replace(/\\/g, "/");
      if (!entry.statementMap || !entry.s) continue;
      const covered = new Set<number>();
      for (const [id, count] of Object.entries(entry.s)) {
        if (count <= 0) continue;
        const stmt = entry.statementMap[id];
        if (!stmt || !stmt.start || !stmt.end) continue;
        for (let ln = stmt.start.line; ln <= stmt.end.line; ln++) {
          covered.add(ln);
        }
      }
      results.push({ file: relPath, coveredLines: covered });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 解析 jacoco XML，提取每文件的覆盖行集合。
 *
 * jacoco XML 格式：sourcefile/line[@nr, @ci]（ci > 0 = 已覆盖）。
 */
export function parseJacocoCoverage(
  reportPath: string,
  _projectRoot: string,
): FileLineCoverage[] {
  try {
    const raw = readFileSync(reportPath, "utf8");
  const results: FileLineCoverage[] = [];

    // 简单 XML 解析（不引入 XML 依赖）：按 sourcefile 分组提取 line 元素
    const pkgRegex = /<package\s+name="([^"]+)"/;

    // 先找到 package 名，再匹配 sourcefile（简化：逐行扫描）
    const lines = raw.split(/\r?\n/);
    let currentPkg = "";
    let currentFile: string | null = null;
    let currentLines: Set<number> | null = null;

    for (const line of lines) {
      const pm = pkgRegex.exec(line);
      if (pm) {
        currentPkg = pm[1];
        continue;
      }
      const sfMatch = /<sourcefile\s+name="([^"]+)"/.exec(line);
      if (sfMatch) {
        if (currentFile && currentLines && currentLines.size > 0) {
          // jacoco 路径：package/name → 用包路径 + 文件名
          const filePath = currentPkg
            ? `${currentPkg.replace(/\./g, "/")}/${currentFile}`
            : currentFile;
          results.push({ file: filePath, coveredLines: currentLines });
        }
        currentFile = sfMatch[1];
        currentLines = new Set<number>();
        continue;
      }
      const lineMatch = /<line\s+nr="(\d+)"[^>]*\bci="(\d+)"/.exec(line);
      if (lineMatch && currentLines) {
        const nr = Number(lineMatch[1]);
        const ci = Number(lineMatch[2]);
        if (ci > 0) currentLines.add(nr);
        continue;
      }
      // sourcefile 结束（</sourcefile> 或 package 结束）
      if (/<\/sourcefile>/.test(line) || /<\/package>/.test(line)) {
        if (currentFile && currentLines && currentLines.size > 0) {
          const filePath = currentPkg
            ? `${currentPkg.replace(/\./g, "/")}/${currentFile}`
            : currentFile;
          results.push({ file: filePath, coveredLines: currentLines });
        }
        currentFile = null;
        currentLines = null;
        if (/<\/package>/.test(line)) currentPkg = "";
      }
    }

    // 遗漏的最后一个
    if (currentFile && currentLines && currentLines.size > 0) {
      const filePath = currentPkg
        ? `${currentPkg.replace(/\./g, "/")}/${currentFile}`
        : currentFile;
      results.push({ file: filePath, coveredLines: currentLines });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 计算增量覆盖率（变更代码行 ∩ 覆盖行，PRD 7.5 场景B）。
 *
 * @param projectPath 项目根目录
 * @param changedLines 变更行信息（来自 getChangedLines）
 * @param affectedCaseCount 受影响用例数
 * @param totalCaseCount 总用例数
 * @param mode 执行模式
 * @returns 增量覆盖率结果
 */
export function computeIncrementalCoverage(
  projectPath: string,
  changedLines: ChangedFileLines[],
  affectedCaseCount: number,
  totalCaseCount: number,
  mode: "incremental" | "full",
): IncrementalCoverageResult {
  const changedFiles = changedLines.map((c) => c.file);
  const changedLineCount = changedLines.reduce((sum, c) => sum + c.addedLines.length, 0);

  // 无变更行 → 无需计算
  if (changedLineCount === 0) {
    return {
      mode,
      changedFiles,
      changedLineCount: 0,
      coveredChangedLineCount: 0,
      percentage: null,
      affectedCaseCount,
      totalCaseCount,
      fallbackReason: "无变更代码行，无法计算增量覆盖率",
    };
  }

  // 查找覆盖率报告
  const reportPath = findCoverageReport(projectPath);
  if (!reportPath) {
    return {
      mode,
      changedFiles,
      changedLineCount,
      coveredChangedLineCount: 0,
      percentage: null,
      affectedCaseCount,
      totalCaseCount,
      fallbackReason: "未找到行级覆盖率报告（coverage-final.json / jacoco.xml），无法计算增量覆盖率",
    };
  }

  // 解析覆盖率报告
  let fileCoverages: FileLineCoverage[] = [];
  if (reportPath.endsWith(".json")) {
    fileCoverages = parseIstanbulCoverage(reportPath, projectPath);
  } else if (reportPath.endsWith(".xml")) {
    fileCoverages = parseJacocoCoverage(reportPath, projectPath);
  }

  if (fileCoverages.length === 0) {
    return {
      mode,
      changedFiles,
      changedLineCount,
      coveredChangedLineCount: 0,
      percentage: null,
      affectedCaseCount,
      totalCaseCount,
      fallbackReason: `覆盖率报告解析失败（${relative(projectPath, reportPath)}）`,
    };
  }

  // 构建文件 → 覆盖行集合 映射
  const coverageMap = new Map<string, Set<number>>();
  for (const fc of fileCoverages) {
    coverageMap.set(fc.file, fc.coveredLines);
    // 也用文件名（不含目录）作为备用 key
    const basename = fc.file.split("/").pop();
    if (basename && !coverageMap.has(basename)) {
      coverageMap.set(basename, fc.coveredLines);
    }
  }

  // 计算交集：变更行 ∩ 覆盖行
  let coveredCount = 0;
  for (const { file, addedLines } of changedLines) {
    let covered = coverageMap.get(file);
    if (!covered) {
      // 尝试用文件名匹配
      const basename = file.split("/").pop();
      covered = basename ? coverageMap.get(basename) : undefined;
    }
    if (!covered) continue;
    for (const ln of addedLines) {
      if (covered.has(ln)) coveredCount++;
    }
  }

  const percentage = changedLineCount > 0 ? Math.round((coveredCount / changedLineCount) * 1000) / 10 : null;

  return {
    mode,
    changedFiles,
    changedLineCount,
    coveredChangedLineCount: coveredCount,
    percentage,
    affectedCaseCount,
    totalCaseCount,
  };
}
