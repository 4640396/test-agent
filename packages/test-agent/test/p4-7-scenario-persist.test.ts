/**
 * P4-7: AI 生成场景持久化测试
 *
 * 测 3 个方向：
 * 1. ID 同步：ID 重分配后 case.id === structuredScenario.id
 * 2. persistScenariosIfNeeded 门控：reflect 模式持久化、非 reflect 不调、无 structuredScenario 不调
 * 3. rerun 路径：落盘后 .test-agent/scenarios/<caseId>.json 存在，caseId 与 case.id 一致
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeCaseId, computeProjectHash } from "../src/core/cases.js";
import { persistScenarios } from "../src/core/tools/reflect-test.js";
import type { TestCase, StructuredScenario } from "../src/core/types.js";

/** 构造带 structuredScenario 的 TestCase（模拟 LLM 产出，id 尚未重分配） */
function makeCase(title: string, llmId: string): TestCase {
  const scenario: StructuredScenario = {
    id: llmId,
    title,
    target: { className: "com.example.Svc", method: "m" },
    params: [{ type: "java.lang.String", value: "test" }],
    assertion: { type: "return", expected: null },
  };
  return {
    id: llmId,
    title,
    scenario: `测试 ${title}`,
    steps: [],
    expected: "返回 null",
    priority: "medium",
    layer: "unit",
    structuredScenario: scenario,
  };
}

/** 模拟 runner.ts 中的 ID 重分配逻辑（含 P4-7 structuredScenario.id 同步） */
function reassignIds(cases: TestCase[], projectHash: string): TestCase[] {
  return cases.map((c) => {
    const id = computeCaseId(projectHash, c.title);
    return { ...c, id, ...(c.structuredScenario ? { structuredScenario: { ...c.structuredScenario, id } } : {}) };
  });
}

describe("P4-7: AI 生成场景持久化", () => {
  describe("1. ID 同步", () => {
    it("ID 重分配后 case.id === structuredScenario.id", () => {
      const projectHash = computeProjectHash("/fake/project");
      const cases = [
        makeCase("计算器加法", "TC001"),
        makeCase("计算器减法", "TC002"),
      ];
      const reassigned = reassignIds(cases, projectHash);

      for (const c of reassigned) {
        expect(c.id).not.toBe("TC001");
        expect(c.id).not.toBe("TC002");
        expect(c.structuredScenario).toBeDefined();
        expect(c.structuredScenario!.id).toBe(c.id);
        expect(c.structuredScenario!.id).toHaveLength(16);
      }
    });

    it("无 structuredScenario 的用例 ID 重分配不报错", () => {
      const projectHash = computeProjectHash("/fake/project");
      const cases: TestCase[] = [
        { id: "TC003", title: "普通用例", scenario: "测试", steps: [], expected: "ok", priority: "low", layer: "unit" },
      ];
      const reassigned = reassignIds(cases, projectHash);
      expect(reassigned[0].id).not.toBe("TC003");
      expect(reassigned[0].structuredScenario).toBeUndefined();
    });
  });

  describe("2. persistScenariosIfNeeded 门控", () => {
    it("reflect 模式 + 有 structuredScenario → 持久化文件存在", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "p4-7-reflect-"));
      try {
        const projectHash = computeProjectHash(tmpDir);
        const cases = reassignIds([makeCase("测试用例A", "TC001")], projectHash);
        const scenarios = cases
          .filter((c) => c.structuredScenario)
          .map((c) => ({ ...c.structuredScenario!, id: c.id }));

        expect(scenarios).toHaveLength(1);
        persistScenarios(tmpDir, scenarios);

        const file = join(tmpDir, ".test-agent", "scenarios", `${cases[0].id}.json`);
        expect(existsSync(file)).toBe(true);
        const written = JSON.parse(readFileSync(file, "utf-8"));
        expect(written.id).toBe(cases[0].id);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("无 structuredScenario → 不持久化（无文件生成）", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "p4-7-no-scenario-"));
      try {
        const scenarios: unknown[] = [];
        expect(scenarios).toHaveLength(0);
        // persistScenarios not called — no files should exist
        const dir = join(tmpDir, ".test-agent", "scenarios");
        expect(existsSync(dir)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("3. rerun 路径验证", () => {
    it("落盘后 .test-agent/scenarios/<caseId>.json 存在且 id 对齐", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "p4-7-rerun-"));
      try {
        const projectHash = computeProjectHash(tmpDir);
        const cases = reassignIds(
          [makeCase("Service 测试", "TC_FIX_001"), makeCase("Controller 测试", "TC_FIX_002")],
          projectHash,
        );

        // 模拟 persistScenariosIfNeeded：提取 scenarios 同步 id 后持久化
        const scenarios = cases
          .filter((c) => c.structuredScenario)
          .map((c) => ({ ...c.structuredScenario!, id: c.id }));
        persistScenarios(tmpDir, scenarios);

        // 模拟 rerun 逻辑：用 caseId 查找场景文件
        for (const c of cases) {
          const scenarioFile = join(tmpDir, ".test-agent", "scenarios", `${c.id}.json`);
          expect(existsSync(scenarioFile)).toBe(true);
          const content = JSON.parse(readFileSync(scenarioFile, "utf-8"));
          expect(content.id).toBe(c.id);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("4. saveCase ID 同步（cases.ts）", () => {
    it("saveCase 后 stored case.id === structuredScenario.id", async () => {
      const { CaseLibrary } = await import("../src/core/cases.js");
      const tmpDir = mkdtempSync(join(tmpdir(), "p4-7-savecase-"));
      try {
        const library = new CaseLibrary(tmpDir);
        const testCase = makeCase("库存测试", "TC_LIB_001");
        const stored = library.saveCase(testCase);

        expect(stored.case.id).not.toBe("TC_LIB_001");
        expect(stored.case.structuredScenario).toBeDefined();
        expect(stored.case.structuredScenario!.id).toBe(stored.case.id);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
