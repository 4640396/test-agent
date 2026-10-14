/**
 * 用例库 — Worker 本地持久化的测试用例生命周期管理。
 *
 * 存储布局（控制面零改动，纯文件系统）：
 *   .test-agent/cases/<projectHash>/
 *     index.json              # { projectHash, codeHash, fileHashes, lastUpdatedAt, caseCount }
 *     cases/
 *       <caseId>.json         # StoredCase（含版本历史）
 *
 * 用例 ID = SHA-256(projectHash + ":" + title) 前 16 字符，跨运行稳定。
 * 版本化：每次 saveCase/deleteCase/rollback 追加一条 CaseVersion 到 history，旧版本归档不删。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

/** history 版本上限（LRU 淘汰最旧），可配 TEST_AGENT_MAX_HISTORY 环境变量。 */
const MAX_HISTORY = Number(process.env.TEST_AGENT_MAX_HISTORY ?? "50");
import { join, relative, resolve } from "node:path";
import type { TestCase } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 用例版本记录（每次修改追加一条，旧版本归档不删）。 */
export interface CaseVersion {
  version: number;
  case: TestCase;
  createdAt: string;
  taskId?: string;
  /** 版本创建原因：initial | save | edit | delete | rollback。 */
  reason: string;
}

/** 持久化的用例（含版本历史）。 */
export interface StoredCase {
  caseId: string;
  projectHash: string;
  case: TestCase;
  version: number;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  deleted: boolean;
  history: CaseVersion[];
}

/** 用例库索引（记录项目代码指纹，驱动复用判定）。 */
export interface CaseLibraryIndex {
  projectHash: string;
  codeHash: string;
  /** 按文件路径索引的内容 hash（相对路径 → 8 字符 hash），驱动文件级增量复用。 */
  fileHashes: Record<string, string>;
  lastUpdatedAt: string;
  caseCount: number;
}

// ---------------------------------------------------------------------------
// Hash 函数
// ---------------------------------------------------------------------------

/** 项目 hash：规范化路径的 SHA-256 前 16 字符。 */
export function computeProjectHash(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** 用例 ID：SHA-256(projectHash + ":" + title) 前 16 字符，跨运行稳定。 */
export function computeCaseId(projectHash: string, title: string): string {
  return createHash("sha256").update(`${projectHash}:${title}`).digest("hex").slice(0, 16);
}

const SOURCE_EXTENSIONS = /\.(ts|js|mjs|cjs|java|go|py|vue|jsx|tsx)$/;
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|mjs|cjs|jsx|tsx)$|_test\.(go|py)$|Test\.(java)$/;
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".test-agent", "out",
]);

/** 扫描结果：整体 code hash + 按文件的内容 hash 映射。 */
export interface CodeHashResult {
  codeHash: string;
  fileHashes: Record<string, string>;
}

/**
 * 计算项目源码指纹。
 *
 * 遍历源文件（排除测试文件、node_modules 等），对每个文件内容取 SHA-256 前 8
 * 字符，再对排序后的 "path:hash" 拼接取 SHA-256 前 16 字符作为整体 codeHash。
 * codeHash 变 → 被测代码变了 → 强制新生成用例。
 */
export function computeCodeHash(projectPath: string): CodeHashResult {
  const root = resolve(projectPath);
  const fileHashes: Record<string, string> = {};

  function walk(dir: string, depth: number): void {
    // No depth limit — Java Maven layout src/main/java/com/company/ reaches depth 6+;
    // a depth-3 cap causes codeHash to be constant for all deep-source projects.
    // EXCLUDE_DIRS + hidden-dir skip already guard against infinite recursion.
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!EXCLUDE_DIRS.has(name) && !name.startsWith(".")) walk(full, depth + 1);
      } else {
        if (SOURCE_EXTENSIONS.test(name) && !TEST_FILE_PATTERN.test(name)) {
          try {
            const content = readFileSync(full, "utf8");
            const rel = relative(root, full).replace(/\\/g, "/");
            fileHashes[rel] = createHash("sha256").update(content).digest("hex").slice(0, 8);
          } catch { /* 忽略读取失败 */ }
        }
      }
    }
  }
  walk(root, 0);

  const sortedKeys = Object.keys(fileHashes).sort();
  const hashInput = sortedKeys.map((k) => `${k}:${fileHashes[k]}`).join("|");
  const codeHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
  return { codeHash, fileHashes };
}

