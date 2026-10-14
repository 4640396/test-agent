import { describe, expect, it } from "vitest";
import {
  getScenario,
  listScenarios,
  KNOWN_TOOL_NAMES,
  type ScenarioConfig,
} from "../src/core/scenarios.js";

describe("scenarios", () => {
  describe("getScenario", () => {
    it("returns generate-and-run by default", () => {
      const s = getScenario();
      expect(s.name).toBe("generate-and-run");
      expect(s.tools).toContain("maven_test");
      expect(s.tools).toContain("read");
      expect(s.tools).toContain("write");
      // edit 仅用于修复本轮生成测试的确定性编译错误；生产代码修复仍在后续阶段。
      expect(s.tools).toContain("edit");
    });

    it("returns generate-and-run when name is undefined", () => {
      const s = getScenario(undefined);
      expect(s.name).toBe("generate-and-run");
    });

    it("returns the requested builtin scenario", () => {
      // [deprecated] fix-failures 被 fix-by-diagnosis 替代，此测试验证保留配置仍有效
      const s = getScenario("fix-failures");
      expect(s.name).toBe("fix-failures");
      expect(s.tools).toContain("read");
      expect(s.tools).toContain("edit");
      // fix-failures 含 write（fixer 需建临时文件兼容，照 planner 指示加）
      expect(s.tools).toContain("write");
    });

    it("returns ui-test scenario with only playwright_test + read/write", () => {
      const s = getScenario("ui-test");
      expect(s.name).toBe("ui-test");
      expect(s.tools).toEqual(["playwright_test", "read", "write"]);
    });

    it("returns api-test scenario with only api_test + read/write", () => {
      const s = getScenario("api-test");
      expect(s.name).toBe("api-test");
      expect(s.tools).toEqual(["api_test", "read", "write"]);
    });

    it("returns unit-test scenario with test tools plus test-authoring read/write/edit", () => {
      const s = getScenario("unit-test");
      expect(s.name).toBe("unit-test");
      expect(s.tools).toEqual(["maven_test", "node_test", "read", "write", "edit"]);
    });

    it("returns reflect-test scenario with only reflect_test + read (no write)", () => {
      const s = getScenario("reflect-test");
      expect(s.name).toBe("reflect-test");
      expect(s.tools).toEqual(["reflect_test", "read"]);
      // reflect-test 不提供 write：LLM 只生成 JSON 场景不写 Java 代码
      expect(s.tools).not.toContain("write");
      expect(s.tools).not.toContain("maven_test");
    });

    it("falls back to generate-and-run for unknown scenario", () => {
      const s = getScenario("non-existent");
      expect(s.name).toBe("generate-and-run");
    });

    it("returns custom scenario when provided", () => {
      const custom: ScenarioConfig = {
        name: "custom-smoke",
        description: "自定义冒烟测试",
        systemPrompt: "冒烟测试 prompt",
        tools: ["node_test", "read"],
      };
      const s = getScenario("custom-smoke", { "custom-smoke": custom });
      expect(s.name).toBe("custom-smoke");
      expect(s.systemPrompt).toBe("冒烟测试 prompt");
      expect(s.tools).toEqual(["node_test", "read"]);
    });

    it("custom scenario overrides builtin with same name", () => {
      const custom: ScenarioConfig = {
        name: "generate-and-run",
        description: "覆盖默认",
        systemPrompt: "自定义 prompt",
        tools: ["node_test", "read"],
      };
      const s = getScenario("generate-and-run", { "generate-and-run": custom });
      expect(s.description).toBe("覆盖默认");
      expect(s.tools).toEqual(["node_test", "read"]);
    });

    it("filters out unknown tools from custom scenario", () => {
      const custom: ScenarioConfig = {
        name: "bad-tools",
        description: "含未知工具",
        systemPrompt: "prompt",
        tools: ["node_test", "unknown_tool", "also_unknown"],
      };
      const s = getScenario("bad-tools", { "bad-tools": custom });
      expect(s.tools).toEqual(["node_test"]);
    });

    it("falls back to all tools when custom scenario has no valid tools", () => {
      const custom: ScenarioConfig = {
        name: "empty-tools",
        description: "无有效工具",
        systemPrompt: "prompt",
        tools: ["unknown_tool"],
      };
      const s = getScenario("empty-tools", { "empty-tools": custom });
      // 无有效工具 → 回退到全量工具
      expect(s.tools.length).toBeGreaterThan(3);
      expect(s.tools).toContain("maven_test");
      expect(s.tools).toContain("read");
    });
  });

  describe("listScenarios", () => {
    it("lists all builtin scenarios", () => {
      const list = listScenarios();
      const names = list.map((s) => s.name);
      expect(names).toContain("generate-and-run");
      expect(names).toContain("fix-failures");
      expect(names).toContain("ui-test");
      expect(names).toContain("api-test");
      expect(names).toContain("reflect-test");
    });

    it("merges custom scenarios with builtin", () => {
      const custom: ScenarioConfig = {
        name: "extra-scenario",
        description: "额外",
        systemPrompt: "p",
        tools: ["read"],
      };
      const list = listScenarios({ "extra-scenario": custom });
      const names = list.map((s) => s.name);
      expect(names).toContain("generate-and-run");
      expect(names).toContain("extra-scenario");
    });
  });

  describe("KNOWN_TOOL_NAMES", () => {
    it("contains all test tool names", () => {
      expect(KNOWN_TOOL_NAMES.has("maven_test")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("node_test")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("playwright_test")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("api_test")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("reflect_test")).toBe(true);
    });

    it("contains all general tool names", () => {
      expect(KNOWN_TOOL_NAMES.has("read")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("write")).toBe(true);
      expect(KNOWN_TOOL_NAMES.has("edit")).toBe(true);
    });

    it("does not contain bash", () => {
      expect(KNOWN_TOOL_NAMES.has("bash")).toBe(false);
    });
  });
});
