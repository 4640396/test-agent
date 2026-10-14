/**
 * P2-3 case-designer 结构化输出单测。
 *
 * 测 parseCasesFromResponse 提取 structuredScenario + buildExecutionPrompt reflect 模式注入。
 * 不真跑 LLM/maven——纯函数级单测。
 */

import { describe, expect, it } from "vitest";
import type { Message, TextContent } from "@cxmt/ai";
import { parseCasesFromResponse, buildExecutionPrompt, linkCaseResultsToPlan } from "../src/core/runner.js";
import type { TaskInput, TestCase } from "../src/core/types.js";

function makeAssistantMessage(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text } as TextContent],
  } as Message;
}

const baseInput: TaskInput = {
  projectPath: "/test/project",
  systemName: "test-system",
  version: "1.0",
  testTypes: ["unit"],
  testStrategy: "junit",
};

const structuredScenario = {
  id: "TC001",
  target: {
    className: "com.cxmt.order.service.OrderService",
    method: "calculateAmount",
  },
  setup: { springContext: false },
  params: [
    { name: "request", type: "com.cxmt.order.dto.OrderRequest", value: { qty: 2, price: 80 } },
  ],
  assertion: {
    type: "return" as const,
    expected: 160,
    expectedType: "java.math.BigDecimal",
  },
};

describe("P2-3 parseCasesFromResponse", () => {
  it("extracts structuredScenario from LLM JSON output", () => {
    const json = JSON.stringify([
      {
        id: "TC001",
        title: "订单金额计算-正常折扣",
        scenario: "2件商品80元打8折",
        steps: ["调 calculateAmount"],
        expected: "160.00",
        priority: "high",
        layer: "unit",
        target: "src/OrderService.java:15",
        structuredScenario,
      },
    ]);
    const msg = makeAssistantMessage("```json\n" + json + "\n```");
    const cases = parseCasesFromResponse([msg]);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("TC001");
    expect(cases[0].structuredScenario).toBeDefined();
    expect(cases[0].structuredScenario?.target.className).toBe("com.cxmt.order.service.OrderService");
    expect(cases[0].structuredScenario?.target.method).toBe("calculateAmount");
    expect(cases[0].structuredScenario?.assertion.type).toBe("return");
    expect(cases[0].structuredScenario?.assertion.expected).toBe(160);
  });

  it("does not break when structuredScenario is absent (junit mode)", () => {
    const json = JSON.stringify([
      {
        id: "TC002",
        title: "普通测试",
        scenario: "测试加法",
        steps: [],
        expected: "3",
        priority: "medium",
        layer: "unit",
        target: "src/Calc.java:10",
      },
    ]);
    const msg = makeAssistantMessage("```json\n" + json + "\n```");
    const cases = parseCasesFromResponse([msg]);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("TC002");
    expect(cases[0].structuredScenario).toBeUndefined();
    expect(cases[0].title).toBe("普通测试");
  });

  it("skips structuredScenario when not an object (string)", () => {
    const json = JSON.stringify([
      {
        id: "TC003",
        title: "错误场景",
        scenario: "测试",
        steps: [],
        expected: "ok",
        priority: "medium",
        layer: "unit",
        structuredScenario: "not-an-object",
      },
    ]);
    const msg = makeAssistantMessage("```json\n" + json + "\n```");
    const cases = parseCasesFromResponse([msg]);
    expect(cases).toHaveLength(1);
    expect(cases[0].structuredScenario).toBeUndefined();
    expect(cases[0].title).toBe("错误场景");
  });

  it("repairs bare quotes inside a fenced JSON string and ignores trailing prose", () => {
    const msg = makeAssistantMessage(`设计完成：
\`\`\`json
[
  {
    "id": "TC048",
    "title": "微信报文字段缺失",
    "scenario": "最小报文",
    "steps": ["POST 最小 XML"],
    "expected": "handle 以(\\"\\", "空eventKey)被调用且不抛异常",
    "priority": "high",
    "layer": "api"
  }
]
\`\`\`
设计说明：以上用例已经核实。`);

    const cases = parseCasesFromResponse([msg]);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("TC048");
    expect(cases[0].expected).toContain('"空eventKey');
  });
});