/**
 * 从 target 字段提取文件路径。
 *
 * target 格式可能是 "src/order/OrderService.java:42"（文件:行号）或
 * "OrderService.calc()"（方法名）或 "GET /api/orders"（API 路径）。
 * 只有能识别出文件路径的 target 才用于文件级增量复用判断。
 */
export function extractTargetFile(target: string): string | undefined {
  const match = target.match(/^([^\s:]+\.(?:ts|js|mjs|cjs|java|go|py|vue|jsx|tsx))/);
  return match ? match[1].replace(/\\/g, "/") : undefined;
}

// ---------------------------------------------------------------------------
// CaseLibrary
// ---------------------------------------------------------------------------

/**
 * 用例库 — 管理单个项目的持久化用例。
 *
 * 所有操作都是文件系统级别的，不依赖控制面（Java/MySQL/Flyway）。
 * 线程安全：单 Worker 进程内串行调用，无并发写入。
 */
export class CaseLibrary {
  private readonly dir: string;
  private readonly casesDir: string;
  private readonly indexPath: string;

  constructor(
    private readonly projectPath: string,
    private readonly projectHash: string = computeProjectHash(projectPath),
  ) {
    this.dir = join(projectPath, ".test-agent", "cases", projectHash);
    this.casesDir = join(this.dir, "cases");
    this.indexPath = join(this.dir, "index.json");
  }

  get projectHashValue(): string {
    return this.projectHash;
  }

  // --- 索引 ---

