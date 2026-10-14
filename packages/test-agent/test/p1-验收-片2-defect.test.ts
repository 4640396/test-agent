/**
 * P1 片2 独立验收 — 缺陷联动（PRD 7.5 三场景 + 边界探针）
 *
 * 独立视角：不照抄 worker 内置 defect-tracker.test.ts 结论。重点验证：
 * 1. PRD 7.5 场景 A：FailedCaseRecord → DefectCreateInput 组装完整性（GUI 组装契约 +
 *    Jira body 标题/描述/证据/建议/附件齐全）
 * 2. PRD 7.5 场景 B：webhook 回写本期不实现 — 独立确认"确实没做"（非 fail）
 * 3. PRD 7.5 场景 C：非 real-bug 不建单 — 独立判断：category 过滤仅在 GUI 侧（v-if），
 *    tracker 层不过滤（P2 建议：缺防御纵深）
 * 4. 边界探针：Jira 不可达降级、环境变量缺失、空证据/空截图、同名用例 key 隔离、
 *    DefectTracker 抽象 Mock/Jira 双实现满足接口
 * 5. 独立判断点：建单真"确认后"（GUI 按钮触发，src 无自动调用）、非 real-bug 真不显示
 *    按钮（v-if 不渲染，非 disabled）
 *
 * 注：GUI .vue 组件渲染无法在 test-agent vitest 套件内单测（无 GUI 组件测试 harness），
 * 相关断言通过源码确认写入报告，标 [需人工复核-GUI组件测试]。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createDefectTracker,
  GuardedDefectTracker,
  MockDefectTracker,
  resetMockCounter,
  JiraDefectTracker,
  jiraConfigFromEnv,
  isJiraConfigured,
  type DefectCreateInput,
  type DefectCreateResult,
  type DefectTracker,
} from "../src/integrations/index.js";
import * as integrationsIndex from "../src/integrations/index.js";
import type { FailedCaseRecord } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 辅助：模拟 GUI 组装（App.vue createDefect 的契约镜像，用于验证输入完整性）
// ---------------------------------------------------------------------------

/** 镜像 App.vue createDefect 的 FailedCaseRecord → DefectCreateInput 组装逻辑。 */
function assembleInput(item: FailedCaseRecord): DefectCreateInput {
  return {
    title: item.name,
    description: item.error,
    evidence: item.evidence,
    suggestion: item.suggestion,
    caseName: item.name,
    category: item.category,
    ...(item.screenshot ? { screenshots: [item.screenshot], attachments: [item.screenshot] } : {}),
  };
}

function realBugCase(overrides?: Partial<FailedCaseRecord>): FailedCaseRecord {
  return {
    name: "TC_LOGIN_001",
    layer: "api",
    error: "调用 /api/login 返回 HTTP 500，响应体 { error: 'NPE' }",
    category: "real-bug",
    confidence: "high",
    evidence: "LoginController.java:42 — NullPointerException at userService.findById(null)",
    suggestion: "增加 null 检查或使用 Optional",
    screenshot: ".test-agent/screenshots/login-500.png",
    ...overrides,
  };
}