describe("P2-3 buildExecutionPrompt", () => {
  const casesWithScenario: TestCase[] = [
    {
      id: "TC001",
      title: "订单金额计算",
      scenario: "2件80元打8折",
      steps: [],
      expected: "160",
      priority: "high",
      layer: "unit",
      target: "src/OrderService.java:15",
      structuredScenario,
    },
  ];

  it("injects structuredScenario JSON in reflect mode", () => {
    const input: TaskInput = { ...baseInput, testStrategy: "reflect" };
    const prompt = buildExecutionPrompt(input, casesWithScenario);
    expect(prompt).toContain("场景 JSON:");
    expect(prompt).toContain("reflect_test");
    expect(prompt).toContain("不写 Java 测试代码");
    expect(prompt).toContain("com.cxmt.order.service.OrderService");
  });

  it("replaces execution steps in reflect mode", () => {
    const input: TaskInput = { ...baseInput, testStrategy: "reflect" };
    const prompt = buildExecutionPrompt(input, casesWithScenario);
    expect(prompt).toContain("用 reflect_test 工具执行");
    expect(prompt).toContain("不用 write 创建测试文件");
    expect(prompt).toContain("不用 maven_test");
    // Should NOT contain junit mode execution step (reflect has different step 3)
    expect(prompt).not.toContain("3. 用 write 创建测试文件");
    expect(prompt).not.toContain("maven_test/node_test/playwright_test/api_test");
  });

  it("preserves junit mode unchanged (no reflect injection)", () => {
    const input: TaskInput = { ...baseInput, testStrategy: "junit" };
    const prompt = buildExecutionPrompt(input, casesWithScenario);
    expect(prompt).toContain("用 write 创建测试文件");
    expect(prompt).toContain("maven_test/node_test/playwright_test/api_test");
    expect(prompt).not.toContain("场景 JSON:");
    expect(prompt).not.toContain("reflect_test");
  });

  it("preserves junit mode when testStrategy is undefined", () => {
    const input: TaskInput = { ...baseInput, testStrategy: undefined };
    const prompt = buildExecutionPrompt(input, casesWithScenario);
    expect(prompt).toContain("用 write 创建测试文件");
    expect(prompt).not.toContain("场景 JSON:");
  });

  it("requires stable case IDs in generated test names", () => {
    const prompt = buildExecutionPrompt(baseInput, casesWithScenario);
    expect(prompt).toContain('@DisplayName("[CASE:<用例ID>] 用例标题")');
    expect(prompt).toContain("case_<用例ID>_");
  });
});

describe("plan case evidence linking", () => {
  const cases: TestCase[] = [{
    id: "0535f6cbfc9fb4b9",
    title: "同步成功",
    scenario: "正常同步",
    steps: [],
    expected: "SUCCESS",
    priority: "high",
    layer: "unit",
  }];

  it("links explicit display-name and method-name IDs", () => {
    const linked = linkCaseResultsToPlan(cases, [
      { caseId: "[CASE:0535f6cbfc9fb4b9] 同步成功", status: "passed", evidence: "xml-1" },
      { caseId: "case_0535f6cbfc9fb4b9_sync", status: "failed", evidence: "xml-2" },
    ]);
    expect(linked.map(item => item.caseId)).toEqual(["0535f6cbfc9fb4b9", "0535f6cbfc9fb4b9"]);
  });

  it("links parameterized dataset rows back to the stable plan ID", () => {
    expect(linkCaseResultsToPlan(cases, [
      { caseId: "0535f6cbfc9fb4b9#0", status: "passed", evidence: "HTTP 200" },
      { caseId: "0535f6cbfc9fb4b9#1", status: "failed", evidence: "HTTP 500" },
    ]).map(item => item.caseId)).toEqual(["0535f6cbfc9fb4b9", "0535f6cbfc9fb4b9"]);
  });

  it("does not infer evidence from a matching title", () => {
    expect(linkCaseResultsToPlan(cases, [
      { caseId: "同步成功", status: "passed", evidence: "xml" },
    ])).toEqual([]);
  });
});
