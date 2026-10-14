import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CaseLibrary,
  computeProjectHash,
  computeCaseId,
  computeCodeHash,
  extractTargetFile,
  type StoredCase,
} from "../src/core/cases.js";
import type { TestCase } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeCase(title: string, target?: string): TestCase {
  return {
    id: "temp-id",
    title,
    scenario: `测试 ${title}`,
    steps: ["步骤1", "步骤2"],
    expected: "预期结果",
    priority: "medium",
    layer: "unit",
    ...(target ? { target } : {}),
  };
}

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "case-lib-"));
  // 写一个源文件，使 computeCodeHash 有内容可 hash
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "OrderService.ts"), "export class OrderService { calc() { return 42; } }");
  return dir;
}

// ---------------------------------------------------------------------------
// Hash 函数
// ---------------------------------------------------------------------------

describe("computeProjectHash", () => {
  it("returns stable hash for the same path", () => {
    const h1 = computeProjectHash("/foo/bar");
    const h2 = computeProjectHash("/foo/bar");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });

  it("normalizes path separators and case", () => {
    const h1 = computeProjectHash("C:\\Users\\test");
    const h2 = computeProjectHash("c:/users/test");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different paths", () => {
    expect(computeProjectHash("/foo/bar")).not.toBe(computeProjectHash("/foo/baz"));
  });
});