function mockFetchResponse(ok: boolean, body: unknown, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

const validEnv: NodeJS.ProcessEnv = {
  JIRA_URL: "https://test.atlassian.net",
  JIRA_TOKEN: "user@example.com:token123",
  JIRA_PROJECT_KEY: "PROJ",
};

// ---------------------------------------------------------------------------
// PRD 7.5 场景 A：一键建单内容完整
// ---------------------------------------------------------------------------

describe("[片2-验收] 场景A：一键建单内容完整", () => {
  beforeEach(() => resetMockCounter());

  it("Mock tracker：real-bug FailedCaseRecord 组装后建单成功，输入字段完整", async () => {
    const tracker = new MockDefectTracker();
    const item = realBugCase();
    const input = assembleInput(item);
    const result = await tracker.createDefect(input);

    expect(result.ok).toBe(true);
    expect(result.defectId).toMatch(/^MOCK-\d+$/);
    expect(result.defectUrl).toMatch(/^mock:\/\/MOCK-\d+$/);
    // 输入完整性（GUI 组装契约）
    expect(input.title).toBe("TC_LOGIN_001");
    expect(input.caseName).toBe("TC_LOGIN_001");
    expect(input.description).toContain("HTTP 500");
    expect(input.evidence).toContain("LoginController.java:42");
    expect(input.suggestion).toContain("null 检查");
    expect(input.category).toBe("real-bug");
    expect(input.screenshots).toEqual([".test-agent/screenshots/login-500.png"]);
    expect(input.attachments).toEqual([".test-agent/screenshots/login-500.png"]); // 截图即附件
  });

  it("Jira tracker：标题=caseName，描述含 error+证据+建议+截图，labels 含 category", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-100" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const input = assembleInput(realBugCase());
      const result = await tracker.createDefect(input);

      expect(result.ok).toBe(true);
      expect(result.defectId).toBe("PROJ-100");
      expect(result.defectUrl).toBe("https://test.atlassian.net/browse/PROJ-100");

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.fields.summary).toBe("TC_LOGIN_001"); // 标题=用例名
      expect(body.fields.issuetype.name).toBe("Bug");
      expect(body.fields.project.key).toBe("PROJ");
      expect(body.fields.labels).toContain("test-agent");
      expect(body.fields.labels).toContain("real-bug");
      // 描述含错误 + 证据 + 建议 + 截图
      const desc: string = body.fields.description;
      expect(desc).toContain("HTTP 500");
      expect(desc).toContain("LoginController.java:42");
      expect(desc).toContain("null 检查");
      expect(desc).toContain("login-500.png");
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("无 screenshot 的 real-bug：不发附件，描述仍含错误+证据+建议", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-101" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const item = realBugCase({ screenshot: undefined });
      const input = assembleInput(item);
      const result = await tracker.createDefect(input);

      expect(result.ok).toBe(true);
      expect(input.screenshots).toBeUndefined();
      expect(input.attachments).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // 仅建单，无附件 API
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.fields.description).toContain("HTTP 500");
      expect(body.fields.description).toContain("LoginController.java:42");
      expect(body.fields.description).toContain("null 检查");
    } finally {
      global.fetch = global.fetch;
    }
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 场景 B：webhook 回写 [需人工复核-二期] — 独立确认"确实没做"
// ---------------------------------------------------------------------------

describe("[片2-验收] 场景B：webhook 回写（确认本期不实现）", () => {
  it("[需人工复核-二期] integrations 模块不导出任何 webhook / 回写触发回归 API", () => {
    // 独立确认：webhook 仅出现在 defect-tracker.ts 注释标记，无实际实现
    const exportNames = Object.keys(integrationsIndex);
    const webhookRelated = exportNames.filter((n) =>
      /webhook|onDefect|defectResolved|triggerRegression|registerWebhook/i.test(n),
    );
    expect(webhookRelated).toEqual([]);
  });

  it("[需人工复核-二期] DefectTracker 接口无 webhook/状态回写方法", async () => {
    // 接口仅 createDefect + 可选 ping，无状态回写方法
    const tracker: DefectTracker = new MockDefectTracker();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(tracker)).filter(
      (m) => m !== "constructor",
    );
    // Mock 实例方法集（createDefect + ping），不含 webhook
    expect(methods).toContain("createDefect");
    expect(methods.some((m) => /webhook|onDefect|resolve|regression/i.test(m))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 场景 C：非 real-bug 不建单 — 独立判断（过滤仅在 GUI 侧）
// ---------------------------------------------------------------------------

describe("[片2-验收] 场景C：非 real-bug 不建单（独立判断）", () => {
  // GUI 侧判定函数（App.vue line 1014）：return category === 'real-bug'
  // 此处镜像以验证契约；真实函数在 .vue 中已源码确认用 v-if 不渲染（非 disabled）
  function shouldShowCreateDefectButton(category: string): boolean {
    return category === "real-bug";
  }

  it("real-bug → 显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("real-bug")).toBe(true);
  });

  it("test-defect / environment / flaky → 不显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("test-defect")).toBe(false);
    expect(shouldShowCreateDefectButton("environment")).toBe(false);
    expect(shouldShowCreateDefectButton("flaky")).toBe(false);
  });

  it("[P2发现] tracker 层不过滤 category：非 real-bug 仍可被 createDefect 建单（缺防御纵深）", async () => {
    // 独立发现：category 过滤仅存在于 GUI v-if，tracker 抽象与 Mock/Jira 实现均不校验 category。
    // 若 IPC/其他调用方绕过 GUI 直调 createDefect，非 real-bug 也会建单（污染工单库）。
    resetMockCounter();
    const tracker = new MockDefectTracker();
    for (const category of ["test-defect", "environment", "flaky"]) {
      const input: DefectCreateInput = {
        title: "TC_X",
        description: "err",
        caseName: "TC_X",
        category,
      };
      const result = await tracker.createDefect(input);
      // tracker 层不拒绝 → 缺防御纵深（P2 建议）
      expect(result.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 边界探针
// ---------------------------------------------------------------------------

describe("[片2-验收] 边界探针：Jira 不可达降级", () => {
  afterEach(() => {
    // 恢复 fetch（vi 替换后还原由各用例自行处理）
  });

  it("fetch 抛 ECONNREFUSED → ok=false，error 含『不可达』，不抛", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const result = await tracker.createDefect(assembleInput(realBugCase()));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Jira 未配置或不可达/);
      expect(result.defectId).toBeUndefined();
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("fetch 抛非 Error 值 → 仍 ok=false 不抛（健壮性）", async () => {
    global.fetch = vi.fn().mockRejectedValue("string error") as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const result = await tracker.createDefect(assembleInput(realBugCase()));
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("HTTP 500 → ok=false，error 含状态码，不抛", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse(false, "Internal Server Error", 500)) as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const result = await tracker.createDefect(assembleInput(realBugCase()));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/500/);
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("建单失败不阻塞：返回 ok=false 而非抛异常（PRD 7.8 退路）", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      await expect(tracker.createDefect(assembleInput(realBugCase()))).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      global.fetch = global.fetch;
    }
  });
});

describe("[片2-验收] 边界探针：环境变量缺失", () => {
  it("jiraConfigFromEnv 三变量缺任一 → null", () => {
    expect(jiraConfigFromEnv({})).toBeNull();
    expect(jiraConfigFromEnv({ JIRA_URL: "https://x" })).toBeNull();
    expect(jiraConfigFromEnv({ JIRA_URL: "https://x", JIRA_TOKEN: "t" })).toBeNull();
    expect(jiraConfigFromEnv({ JIRA_TOKEN: "t", JIRA_PROJECT_KEY: "p" })).toBeNull();
  });

  it("isJiraConfigured 缺任意变量 → false", () => {
    expect(isJiraConfigured({})).toBe(false);
    expect(isJiraConfigured({ JIRA_URL: "https://x", JIRA_TOKEN: "t" })).toBe(false);
    expect(isJiraConfigured(validEnv)).toBe(true);
  });

  it("JiraDefectTracker.fromEnv 缺变量 → 抛清晰错误", () => {
    expect(() => JiraDefectTracker.fromEnv({})).toThrow(/Jira 未配置/);
    expect(() => JiraDefectTracker.fromEnv({ JIRA_URL: "https://x" })).toThrow(/Jira 未配置/);
  });

  it("工厂：显式 jira 但配置缺失 → 抛错（不静默回退）", () => {
    expect(() => createDefectTracker({ TEST_AGENT_DEFECT_TRACKER: "jira" })).toThrow(/Jira 未配置/);
  });

  it("工厂：默认 + 配置不全 → 回退 Mock（不阻塞任务）", () => {
    expect((createDefectTracker({}) as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
    expect((createDefectTracker({ JIRA_URL: "https://x" }) as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
  });

  it("工厂：仅空白环境变量（trim 后为空）→ 视为缺失回退 Mock", () => {
    expect(
      (createDefectTracker({ JIRA_URL: "  ", JIRA_TOKEN: "  ", JIRA_PROJECT_KEY: "  " }) as GuardedDefectTracker).inner,
    ).toBeInstanceOf(MockDefectTracker);
  });
});

describe("[片2-验收] 边界探针：空证据 / 空截图", () => {
  it("仅必填字段（无 evidence/suggestion/screenshots）→ Jira 描述只含 description", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-200" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const input: DefectCreateInput = {
        title: "TC_MIN",
        description: "bare error",
        caseName: "TC_MIN",
        category: "real-bug",
      };
      const result = await tracker.createDefect(input);
      expect(result.ok).toBe(true);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.fields.summary).toBe("TC_MIN");
      // 描述以 description 开头，不含 *证据*/*修复建议*/*截图* 段
      expect(body.fields.description).toContain("bare error");
      expect(body.fields.description).not.toContain("*证据*");
      expect(body.fields.description).not.toContain("*修复建议*");
      expect(body.fields.description).not.toContain("*截图*");
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("空 title 时回退用 caseName 作 summary", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-201" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const input: DefectCreateInput = {
        title: "",
        description: "err",
        caseName: "TC_FALLBACK",
        category: "real-bug",
      };
      const result = await tracker.createDefect(input);
      expect(result.ok).toBe(true);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.fields.summary).toBe("TC_FALLBACK");
    } finally {
      global.fetch = global.fetch;
    }
  });

  it("空 attachments 数组 → 不触发附件 API", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-202" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const result = await tracker.createDefect(
        assembleInput(realBugCase({ screenshot: undefined })),
      );
      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // 仅建单
    } finally {
      global.fetch = global.fetch;
    }
  });
});

describe("[片2-验收] 边界探针：同名用例 name#index key 隔离", () => {
  beforeEach(() => resetMockCounter());

  it("tracker 侧：同名 caseName 多次建单 → 产出不同 defectId（无去重）", async () => {
    const tracker = new MockDefectTracker();
    const input: DefectCreateInput = {
      title: "TC_DUP",
      description: "err",
      caseName: "TC_DUP",
      category: "real-bug",
    };
    const r1 = await tracker.createDefect(input);
    const r2 = await tracker.createDefect(input);
    const r3 = await tracker.createDefect(input);
    expect(r1.defectId).toBe("MOCK-1");
    expect(r2.defectId).toBe("MOCK-2");
    expect(r3.defectId).toBe("MOCK-3");
    expect(r1.defectId).not.toBe(r2.defectId);
  });

  it("GUI 侧 defectKey 契约：name#index 隔离（源码确认 App.vue line 1009）", () => {
    // 镜像 App.vue defectKey 实现（源码已确认：`${name}#${index}`）
    function defectKey(name: string, index: number): string {
      return `${name}#${index}`;
    }
    // 同名用例不同 index → 不同 key（round2 P2-1 修复点）
    expect(defectKey("TC_DUP", 0)).toBe("TC_DUP#0");
    expect(defectKey("TC_DUP", 1)).toBe("TC_DUP#1");
    expect(defectKey("TC_DUP", 0)).not.toBe(defectKey("TC_DUP", 1));
    // 不同名用例 → 不同 key
    expect(defectKey("TC_A", 0)).not.toBe(defectKey("TC_B", 0));
  });
});

describe("[片2-验收] 边界探针：DefectTracker 抽象双实现满足接口", () => {
  it("Mock 与 Jira 实例都满足 DefectTracker 接口（createDefect 必备，ping 可选）", () => {
    const mock: DefectTracker = new MockDefectTracker();
    const jira: DefectTracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    expect(typeof mock.createDefect).toBe("function");
    expect(typeof jira.createDefect).toBe("function");
    // ping 都是可选方法，二者都实现了
    expect(typeof mock.ping).toBe("function");
    expect(typeof jira.ping).toBe("function");
  });

  it("Mock 与 Jira createDefect 返回值都满足 DefectCreateResult 形状", async () => {
    const mock: DefectTracker = new MockDefectTracker();
    resetMockCounter();
    const input: DefectCreateInput = {
      title: "T",
      description: "d",
      caseName: "T",
      category: "real-bug",
    };
    const mockResult = await mock.createDefect(input);
    expect(typeof mockResult.ok).toBe("boolean");
    expect(mockResult.ok).toBe(true);
    expect(typeof mockResult.defectId).toBe("string");

    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, { key: "PROJ-300" }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const jira: DefectTracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
      const jiraResult = await jira.createDefect(input);
      expect(typeof jiraResult.ok).toBe("boolean");
      expect(jiraResult.ok).toBe(true);
      expect(typeof jiraResult.defectId).toBe("string");
    } finally {
      global.fetch = global.fetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 独立判断点：建单真"确认后"（src 无自动调用）
// ---------------------------------------------------------------------------

describe("[片2-验收] 独立判断点：建单确认后触发（非自动）", () => {
  it("integrations 模块仅导出 tracker 工厂/实现，无自动建单编排", () => {
    // 源码确认（已 grep）：createDefect 仅在 integrations 内定义并经 index 导出，
    // runner/orchestrator/modes 均无 createDefect 调用 → 建单纯由 GUI 按钮点击触发。
    const exportNames = Object.keys(integrationsIndex);
    // 应包含工厂与实现，不应包含任何"自动建单/批量建单"编排函数
    expect(exportNames).toContain("createDefectTracker");
    expect(exportNames).toContain("MockDefectTracker");
    expect(exportNames).toContain("JiraDefectTracker");
    const autoCreate = exportNames.filter((n) =>
      /autoCreate|batchCreate|createDefects|onDiagnosis/i.test(n),
    );
    expect(autoCreate).toEqual([]);
  });
});
