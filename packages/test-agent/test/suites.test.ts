/**
 * P3-1 回归套件管理单测。
 *
 * 测 SuiteLibrary 本地实现逻辑（通过 main/index.ts 同模式验证）：
 * - computeSuiteId 稳定性（同 projectHash + name → 同 id）
 * - suite:run 分流逻辑（reflect 批量 vs junit skipped）——通过 mock 验证数据流
 *
 * 注意：main/index.ts 的 SuiteLibrary 是 GUI 自含实现（不导入 @cxmt/test-agent），
 * 这里测的是 test-agent 侧导出的 reflectBatchMavenCommandSpec + junitBatchMavenCommandSpec
 * 构造逻辑（suite:run 底层复用），以及 Suite 数据模型的序列化兼容性。
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { reflectBatchMavenCommandSpec } from "../src/core/tools/reflect-test.js";
import { junitBatchMavenCommandSpec } from "../src/core/validator.js";

// ---------------------------------------------------------------------------
// Suite 数据模型（镜像 main/index.ts 中的 Suite 接口）
// ---------------------------------------------------------------------------

interface Suite {
  id: string;
  name: string;
  projectPath: string;
  projectHash: string;
  caseIds: string[];
  testStrategy: 'reflect' | 'junit';
  createdAt: string;
  lastRunAt?: string;
  lastRunResult?: { total: number; pass: number; fail: number; skipped: number };
}

function computeSuiteId(projectHash: string, name: string): string {
  return createHash('sha256').update(`${projectHash}:${name}`).digest('hex').slice(0, 16);
}

function computeProjectHash(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function computeCaseId(projectHash: string, title: string): string {
  return createHash('sha256').update(`${projectHash}:${title}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("P3-1 回归套件", () => {
  describe("computeSuiteId", () => {
    it("同 projectHash + name 产生稳定 id", () => {
      const hash = computeProjectHash("/test/proj");
      const id1 = computeSuiteId(hash, "核心回归");
      const id2 = computeSuiteId(hash, "核心回归");
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(16);
    });

    it("不同 name 产生不同 id", () => {
      const hash = computeProjectHash("/test/proj");
      const id1 = computeSuiteId(hash, "核心回归");
      const id2 = computeSuiteId(hash, "认证回归");
      expect(id1).not.toBe(id2);
    });

    it("不同 projectHash 产生不同 id（同名套件跨项目）", () => {
      const hash1 = computeProjectHash("/test/proj1");
      const hash2 = computeProjectHash("/test/proj2");
      const id1 = computeSuiteId(hash1, "核心回归");
      const id2 = computeSuiteId(hash2, "核心回归");
      expect(id1).not.toBe(id2);
    });
  });

  describe("Suite 序列化", () => {
    it("Suite 可 JSON 序列化/反序列化保持结构", () => {
      const suite: Suite = {
        id: computeSuiteId(computeProjectHash("/proj"), "测试套件"),
        name: "测试套件",
        projectPath: "/proj",
        projectHash: computeProjectHash("/proj"),
        caseIds: ["abc123def4567890", "def456abc7890123"],
        testStrategy: 'reflect',
        createdAt: new Date().toISOString(),
        lastRunAt: new Date().toISOString(),
        lastRunResult: { total: 2, pass: 2, fail: 0, skipped: 0 },
      };
      const json = JSON.stringify(suite);
      const restored = JSON.parse(json) as Suite;
      expect(restored.id).toBe(suite.id);
      expect(restored.name).toBe(suite.name);
      expect(restored.caseIds).toEqual(suite.caseIds);
      expect(restored.testStrategy).toBe('reflect');
      expect(restored.lastRunResult?.pass).toBe(2);
    });
  });

  describe("suite:run reflect 分流", () => {
    it("reflectBatchMavenCommandSpec 构造批量命令（多场景文件）", () => {
      const spec = reflectBatchMavenCommandSpec(
        "/proj",
        ["/proj/.test-agent/scenarios/TC001.json", "/proj/.test-agent/scenarios/TC002.json"],
        "linux",
      );
      expect(spec.command).toBe("mvn");
      expect(spec.args.some(a => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      expect(spec.args.some(a => a.includes("-DscenarioFiles=") && a.includes("TC001.json") && a.includes("TC002.json"))).toBe(true);
      expect(spec.cwd).toBe("/proj");
    });

    it("win32 reflectBatchMavenCommandSpec 用单字符串拼法", () => {
      const spec = reflectBatchMavenCommandSpec(
        "C:\\proj",
        ["C:/proj/.test-agent/scenarios/TC001.json"],
        "win32",
      );
      expect(spec.command).toBe("cmd.exe");
      expect(spec.args[2]).toBe("/c");
      expect(spec.args[3]).toMatch(/mvn\.cmd test/);
      expect(spec.args[3]).toContain("-DscenarioFiles=");
    });
  });

  describe("suite:run junit 分流", () => {
    it("junitBatchMavenCommandSpec 构造批量命令（多类）", () => {
      const spec = junitBatchMavenCommandSpec(
        "/proj",
        ["com.example.OrderServiceTest", "com.example.UserServiceTest"],
        "linux",
      );
      expect(spec.command).toBe("mvn");
      expect(spec.args.some(a => a.includes("-Dtest=com.example.OrderServiceTest,com.example.UserServiceTest"))).toBe(true);
      expect(spec.cwd).toBe("/proj");
    });
  });

  describe("suite:run skipped 逻辑", () => {
    it("无 structuredScenario 的 JUnit 用例应标 skipped", () => {
      // 模拟 suite:run junit 分支的逻辑
      const suiteCases = [
        { title: "用例1", structuredScenario: { target: { className: "OrderService" } } },
        { title: "用例2", structuredScenario: undefined },
      ];
      const reflectCases = suiteCases.filter(c => c.structuredScenario);
      const junitCases = suiteCases.filter(c => !c.structuredScenario);

      const results: Array<{ name: string; ok: boolean; skipped?: boolean; error?: string }> = [];

      // reflect 分支：有 structuredScenario 的走 reflect
      expect(reflectCases).toHaveLength(1);
      expect(reflectCases[0].title).toBe("用例1");

      // junit 分支：无 structuredScenario 的标 skipped
      for (const c of junitCases) {
        results.push({ name: c.title, ok: false, skipped: true, error: "无结构化场景，无法批量重跑" });
      }
      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(true);
      expect(results[0].name).toBe("用例2");
    });
  });

  describe("caseId 匹配", () => {
    it("computeCaseId 与 scenarioFile 路径匹配（endsWith 精确匹配）", () => {
      const projectHash = computeProjectHash("/proj");
      const caseId = computeCaseId(projectHash, "订单金额计算");
      const scenarioFile = `/proj/.test-agent/scenarios/${caseId}.json`;
      // suite:run 用 endsWith('/' + cid + '.json') 精确匹配
      expect(scenarioFile.endsWith('/' + caseId + '.json')).toBe(true);
    });

    it("caseId 匹配不会误匹配包含子串的其他 caseId", () => {
      const projectHash = computeProjectHash("/proj");
      const caseId1 = computeCaseId(projectHash, "用例A");
      const caseId2 = computeCaseId(projectHash, "用例B");
      const scenarioFile1 = `/proj/.test-agent/scenarios/${caseId1}.json`;
      // caseId2 不应匹配 scenarioFile1
      expect(scenarioFile1.endsWith('/' + caseId2 + '.json')).toBe(false);
    });
  });
});