  loadIndex(): CaseLibraryIndex | undefined {
    if (!existsSync(this.indexPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8")) as CaseLibraryIndex;
    } catch { return undefined; }
  }

  private saveIndex(index: CaseLibraryIndex): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  private refreshIndex(): void {
    const existing = this.loadIndex();
    const activeCases = this.load();
    const now = new Date().toISOString();
    if (existing) {
      existing.caseCount = activeCases.length;
      existing.lastUpdatedAt = now;
      this.saveIndex(existing);
    } else {
      this.saveIndex({
        projectHash: this.projectHash,
        codeHash: "",
        fileHashes: {},
        lastUpdatedAt: now,
        caseCount: activeCases.length,
      });
    }
  }

  // --- 用例 CRUD ---

  /** 加载所有未删除的用例。 */
  load(): StoredCase[] {
    if (!existsSync(this.casesDir)) return [];
    const cases: StoredCase[] = [];
    for (const file of readdirSync(this.casesDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const stored = JSON.parse(readFileSync(join(this.casesDir, file), "utf8")) as StoredCase;
        if (stored && !stored.deleted) cases.push(stored);
      } catch { /* 忽略损坏文件 */ }
    }
    return cases;
  }

  /** 加载单个用例（含已删除）。 */
  getCase(caseId: string): StoredCase | undefined {
    const filePath = join(this.casesDir, `${caseId}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as StoredCase;
    } catch { return undefined; }
  }

  /**
   * 保存用例（含版本历史）。
   *
   * 如果用例已存在，追加新版本到 history；如果不存在，创建初始版本。
   * 用例 ID 由 projectHash + title 稳定 hash 生成。
   */
  saveCase(testCase: TestCase, taskId?: string): StoredCase {
    mkdirSync(this.casesDir, { recursive: true });
    const caseId = computeCaseId(this.projectHash, testCase.title);
    const existing = this.getCase(caseId);
    const now = new Date().toISOString();

    // P4-7: 同步 structuredScenario.id 与 case.id（修复 ID 重分配后不一致）
    const caseWithId: TestCase = testCase.structuredScenario
      ? { ...testCase, id: caseId, structuredScenario: { ...testCase.structuredScenario, id: caseId } }
      : { ...testCase, id: caseId };

    const newVersion: CaseVersion = {
      version: existing ? existing.version + 1 : 1,
      case: caseWithId,
      createdAt: now,
      ...(taskId ? { taskId } : {}),
      reason: existing ? "save" : "initial",
    };

    const stored: StoredCase = {
      caseId,
      projectHash: this.projectHash,
      case: caseWithId,
      version: newVersion.version,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(taskId ? { taskId } : {}),
      deleted: false,
      history: existing ? [...existing.history, newVersion].slice(-MAX_HISTORY) : [newVersion],
    };

    writeFileSync(join(this.casesDir, `${caseId}.json`), JSON.stringify(stored, null, 2), "utf8");
    this.refreshIndex();
    return stored;
  }

  /** 软删除用例（标记 deleted=true，保留历史可回滚）。 */
  deleteCase(caseId: string): boolean {
    const existing = this.getCase(caseId);
    if (!existing || existing.deleted) return false;

    const now = new Date().toISOString();
    const deleteVersion: CaseVersion = {
      version: existing.version + 1,
      case: existing.case,
      createdAt: now,
      reason: "delete",
    };

    const stored: StoredCase = {
      ...existing,
      version: deleteVersion.version,
      updatedAt: now,
      deleted: true,
      history: [...existing.history, deleteVersion].slice(-MAX_HISTORY),
    };

    writeFileSync(join(this.casesDir, `${caseId}.json`), JSON.stringify(stored, null, 2), "utf8");
    this.refreshIndex();
    return true;
  }

  /** 获取用例版本历史。 */
  getHistory(caseId: string): CaseVersion[] {
    return this.getCase(caseId)?.history ?? [];
  }

  /** 回滚用例到指定版本（追加一条 rollback 版本，不删历史）。 */
  rollback(caseId: string, version: number): StoredCase | undefined {
    const stored = this.getCase(caseId);
    if (!stored) return undefined;
    const targetVersion = stored.history.find((v) => v.version === version);
    if (!targetVersion) return undefined;

    const now = new Date().toISOString();
    const rollbackVersion: CaseVersion = {
      version: stored.version + 1,
      case: targetVersion.case,
      createdAt: now,
      reason: "rollback",
    };

    const updated: StoredCase = {
      ...stored,
      case: targetVersion.case,
      version: rollbackVersion.version,
      updatedAt: now,
      deleted: false,
      history: [...stored.history, rollbackVersion].slice(-MAX_HISTORY),
    };

    writeFileSync(join(this.casesDir, `${caseId}.json`), JSON.stringify(updated, null, 2), "utf8");
    this.refreshIndex();
    return updated;
  }

  // --- 代码指纹 ---

  /** 获取库中存储的代码指纹（code hash + per-file hashes）。 */
  getStoredCodeHash(): CodeHashResult | undefined {
    const index = this.loadIndex();
    if (!index) return undefined;
    return { codeHash: index.codeHash, fileHashes: index.fileHashes ?? {} };
  }

  /** 更新代码指纹（执行后调用，记录当前代码状态）。 */
  updateCodeHash(codeHash: string, fileHashes: Record<string, string>): void {
    const existing = this.loadIndex();
    const now = new Date().toISOString();
    if (existing) {
      existing.codeHash = codeHash;
      existing.fileHashes = fileHashes;
      existing.lastUpdatedAt = now;
      this.saveIndex(existing);
    } else {
      this.saveIndex({
        projectHash: this.projectHash,
        codeHash,
        fileHashes,
        lastUpdatedAt: now,
        caseCount: 0,
      });
    }
  }

  // --- 复用判定 ---

  /**
   * 查找可复用用例（文件级增量复用）。
   *
   * 对每条用例，检查其 target 文件的内容 hash 是否与存储时一致。
   * hash 未变 → 可复用；hash 变了 → 需重新生成；无法映射文件 → 保守复用。
   *
   * @param currentFileHashes 当前项目的 per-file hashes（来自 computeCodeHash）
   * @returns 可复用的用例列表
   */
  findReusableCases(currentFileHashes: Record<string, string>): TestCase[] {
    const index = this.loadIndex();
    if (!index) return [];

    const storedHashes = index.fileHashes ?? {};
    const cases = this.load();

    return cases
      .filter((s) => {
        if (!s.case.target) return true; // 无 target → 保守复用
        const targetFile = extractTargetFile(s.case.target);
        if (!targetFile) return true; // 无法映射文件 → 保守复用
        const stored = storedHashes[targetFile];
        const current = currentFileHashes[targetFile];
        if (stored && current) return stored === current; // hash 匹配 → 复用
        if (!stored && !current) return true; // 文件未被追踪 → 复用
        return false; // hash 变了或文件出现/消失 → 不复用
      })
      .map((s) => s.case);
  }

  /**
   * 按 target 文件映射查询用例（变更影响分析用）。
   *
   * @param changedFiles 变更文件列表（相对路径）
   * @returns target 匹配变更文件的用例
   */
  queryByTargets(changedFiles: string[]): TestCase[] {
    const cases = this.load();
    if (changedFiles.length === 0) return cases.map((s) => s.case);

    const normalized = new Set(changedFiles.map((f) => f.replace(/\\/g, "/")));
    return cases
      .filter((s) => {
        if (!s.case.target) return false;
        const targetFile = extractTargetFile(s.case.target);
        return targetFile ? normalized.has(targetFile) : false;
      })
      .map((s) => s.case);
  }
}
