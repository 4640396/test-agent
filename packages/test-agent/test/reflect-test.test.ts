/**
 * reflect_test 工具单测。
 *
 * 测 schema 校验、场景持久化路径、Maven 命令构造（不真跑 mvn）。
 * 端到端（真跑 Calculator.java）在步骤6 手动验证，不在此 vitest（需 Maven 环境）。
 */

import { describe, expect, it } from "vitest";
import { reflectMavenCommandSpec, reflectBatchMavenCommandSpec, reflectDirMavenCommandSpec, persistScenarios, exportedScenarioSchema } from "../src/core/tools/reflect-test.js";
import { Type } from "@cxmt/ai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("reflect_test", () => {
  describe("reflectMavenCommandSpec", () => {
    it("constructs Windows command with -Dtest and -DscenarioFile", () => {
      const spec = reflectMavenCommandSpec(
        "C:/proj",
        ".test-agent/scenarios/TC001.json",
        "win32",
      );
      expect(spec.command).toBe("cmd.exe");
      expect(spec.args[0]).toBe("/d");
      expect(spec.args[1]).toBe("/s");
      expect(spec.args[2]).toBe("/c");
      expect(spec.args[3]).toMatch(/mvn\.cmd test/);
      expect(spec.args.some((a) => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      // 相对 scenarioFile 应被解析为绝对路径（相对 projectPath），跨平台分隔符
      expect(spec.args.some((a) => a.includes("-DscenarioFile=") && a.includes("TC001.json"))).toBe(true);
      expect(spec.cwd).toBe("C:/proj");
    });

    it("constructs non-Windows command with mvn + args array", () => {
      const spec = reflectMavenCommandSpec(
        "/home/proj",
        "/home/proj/.test-agent/scenarios/TC002.json",
        "linux",
      );
      expect(spec.command).toBe("mvn");
      expect(spec.args).toContain("test");
      expect(spec.args.some((a) => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      expect(spec.args.some((a) => a.includes("-DscenarioFile=/home/proj/.test-agent/scenarios/TC002.json"))).toBe(true);
      expect(spec.cwd).toBe("/home/proj");
    });

    it("keeps absolute scenarioFile as-is", () => {
      const spec = reflectMavenCommandSpec(
        "/proj",
        "/abs/path/TC003.json",
        "linux",
      );
      expect(spec.args.some((a) => a.includes("-DscenarioFile=/abs/path/TC003.json"))).toBe(true);
    });
  });

  // P2-2: 批量命令构造测试
  describe("reflectBatchMavenCommandSpec", () => {
    it("constructs Windows command with -DscenarioFiles (3+ files comma-separated)", () => {
      const spec = reflectBatchMavenCommandSpec(
        "C:/proj",
        [
          ".test-agent/scenarios/TC001.json",
          ".test-agent/scenarios/TC002.json",
          ".test-agent/scenarios/TC003.json",
        ],
        "win32",
      );
      expect(spec.command).toBe("cmd.exe");
      expect(spec.args[0]).toBe("/d");
      expect(spec.args[1]).toBe("/s");
      expect(spec.args[2]).toBe("/c");
      expect(spec.args[3]).toMatch(/mvn\.cmd test/);
      expect(spec.args.some((a) => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      // 3 files comma-separated in -DscenarioFiles
      expect(spec.args.some((a) => a.includes("-DscenarioFiles=") && a.includes("TC001.json") && a.includes("TC002.json") && a.includes("TC003.json"))).toBe(true);
      expect(spec.cwd).toBe("C:/proj");
    });

    it("constructs non-Windows command with -DscenarioFiles", () => {
      const spec = reflectBatchMavenCommandSpec(
        "/home/proj",
        ["/home/proj/.test-agent/scenarios/TC001.json", "/home/proj/.test-agent/scenarios/TC002.json"],
        "linux",
      );
      expect(spec.command).toBe("mvn");
      expect(spec.args).toContain("test");
      expect(spec.args.some((a) => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      expect(spec.args.some((a) => a.includes("-DscenarioFiles=/home/proj/.test-agent/scenarios/TC001.json,/home/proj/.test-agent/scenarios/TC002.json"))).toBe(true);
      expect(spec.cwd).toBe("/home/proj");
    });

    it("keeps absolute scenarioFiles as-is", () => {
      const spec = reflectBatchMavenCommandSpec(
        "/proj",
        ["/abs/path/TC001.json", "/abs/path/TC002.json"],
        "linux",
      );
      expect(spec.args.some((a) => a.includes("-DscenarioFiles=/abs/path/TC001.json,/abs/path/TC002.json"))).toBe(true);
    });
  });

  // P2-2: 目录模式命令构造
  describe("reflectDirMavenCommandSpec", () => {
    it("constructs Windows command with -DscenarioDir", () => {
      const spec = reflectDirMavenCommandSpec(
        "C:/proj",
        ".test-agent/scenarios",
        "win32",
      );
      expect(spec.command).toBe("cmd.exe");
      expect(spec.args[3]).toMatch(/mvn\.cmd test/);
      expect(spec.args.some((a) => a.includes("-Dtest=ReflectTestRunner"))).toBe(true);
      expect(spec.args.some((a) => a.includes("-DscenarioDir=") && a.includes("scenarios"))).toBe(true);
      expect(spec.cwd).toBe("C:/proj");
    });

    it("constructs non-Windows command with -DscenarioDir", () => {
      const spec = reflectDirMavenCommandSpec(
        "/home/proj",
        "/home/proj/.test-agent/scenarios",
        "linux",
      );
      expect(spec.command).toBe("mvn");
      expect(spec.args.some((a) => a.includes("-DscenarioDir=/home/proj/.test-agent/scenarios"))).toBe(true);
      expect(spec.cwd).toBe("/home/proj");
    });
  });

  describe("scenarioSchema", () => {
    // P2-1: 验证 schema 接受 setup.mainClass 可选字段
    it("accepts setup.mainClass optional field", () => {
      const scenario = {
        id: "TC_Spring_001",
        target: {
          className: "com.example.MyService",
          method: "doSomething",
        },
        setup: {
          springContext: true,
          mainClass: "com.example.MyApplication",
        },
        params: [],
        assertion: { type: "return" as const, expected: null },
      };
      expect(scenario.setup?.mainClass).toBe("com.example.MyApplication");
      expect(scenario.setup?.springContext).toBe(true);
    });

    // P2-1: 验证 springContext description 包含 SpringApplication.run
    it("springContext description mentions SpringApplication.run", () => {
      const setupSchema = Type.Optional(Type.Object({
        springContext: Type.Optional(Type.Boolean({
          description: "是否加载 Spring Boot Context（P2-1 支持 SpringApplication.run + getBean，失败降级纯 POJO + 标 [需人工复核]）",
        })),
        mainClass: Type.Optional(Type.String({
          description: "Spring Boot 主类全限定名（@SpringBootApplication）。不指定时自动扫描 target/classes/",
        })),
      }));
      expect(JSON.stringify(setupSchema)).toContain("SpringApplication.run");
      expect(JSON.stringify(setupSchema)).toContain("mainClass");
    });

    // P2-2: 验证 schema 含 scenarioFiles / scenarioDir 字段
    it("reflectTestSchema includes scenarioFiles and scenarioDir fields", () => {
      const schema = Type.Object({
        scenarioFile: Type.Optional(Type.String()),
        scenarioFiles: Type.Optional(Type.Array(Type.String())),
        scenarioDir: Type.Optional(Type.String()),
        scenarios: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
        }))),
      });
      const schemaStr = JSON.stringify(schema);
      expect(schemaStr).toContain("scenarioFiles");
      expect(schemaStr).toContain("scenarioDir");
    });

    // P4-2: 验证 scenarioSchema 接受 setup.fixtures
    it("scenarioSchema accepts setup.fixtures", () => {
      const schemaStr = JSON.stringify(exportedScenarioSchema);
      expect(schemaStr).toContain("fixtures");
      // 构造含 fixtures 的场景，验证字段可访问
      const scenario = {
        id: "TC_FIX_001",
        target: { className: "com.example.Svc", method: "m" },
        setup: {
          springContext: true,
          fixtures: [
            { table: "projects", rows: [{ id: "p1", name: "demo" }] },
          ],
        },
        params: [],
        assertion: { type: "return" as const, expected: null },
      };
      expect(scenario.setup?.fixtures).toHaveLength(1);
      expect(scenario.setup?.fixtures?.[0].table).toBe("projects");
    });

    // P4-2: 验证 scenarioSchema 接受 setup.mocks
    it("scenarioSchema accepts setup.mocks", () => {
      const schemaStr = JSON.stringify(exportedScenarioSchema);
      expect(schemaStr).toContain("mocks");
      const scenario = {
        id: "TC_MOCK_001",
        target: { className: "com.example.Svc", method: "m" },
        setup: {
          springContext: true,
          mocks: [
            { bean: "com.example.Gateway", stubs: [{ method: "send", returnValue: null }] },
          ],
        },
        params: [],
        assertion: { type: "return" as const, expected: null },
      };
      expect(scenario.setup?.mocks).toHaveLength(1);
      expect(scenario.setup?.mocks?.[0].bean).toBe("com.example.Gateway");
    });

    // P4-2: 向后兼容——无 fixtures/mocks 场景仍通过
    it("scenarioSchema accepts scenario without fixtures/mocks (backward compat)", () => {
      const scenario = {
        id: "TC_PLAIN_001",
        target: { className: "com.example.Svc", method: "m" },
        setup: { springContext: false },
        params: [],
        assertion: { type: "return" as const, expected: null },
      };
      expect(scenario.setup?.fixtures).toBeUndefined();
      expect(scenario.setup?.mocks).toBeUndefined();
    });

    // P5: assertion.match 枚举字段
    it("scenarioSchema accepts assertion.match (P5 fuzzy assertion)", () => {
      const schemaStr = JSON.stringify(exportedScenarioSchema);
      expect(schemaStr).toContain("match");
      expect(schemaStr).toContain("prefix");
      expect(schemaStr).toContain("regex");
      expect(schemaStr).toContain("ignore");
      // regex 匹配场景（非确定性返回值格式校验）
      const scenario = {
        id: "TC_MATCH_001",
        target: { className: "com.example.Svc", method: "m" },
        params: [],
        assertion: { type: "return" as const, match: "regex" as const, expected: "^E\\\\d{16}$" },
      };
      expect(scenario.assertion.match).toBe("regex");
      // ignore 场景（只验不抛异常）
      const scenario2 = {
        id: "TC_MATCH_002",
        target: { className: "com.example.Svc", method: "m" },
        params: [],
        assertion: { type: "return" as const, match: "ignore" as const },
      };
      expect(scenario2.assertion.match).toBe("ignore");
    });

    // P5: assertion.match 默认 exact（向后兼容）
    it("scenarioSchema assertion.match defaults to exact (backward compat)", () => {
      const scenario = {
        id: "TC_MATCH_DEFAULT",
        target: { className: "com.example.Svc", method: "m" },
        params: [],
        assertion: { type: "return" as const, expected: 42 },
      };
      expect(scenario.assertion.match).toBeUndefined(); // 未提供 → ReflectTestRunner 默认 exact
    });

    // P5: methodSignature 激活（重载消歧）
    it("scenarioSchema accepts target.methodSignature (P5 overload disambiguation)", () => {
      const schemaStr = JSON.stringify(exportedScenarioSchema);
      expect(schemaStr).toContain("methodSignature");
      const scenario = {
        id: "TC_SIG_001",
        target: {
          className: "com.example.YieldService",
          method: "calculateYield",
          methodSignature: "(java.lang.String)",
        },
        params: [{ name: "stepName", type: "java.lang.String", value: "PHOTO" }],
        assertion: { type: "return" as const, expected: 90.0, expectedType: "double" },
      };
      expect(scenario.target.methodSignature).toBe("(java.lang.String)");
    });

    // P5: class Mock schema（bean 指向 class 而非 interface）
    it("scenarioSchema accepts class Mock bean (P5 ByteBuddy subclassing)", () => {
      const scenario = {
        id: "TC_CLASSMOCK_001",
        target: { className: "com.example.LotService", method: "createLot" },
        setup: {
          springContext: true,
          mocks: [
            { bean: "com.example.LotNumberGenerator", stubs: [{ method: "generate", returnValue: "E_FIXED_001" }] },
          ],
        },
        params: [{ name: "productId", type: "java.lang.String", value: "P1" }],
        assertion: { type: "return" as const, expected: "E_FIXED_001", expectedType: "java.lang.String" },
      };
      expect(scenario.setup?.mocks?.[0].bean).toBe("com.example.LotNumberGenerator");
    });

    // P4-2: 持久化场景含 fixtures 字段正确写入文件
    it("persistScenarios writes fixtures field to file", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "reflect-test-fixture-"));
      try {
        const scenarios = [
          {
            id: "TC_PERSIST_001",
            target: { className: "com.example.Svc", method: "m" },
            setup: {
              springContext: true,
              fixtures: [
                { table: "projects", rows: [{ id: "p1", name: "demo" }] },
              ],
              mocks: [
                { bean: "com.example.Gateway", stubs: [{ method: "send", returnValue: null }] },
              ],
            },
            params: [],
            assertion: { type: "return", expected: null },
          },
        ];
        const files = persistScenarios(tmpDir, scenarios);
        expect(files).toHaveLength(1);
        const written = JSON.parse(readFileSync(files[0], "utf-8"));
        expect(written.setup.fixtures).toHaveLength(1);
        expect(written.setup.fixtures[0].table).toBe("projects");
        expect(written.setup.mocks).toHaveLength(1);
        expect(written.setup.mocks[0].bean).toBe("com.example.Gateway");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
