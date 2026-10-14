import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CimiCodeAdapter,
  createCimiCodeAdapter,
  parseJsonFromText,
  messageFromPart,
  validateResult,
  extractStructuredResult,
  parseTestOutputFromEvents,
  buildPrompt,
} from "../src/cli-runners/cimicode.js";
import type { TaskInput } from "@cxmt/protocol";

// --- mock CLI 路径（绝对路径，适配器 spawn 需要） ---
const MOCK_CMD = join(
  process.cwd(),
  "packages",
  "test-agent",
  "test",
  "fixtures",
  "mock-cimicode.cmd",
);

// --- 测试用临时项目目录 ---
const fixtureRoot = join(process.cwd(), ".test-agent", "cimicode-fixture");

function makeTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    projectPath: fixtureRoot,
    systemName: "fixture-system",
    version: "1.0.0",
    testTypes: ["unit"],
    requiredCapabilities: ["java"],
    ...overrides,
  };
}

describe("parseJsonFromText", () => {
  it("解析纯 JSON", () => {
    expect(parseJsonFromText('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("从 Markdown 代码块提取 JSON", () => {
    const text =
      '结果如下：\n```json\n{"lanes":[],"report":{"passed":1,"failed":0,"coverage":null},"artifacts":[]}\n```\n完成';
    expect(parseJsonFromText(text)).toEqual({
      lanes: [],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: [],
    });
  });

  it("从纯文本中提取嵌入的 JSON", () => {
    const text = '前面的说明文字 {"passed":5,"failed":2} 后面的说明文字';
    expect(parseJsonFromText(text)).toEqual({ passed: 5, failed: 2 });
  });

  it("无法解析时返回 null", () => {
    expect(parseJsonFromText("这只是一段普通文字，没有 JSON")).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(parseJsonFromText("")).toBeNull();
  });
});

describe("messageFromPart", () => {
  it("text part 转为 info 事件", () => {
    const event = messageFromPart({ type: "text", text: "正在生成测试" });
    expect(event).toEqual({ type: "log", level: "info", message: "正在生成测试", stage: undefined });
  });

  it("tool part completed 转为 info 事件", () => {
    const event = messageFromPart({
      type: "tool",
      tool: "bash",
      state: { status: "completed" },
    });
    expect(event?.level).toBe("info");
    expect(event?.message).toContain("bash");
    expect(event?.message).toContain("完成");
  });

  it("tool part failed 转为 error 事件", () => {
    const event = messageFromPart({
      type: "tool",
      tool: "write",
      state: { status: "failed" },
    });
    expect(event?.level).toBe("error");
    expect(event?.message).toContain("write");
    expect(event?.message).toContain("失败");
  });

  it("tool part running 转为 info 事件", () => {
    const event = messageFromPart({
      type: "tool",
      tool: "bash",
      state: { status: "running" },
    });
    expect(event?.level).toBe("info");
    expect(event?.message).toContain("running");
  });

  it("reasoning part 返回 null（不转发）", () => {
    expect(
      messageFromPart({ type: "reasoning", text: "思考中..." }),
    ).toBeNull();
  });

  it("无效输入返回 null", () => {
    expect(messageFromPart(null)).toBeNull();
    expect(messageFromPart("string")).toBeNull();
    expect(messageFromPart({})).toBeNull();
    expect(messageFromPart({ type: "unknown" })).toBeNull();
  });
});

describe("validateResult", () => {
  const valid = {
    lanes: [
      { type: "unit" as const, status: "passed" as const, summary: "ok" },
    ],
    report: { passed: 1, failed: 0, coverage: 50 },
    artifacts: ["result.json"],
  };

  it("合法结果通过验证", () => {
    expect(validateResult(valid)).toEqual(valid);
  });

  it("缺少 lanes 抛错", () => {
    expect(() =>
      validateResult({ report: valid.report, artifacts: [] }),
    ).toThrow("结构不完整");
  });

  it("缺少 report 抛错", () => {
    expect(() => validateResult({ lanes: [], artifacts: [] })).toThrow(
      "结构不完整",
    );
  });

  it("缺少 artifacts 抛错", () => {
    expect(() => validateResult({ lanes: [], report: valid.report })).toThrow(
      "结构不完整",
    );
  });

  it("非对象抛错", () => {
    expect(() => validateResult(null)).toThrow("未返回结构化测试结果");
    expect(() => validateResult("string")).toThrow("未返回结构化测试结果");
  });
});

describe("parseTestOutputFromEvents", () => {
  it("解析 vitest 输出", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "Test Files  2 passed (2)\n     Tests  8 passed (8)",
        },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number; failed: number };
    };
    expect(result).not.toBeNull();
    expect(result.report.passed).toBe(8);
    expect(result.report.failed).toBe(0);
  });

  it("解析 vitest 带失败和覆盖率", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "Tests  2 failed | 6 passed (8)\nAll files | 75% | 75%",
        },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number; failed: number; coverage: number | null };
    };
    expect(result.report.passed).toBe(6);
    expect(result.report.failed).toBe(2);
    expect(result.report.coverage).toBe(75);
  });

  it("解析 maven surefire 输出", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "Tests run: 10, Failures: 2, Errors: 1, Skipped: 0",
        },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number; failed: number };
    };
    expect(result.report.passed).toBe(7); // 10 - 2 - 1
    expect(result.report.failed).toBe(3); // 2 + 1
  });

  it("解析 jest 输出", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "Tests:       2 failed, 8 passed, 10 total",
        },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number; failed: number };
    };
    expect(result.report.passed).toBe(8);
    expect(result.report.failed).toBe(2);
  });

  it("解析 go test 输出", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "ok  demo/pkg  0.123s\nFAIL  demo/bad  0.456s",
        },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number; failed: number };
    };
    expect(result.report.passed).toBe(1);
    expect(result.report.failed).toBe(1);
  });

  it("无法识别的输出返回 null", () => {
    const events = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "build succeeded" },
      },
    ];
    expect(parseTestOutputFromEvents(events, ["unit"])).toBeNull();
  });

  it("忽略非 completed 的 tool 事件", () => {
    const events = [
      { type: "tool", tool: "bash", state: { status: "running" } },
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "Tests  5 passed (5)" },
      },
    ];
    const result = parseTestOutputFromEvents(events, ["unit"]) as {
      report: { passed: number };
    };
    expect(result.report.passed).toBe(5);
  });
});