describe("computeCaseId", () => {
  it("returns stable hash for same projectHash + title", () => {
    const id1 = computeCaseId("abc123", "订单创建测试");
    const id2 = computeCaseId("abc123", "订单创建测试");
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it("returns different hash for different titles", () => {
    expect(computeCaseId("abc", "标题A")).not.toBe(computeCaseId("abc", "标题B"));
  });

  it("returns different hash for different project hashes", () => {
    expect(computeCaseId("abc", "标题")).not.toBe(computeCaseId("xyz", "标题"));
  });
});

describe("computeCodeHash", () => {
  it("returns stable hash for unchanged files", () => {
    const dir = makeTempProject();
    try {
      const h1 = computeCodeHash(dir);
      const h2 = computeCodeHash(dir);
      expect(h1.codeHash).toBe(h2.codeHash);
      expect(h1.codeHash).toHaveLength(16);
      expect(Object.keys(h1.fileHashes).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes hash when source file content changes", () => {
    const dir = makeTempProject();
    try {
      const h1 = computeCodeHash(dir);
      writeFileSync(join(dir, "src", "OrderService.ts"), "export class OrderService { calc() { return 99; } }");
      const h2 = computeCodeHash(dir);
      expect(h1.codeHash).not.toBe(h2.codeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes test files from hash", () => {
    const dir = makeTempProject();
    try {
      const h1 = computeCodeHash(dir);
      writeFileSync(join(dir, "src", "OrderService.test.ts"), "test('foo', () => {})");
      const h2 = computeCodeHash(dir);
      expect(h1.codeHash).toBe(h2.codeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes node_modules and .test-agent", () => {
    const dir = makeTempProject();
    try {
      const h1 = computeCodeHash(dir);
      mkdirSync(join(dir, "node_modules", "lib"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "lib", "index.js"), "module.exports = {}");
      mkdirSync(join(dir, ".test-agent"), { recursive: true });
      writeFileSync(join(dir, ".test-agent", "data.json"), "{}");
      const h2 = computeCodeHash(dir);
      expect(h1.codeHash).toBe(h2.codeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes deeply nested source files (Java Maven layout, depth 6+)", () => {
    // P1-2 fix: depth-3 cap caused codeHash to miss src/main/java/com/company/Service.java
    const dir = mkdtempSync(join(tmpdir(), "case-lib-deep-"));
    try {
      // Mimic Java Maven layout: src/main/java/com/company/Service.java (depth 6)
      const deepDir = join(dir, "src", "main", "java", "com", "company");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "Service.java"), "public class Service { void calc() {} }");

      const result = computeCodeHash(dir);
      // The deep file must appear in fileHashes
      const deepRel = "src/main/java/com/company/Service.java";
      expect(result.fileHashes[deepRel]).toBeDefined();
      expect(Object.keys(result.fileHashes).length).toBe(1);

      // Changing the deep file must change codeHash
      writeFileSync(join(deepDir, "Service.java"), "public class Service { void calc() { return 1; } }");
      const result2 = computeCodeHash(dir);
      expect(result.codeHash).not.toBe(result2.codeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractTargetFile", () => {
  it("extracts file path from path:line format", () => {
    expect(extractTargetFile("src/order/OrderService.java:42")).toBe("src/order/OrderService.java");
  });

  it("extracts file path without line number", () => {
    expect(extractTargetFile("src/order/OrderService.ts")).toBe("src/order/OrderService.ts");
  });

  it("returns undefined for method name targets", () => {
    expect(extractTargetFile("OrderService.calc()")).toBeUndefined();
  });

  it("returns undefined for API path targets", () => {
    expect(extractTargetFile("GET /api/orders")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CaseLibrary
// ---------------------------------------------------------------------------

describe("CaseLibrary", () => {
  let projectDir: string;
  let library: CaseLibrary;

  beforeEach(() => {
    projectDir = makeTempProject();
    library = new CaseLibrary(projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("saveCase + load", () => {
    it("saves a case and loads it back", () => {
      const tc = makeCase("订单创建测试", "src/OrderService.ts:10");
      const stored = library.saveCase(tc);

      expect(stored.caseId).toHaveLength(16);
      expect(stored.version).toBe(1);
      expect(stored.deleted).toBe(false);
      expect(stored.case.title).toBe("订单创建测试");
      expect(stored.history).toHaveLength(1);

      const loaded = library.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].case.title).toBe("订单创建测试");
    });

    it("assigns stable case ID based on projectHash + title", () => {
      const tc = makeCase("订单创建测试");
      const stored = library.saveCase(tc);
      const expectedId = computeCaseId(library.projectHashValue, "订单创建测试");
      expect(stored.caseId).toBe(expectedId);
      expect(stored.case.id).toBe(expectedId);
    });

    it("appends version history on re-save", () => {
      const tc1 = makeCase("订单创建测试", "src/OrderService.ts:10");
      library.saveCase(tc1);

      const tc2 = { ...tc1, expected: "新的预期结果" };
      const stored2 = library.saveCase(tc2);

      expect(stored2.version).toBe(2);
      expect(stored2.history).toHaveLength(2);
      expect(stored2.history[0].reason).toBe("initial");
      expect(stored2.history[1].reason).toBe("save");
      // 旧版本保留
      expect(stored2.history[0].case.expected).toBe("预期结果");
      expect(stored2.history[1].case.expected).toBe("新的预期结果");
    });

    it("preserves createdAt on re-save", () => {
      const tc = makeCase("测试用例");
      const stored1 = library.saveCase(tc);
      const stored2 = library.saveCase(tc);

      expect(stored2.createdAt).toBe(stored1.createdAt);
      expect(stored2.updatedAt).not.toBe(stored1.createdAt);
    });

    it("stores taskId in StoredCase and CaseVersion (PRD 5.5 场景A)", () => {
      const tc = makeCase("关联任务用例", "src/OrderService.ts:10");
      const stored = library.saveCase(tc, "task-abc-123");

      // StoredCase carries taskId
      expect(stored.taskId).toBe("task-abc-123");
      // Initial CaseVersion carries taskId
      expect(stored.history).toHaveLength(1);
      expect(stored.history[0].taskId).toBe("task-abc-123");

      // Reload from disk preserves taskId
      const reloaded = library.getCase(stored.caseId);
      expect(reloaded!.taskId).toBe("task-abc-123");
      expect(reloaded!.history[0].taskId).toBe("task-abc-123");
    });

    it("omits taskId when not provided", () => {
      const tc = makeCase("无任务用例");
      const stored = library.saveCase(tc);
      expect(stored.taskId).toBeUndefined();
      expect(stored.history[0].taskId).toBeUndefined();
    });
  });

  describe("deleteCase", () => {
    it("soft-deletes a case (not removed from disk)", () => {
      const tc = makeCase("待删除用例");
      const stored = library.saveCase(tc);
      const caseId = stored.caseId;

      const deleted = library.deleteCase(caseId);
      expect(deleted).toBe(true);

      // load() 不返回已删除的用例
      expect(library.load()).toHaveLength(0);

      // 但文件还在（历史可回滚）
      const raw = library.getCase(caseId);
      expect(raw).toBeDefined();
      expect(raw!.deleted).toBe(true);
      expect(raw!.history).toHaveLength(2);
      expect(raw!.history[1].reason).toBe("delete");
    });

    it("returns false for non-existent case", () => {
      expect(library.deleteCase("nonexistent")).toBe(false);
    });
  });

  describe("getHistory", () => {
    it("returns version history", () => {
      const tc = makeCase("历史用例");
      const stored = library.saveCase(tc);
      library.saveCase({ ...tc, expected: "v2" });
      library.saveCase({ ...tc, expected: "v3" });

      const history = library.getHistory(stored.caseId);
      expect(history).toHaveLength(3);
      expect(history[0].case.expected).toBe("预期结果");
      expect(history[1].case.expected).toBe("v2");
      expect(history[2].case.expected).toBe("v3");
    });

    it("returns empty array for non-existent case", () => {
      expect(library.getHistory("nonexistent")).toEqual([]);
    });
  });

  describe("rollback", () => {
    it("rolls back to a previous version", () => {
      const tc = makeCase("回滚用例");
      const stored = library.saveCase(tc);
      const caseId = stored.caseId;

      library.saveCase({ ...tc, expected: "v2" });
      library.saveCase({ ...tc, expected: "v3" });

      // 回滚到 v1
      const rolled = library.rollback(caseId, 1);
      expect(rolled).toBeDefined();
      expect(rolled!.version).toBe(4);
      expect(rolled!.case.expected).toBe("预期结果");
      expect(rolled!.deleted).toBe(false);

      // 历史保留所有版本（包括回滚动作）
      expect(rolled!.history).toHaveLength(4);
      expect(rolled!.history[3].reason).toBe("rollback");
    });

    it("returns undefined for non-existent version", () => {
      const tc = makeCase("用例");
      const stored = library.saveCase(tc);
      expect(library.rollback(stored.caseId, 999)).toBeUndefined();
    });
  });

  describe("updateCodeHash + getStoredCodeHash", () => {
    it("stores and retrieves code hash", () => {
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      const stored = library.getStoredCodeHash();
      expect(stored).toBeDefined();
      expect(stored!.codeHash).toBe(codeHash);
      expect(stored!.fileHashes).toEqual(fileHashes);
    });

    it("returns undefined when no index exists", () => {
      expect(library.getStoredCodeHash()).toBeUndefined();
    });
  });

  describe("findReusableCases", () => {
    it("returns all cases when code hash matches (no file-level check needed)", () => {
      const tc = makeCase("用例1", "src/OrderService.ts:10");
      library.saveCase(tc);
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      // Same file hashes → all reusable
      const reusable = library.findReusableCases(fileHashes);
      expect(reusable).toHaveLength(1);
      expect(reusable[0].title).toBe("用例1");
    });

    it("excludes cases whose target file changed", () => {
      library.saveCase(makeCase("用例1", "src/OrderService.ts:10"));
      library.saveCase(makeCase("用例2", "src/OtherService.ts:5"));
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      // Modify OrderService.ts → its hash changes
      writeFileSync(join(projectDir, "src", "OrderService.ts"), "export class OrderService { calc() { return 99; } }");
      const { fileHashes: newFileHashes } = computeCodeHash(projectDir);

      const reusable = library.findReusableCases(newFileHashes);
      expect(reusable).toHaveLength(1);
      expect(reusable[0].title).toBe("用例2"); // OtherService.ts unchanged
    });

    it("includes cases without target (conservative reuse)", () => {
      library.saveCase(makeCase("无目标用例"));
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      const reusable = library.findReusableCases(fileHashes);
      expect(reusable).toHaveLength(1);
    });

    it("includes cases with non-file targets (conservative reuse)", () => {
      library.saveCase(makeCase("API用例", "GET /api/orders"));
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      const reusable = library.findReusableCases(fileHashes);
      expect(reusable).toHaveLength(1);
    });
  });

  describe("queryByTargets", () => {
    it("returns cases whose target matches changed files", () => {
      library.saveCase(makeCase("用例1", "src/OrderService.ts:10"));
      library.saveCase(makeCase("用例2", "src/OtherService.ts:5"));
      library.saveCase(makeCase("用例3", "GET /api/orders"));

      const matched = library.queryByTargets(["src/OrderService.ts"]);
      expect(matched).toHaveLength(1);
      expect(matched[0].title).toBe("用例1");
    });

    it("returns all cases when changedFiles is empty", () => {
      library.saveCase(makeCase("用例1"));
      library.saveCase(makeCase("用例2"));

      const matched = library.queryByTargets([]);
      expect(matched).toHaveLength(2);
    });
  });

  describe("persistence format", () => {
    it("stores cases at .test-agent/cases/<projectHash>/cases/<caseId>.json", () => {
      const tc = makeCase("格式验证用例");
      const stored = library.saveCase(tc);
      const expectedPath = join(
        projectDir, ".test-agent", "cases", library.projectHashValue, "cases", `${stored.caseId}.json`,
      );
      expect(existsSync(expectedPath)).toBe(true);

      const raw = JSON.parse(readFileSync(expectedPath, "utf8")) as StoredCase;
      expect(raw.caseId).toBe(stored.caseId);
      expect(raw.case.title).toBe("格式验证用例");
    });

    it("stores index at .test-agent/cases/<projectHash>/index.json", () => {
      library.saveCase(makeCase("用例"));
      const { codeHash, fileHashes } = computeCodeHash(projectDir);
      library.updateCodeHash(codeHash, fileHashes);

      const indexPath = join(projectDir, ".test-agent", "cases", library.projectHashValue, "index.json");
      expect(existsSync(indexPath)).toBe(true);

      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      expect(index.projectHash).toBe(library.projectHashValue);
      expect(index.codeHash).toBe(codeHash);
      expect(index.caseCount).toBe(1);
    });
  });
});