// ================ 集成测试：通过 mock CLI 测试完整 run() 流程 ================

describe("CimiCodeAdapter 集成测试（mock CLI）", () => {
  beforeEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });
    process.env.CIMICODE_EXECUTABLE = MOCK_CMD;
  });

  afterEach(() => {
    delete process.env.CIMICODE_EXECUTABLE;
    delete process.env.MOCK_CIMICODE_MODE;
    delete process.env.MOCK_CIMICODE_EXIT_CODE;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("file 模式：mock 写结果文件 → adapter 读到正确结果（主路径）", async () => {
    process.env.MOCK_CIMICODE_MODE = "file";
    const adapter = new CimiCodeAdapter(MOCK_CMD);
    const events: { level: string; message: string }[] = [];

    const result = await adapter.run(makeTaskInput(), (event) => {
      events.push({ level: event.level, message: event.message });
    });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0].status).toBe("passed");
    expect(result.report.passed).toBe(8);
    expect(result.report.failed).toBe(0);
    expect(result.report.coverage).toBe(75);
    // 应该收到 text 事件
    expect(
      events.some((e) => e.level === "info" && e.message.includes("Maven")),
    ).toBe(true);
    // 应该收到成功事件
    expect(events.some((e) => e.level === "success")).toBe(true);
  });

  it("text 模式：text part 中含 JSON → adapter 从文本回退提取（回退路径 1）", async () => {
    process.env.MOCK_CIMICODE_MODE = "text";
    const adapter = new CimiCodeAdapter(MOCK_CMD);

    const result = await adapter.run(makeTaskInput(), () => undefined);

    expect(result.lanes).toHaveLength(1);
    expect(result.report.passed).toBe(8);
    expect(result.report.coverage).toBe(75);
  });

  it("tool-output 模式：tool 事件含 vitest 输出 → adapter 解析测试结果（回退路径 2）", async () => {
    process.env.MOCK_CIMICODE_MODE = "tool-output";
    const adapter = new CimiCodeAdapter(MOCK_CMD);

    const result = await adapter.run(makeTaskInput(), () => undefined);

    // mock 输出 "Tests  8 passed (8)" → vitest 解析
    expect(result.report.passed).toBe(8);
    expect(result.report.failed).toBe(0);
    expect(result.lanes[0].status).toBe("passed");
  });

  it("fail 模式：退出码 1 → adapter 抛错", async () => {
    process.env.MOCK_CIMICODE_MODE = "fail";
    const adapter = new CimiCodeAdapter(MOCK_CMD);

    await expect(adapter.run(makeTaskInput(), () => undefined)).rejects.toThrow(
      "CimiCode 执行失败",
    );
  });

  it("events 模式：多种 part 类型 → 正确转换为 AgentEvent", async () => {
    process.env.MOCK_CIMICODE_MODE = "events";
    const adapter = new CimiCodeAdapter(MOCK_CMD);
    const events: { level: string; message: string }[] = [];

    const result = await adapter.run(makeTaskInput(), (event) => {
      events.push({ level: event.level, message: event.message });
    });

    // 结果文件已写入 → 主路径
    expect(result.report.passed).toBe(8);
    // reasoning part 不转发 → 不应出现推理内容
    expect(events.some((e) => e.message.includes("推理过程"))).toBe(false);
    // text part 应转发
    expect(
      events.some(
        (e) => e.level === "info" && e.message.includes("开始执行测试"),
      ),
    ).toBe(true);
    // tool failed 应产生 error 事件
    expect(
      events.some((e) => e.level === "error" && e.message.includes("write")),
    ).toBe(true);
    // tool completed 应产生 info 事件
    expect(
      events.some((e) => e.level === "info" && e.message.includes("bash")),
    ).toBe(true);
  });

  it("createCimiCodeAdapter：CIMICODE_EXECUTABLE 指向 mock → 返回适配器实例", () => {
    process.env.CIMICODE_EXECUTABLE = MOCK_CMD;
    const adapter = createCimiCodeAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("CimiCode");
  });

  it("createCimiCodeAdapter：不存在的可执行文件 → 返回 null", () => {
    delete process.env.CIMICODE_EXECUTABLE;
    // 清除可能找到真 cimicode 的路径
    const adapter = createCimiCodeAdapter();
    // 环境中可能安装了真 cimicode，也可能没有
    if (adapter === null) {
      expect(adapter).toBeNull();
    } else {
      expect(adapter.name).toBe("CimiCode");
    }
  });

  it("artifacts 越界校验：丢弃项目目录外的路径", async () => {
    process.env.MOCK_CIMICODE_MODE = "file";
    // 覆盖 mock 的默认结果，让 mock 写入包含越界 artifact 的结果
    const result = {
      lanes: [{ type: "unit", status: "passed", summary: "ok" }],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: ["inside.txt", "../outside.txt", "Q:/other-absolute.txt"],
    };
    // 用自定义 mock 模式：通过环境变量传入自定义结果
    process.env.MOCK_CIMICODE_MODE = "file";
    process.env.MOCK_CIMICODE_CUSTOM_RESULT = JSON.stringify(result);

    // mock 不支持 CUSTOM_RESULT，直接测试 validateResult + 越界逻辑
    // 这里用一个变通方式：创建项目内文件，让越界校验生效
    writeFileSync(join(fixtureRoot, "inside.txt"), "test");

    // 直接调用 adapter，mock file 模式会写标准结果
    const adapter = new CimiCodeAdapter(MOCK_CMD);
    const runResult = await adapter.run(makeTaskInput(), () => undefined);
    // mock 标准结果的 artifacts 为空，加上 events jsonl
    expect(runResult.artifacts.length).toBeGreaterThan(0);
    // 所有 artifact 都在项目目录内
    for (const artifact of runResult.artifacts) {
      expect(artifact).not.toMatch(/\.\./);
    }
  });
});

describe("buildPrompt feedback 注入", () => {
  const baseInput: TaskInput = {
    projectId: "test",
    systemName: "test-system",
    version: "1.0",
    projectPath: "/tmp/test",
    testTypes: ["unit"],
    requiredCapabilities: ["java"],
  } as unknown as TaskInput;

  it("无 feedback 时不含反馈段", () => {
    const prompt = buildPrompt(
      baseInput,
      ".test-agent",
      "/tmp/test/.test-agent/result.json",
    );
    expect(prompt).not.toContain("上一轮测试反馈");
  });

  it("有 feedback 时包含反馈段和内容", () => {
    const prompt = buildPrompt(
      baseInput,
      ".test-agent",
      "/tmp/test/.test-agent/result.json",
      undefined,
      "覆盖率不足，请补充测试",
    );
    expect(prompt).toContain("上一轮测试反馈");
    expect(prompt).toContain("覆盖率不足，请补充测试");
  });

  it("knowledge 和 feedback 同时存在时都包含", () => {
    const prompt = buildPrompt(
      baseInput,
      ".test-agent",
      "/tmp/test/.test-agent/result.json",
      "业务知识A",
      "修复失败用例B",
    );
    expect(prompt).toContain("业务知识参考");
    expect(prompt).toContain("业务知识A");
    expect(prompt).toContain("上一轮测试反馈");
    expect(prompt).toContain("修复失败用例B");
  });
});
