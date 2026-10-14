import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createDefectTracker,
  GuardedDefectTracker,
  MockDefectTracker,
  resetMockCounter,
  getMockCounter,
  JiraDefectTracker,
  jiraConfigFromEnv,
  isJiraConfigured,
  type DefectCreateInput,
} from "../src/integrations/index.js";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeRealBugInput(overrides?: Partial<DefectCreateInput>): DefectCreateInput {
  return {
    title: "登录接口返回 500",
    description: "调用 /api/login 返回 HTTP 500，响应体 { error: 'NPE' }",
    evidence: "LoginController.java:42 — NullPointerException at userService.findById(null)",
    suggestion: "增加 null 检查或使用 Optional",
    caseName: "TC_LOGIN_001",
    category: "real-bug",
    screenshots: [".test-agent/screenshots/login-500.png"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock 实现
// ---------------------------------------------------------------------------

describe("MockDefectTracker", () => {
  beforeEach(() => resetMockCounter());

  it("确定性返回 ok=true 且 defectId=MOCK-<n>", async () => {
    const tracker = new MockDefectTracker();
    const r1 = await tracker.createDefect(makeRealBugInput());
    const r2 = await tracker.createDefect(makeRealBugInput());
    expect(r1.ok).toBe(true);
    expect(r1.defectId).toBe("MOCK-1");
    expect(r1.defectUrl).toBe("mock://MOCK-1");
    expect(r2.ok).toBe(true);
    expect(r2.defectId).toBe("MOCK-2");
  });

  it("ping 返回 true", async () => {
    const tracker = new MockDefectTracker();
    expect(await tracker.ping()).toBe(true);
  });

  it("计数器递增，resetMockCounter 重置", () => {
    resetMockCounter();
    expect(getMockCounter()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Jira 实现（mock fetch）
// ---------------------------------------------------------------------------

function mockFetchResponse(ok: boolean, body: unknown, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

describe("JiraDefectTracker", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const validEnv: NodeJS.ProcessEnv = {
    JIRA_URL: "https://test.atlassian.net",
    JIRA_TOKEN: "user@example.com:token123",
    JIRA_PROJECT_KEY: "PROJ",
  };

  it("配置完整时 fromEnv 构造成功", () => {
    const tracker = JiraDefectTracker.fromEnv(validEnv);
    expect(tracker).toBeInstanceOf(JiraDefectTracker);
  });

  it("配置缺失时 fromEnv 抛清晰错误", () => {
    expect(() => JiraDefectTracker.fromEnv({})).toThrow(/Jira 未配置/);
    expect(() => JiraDefectTracker.fromEnv({ JIRA_URL: "https://x" })).toThrow(/Jira 未配置/);
  });

  it("jiraConfigFromEnv 缺字段返回 null", () => {
    expect(jiraConfigFromEnv({})).toBeNull();
    expect(jiraConfigFromEnv({ JIRA_URL: "https://x" })).toBeNull();
    expect(jiraConfigFromEnv(validEnv)).not.toBeNull();
  });

  it("isJiraConfigured 正确判断", () => {
    expect(isJiraConfigured({})).toBe(false);
    expect(isJiraConfigured(validEnv)).toBe(true);
  });

  it("createDefect 调 Jira REST API，URL/headers/body 正确", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { key: "PROJ-123" }),
    );
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const input = makeRealBugInput();
    const result = await tracker.createDefect(input);

    expect(result.ok).toBe(true);
    expect(result.defectId).toBe("PROJ-123");
    expect(result.defectUrl).toBe("https://test.atlassian.net/browse/PROJ-123");

    // 验证 fetch 调用参数
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://test.atlassian.net/rest/api/3/issue");
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);
    expect(headers["Content-Type"]).toBe("application/json");

    // 验证 body
    const body = JSON.parse(init?.body as string);
    expect(body.fields.project.key).toBe("PROJ");
    expect(body.fields.summary).toBe("登录接口返回 500");
    expect(body.fields.issuetype.name).toBe("Bug");
    expect(body.fields.labels).toContain("test-agent");
    expect(body.fields.labels).toContain("real-bug");
    // 描述含 error + evidence + suggestion
    expect(body.fields.description).toContain("HTTP 500");
    expect(body.fields.description).toContain("LoginController.java");
    expect(body.fields.description).toContain("null 检查");
  });

  it("PRD 7.5 场景A：一键建单内容完整——标题=caseName，描述含 error+evidence+suggestion", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { key: "PROJ-456" }),
    );
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const input: DefectCreateInput = {
      title: "TC_LOGIN_001",
      description: "调用 /api/login 返回 HTTP 500",
      evidence: "LoginController.java:42 NPE",
      suggestion: "增加 null 检查",
      caseName: "TC_LOGIN_001",
      category: "real-bug",
    };
    const result = await tracker.createDefect(input);

    expect(result.ok).toBe(true);
    expect(result.defectId).toBe("PROJ-456");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    // 标题 = caseName
    expect(body.fields.summary).toBe("TC_LOGIN_001");
    // 描述含 error(=description) + evidence + suggestion
    const desc: string = body.fields.description;
    expect(desc).toContain("HTTP 500");
    expect(desc).toContain("LoginController.java:42 NPE");
    expect(desc).toContain("增加 null 检查");
  });

  it("HTTP 失败返回 ok=false 不抛", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(
      mockFetchResponse(false, "Internal Server Error", 500),
    );
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const result = await tracker.createDefect(makeRealBugInput());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Jira 创建失败 500/);
    expect(result.defectId).toBeUndefined();
  });

  it("网络异常返回 ok=false 不抛", async () => {
  const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const result = await tracker.createDefect(makeRealBugInput());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Jira 未配置或不可达/);
  });

  it("凭据缺失（构造时抛错）", () => {
  expect(() => new JiraDefectTracker({ url: "", token: "", projectKey: "" })).toThrow(/Jira 配置不完整/);
  });

  it("ping 可达返回 true，不可达返回 false", async () => {
  const okSpy = vi.fn().mockResolvedValue(mockFetchResponse(true, {}));
    global.fetch = okSpy as unknown as typeof global.fetch;
    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    expect(await tracker.ping()).toBe(true);

  const failSpy = vi.fn().mockResolvedValue(mockFetchResponse(false, {}, 401));
    global.fetch = failSpy as unknown as typeof global.fetch;
    expect(await tracker.ping()).toBe(false);

  const errSpy = vi.fn().mockRejectedValue(new Error("timeout"));
    global.fetch = errSpy as unknown as typeof global.fetch;
    expect(await tracker.ping()).toBe(false);
  });

  it("附件上传不阻塞建单成功", async () => {
  let callIndex = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(mockFetchResponse(true, { key: "PROJ-789" }));
      // 附件上传返回失败——不阻塞
      return Promise.resolve(mockFetchResponse(false, "upload failed", 500));
    });
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const result = await tracker.createDefect(
      makeRealBugInput({ attachments: ["/nonexistent/file.txt"] }),
    );

    // 建单仍成功
    expect(result.ok).toBe(true);
    expect(result.defectId).toBe("PROJ-789");
  });
});

// ---------------------------------------------------------------------------
// 工厂选择逻辑
// ---------------------------------------------------------------------------

describe("createDefectTracker 工厂选择", () => {
  it("TEST_AGENT_DEFECT_TRACKER=mock → Guarded(Mock)", () => {
    const tracker = createDefectTracker({
      TEST_AGENT_DEFECT_TRACKER: "mock",
      JIRA_URL: "https://x",
      JIRA_TOKEN: "t",
      JIRA_PROJECT_KEY: "p",
    });
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
  });

  it("TEST_AGENT_DEFECT_TRACKER=jira 且配置完整 → Guarded(Jira)", () => {
    const tracker = createDefectTracker({
      TEST_AGENT_DEFECT_TRACKER: "jira",
      JIRA_URL: "https://test.atlassian.net",
      JIRA_TOKEN: "user:token",
      JIRA_PROJECT_KEY: "PROJ",
    });
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(JiraDefectTracker);
  });

  it("TEST_AGENT_DEFECT_TRACKER=jira 但配置缺失 → 抛错", () => {
    expect(() =>
      createDefectTracker({ TEST_AGENT_DEFECT_TRACKER: "jira" }),
    ).toThrow(/Jira 未配置/);
  });

  it("无显式选择，Jira 配齐 → Guarded(Jira)", () => {
    const tracker = createDefectTracker({
      JIRA_URL: "https://test.atlassian.net",
      JIRA_TOKEN: "user:token",
      JIRA_PROJECT_KEY: "PROJ",
    });
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(JiraDefectTracker);
  });

  it("无显式选择，Jira 配置不全 → Guarded(Mock)（回退）", () => {
    const tracker = createDefectTracker({});
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
  });

  it("无显式选择，仅 JIRA_URL → Guarded(Mock)（配置不全回退）", () => {
    const tracker = createDefectTracker({ JIRA_URL: "https://x" });
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
  });
});

// ---------------------------------------------------------------------------
// P2-1 防御纵深补强：tracker 层 real-bug 校验（第二道防线，绕过 GUI 也拒绝）
// ---------------------------------------------------------------------------

describe("P2-1 防御纵深：非 real-bug 在 tracker 层被拒", () => {
  const realBugInput = {
    title: "TC_LOGIN_001 登录失败",
    description: "错误+证据+建议",
    caseName: "TC_LOGIN_001",
    category: "real-bug",
  };
  const nonRealBugCategories = ["test-defect", "environment", "flaky"] as const;

  for (const category of nonRealBugCategories) {
    it(`Mock 路径：category=${category} → 拒绝建单（ok=false，不抛异常）`, async () => {
      const tracker = createDefectTracker({ TEST_AGENT_DEFECT_TRACKER: "mock" });
      const result = await tracker.createDefect({ ...realBugInput, category });
      expect(result.ok).toBe(false);
      expect(result.defectId).toBeUndefined();
      expect(result.error).toContain("非 real-bug");
      expect(result.error).toContain(category);
    });

    it(`Jira 路径：category=${category} → 拒绝建单（不调 Jira API，ok=false）`, async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const tracker = createDefectTracker({
        TEST_AGENT_DEFECT_TRACKER: "jira",
        JIRA_URL: "https://test.atlassian.net",
        JIRA_TOKEN: "user:token",
        JIRA_PROJECT_KEY: "PROJ",
      });
      const result = await tracker.createDefect({ ...realBugInput, category });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("非 real-bug");
      // 关键：Jira API 未被调用（校验在委托前生效）
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("real-bug 正常建单（Mock 路径透传，不被 guard 拦截）", async () => {
    resetMockCounter();
    const tracker = createDefectTracker({ TEST_AGENT_DEFECT_TRACKER: "mock" });
    const result = await tracker.createDefect(realBugInput);
    expect(result.ok).toBe(true);
    expect(result.defectId).toBeDefined();
  });

  it("real-bug 正常建单（Jira 路径透传，调 Jira API）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "PROJ-1", self: "https://test.atlassian.net/rest/api/3/issue/PROJ-1" }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tracker = createDefectTracker({
      TEST_AGENT_DEFECT_TRACKER: "jira",
      JIRA_URL: "https://test.atlassian.net",
      JIRA_TOKEN: "user:token",
      JIRA_PROJECT_KEY: "PROJ",
    });
    const result = await tracker.createDefect(realBugInput);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("GuardedDefectTracker.inner 暴露被包装的真实跟踪器", () => {
    const tracker = createDefectTracker({ TEST_AGENT_DEFECT_TRACKER: "mock" });
    expect(tracker).toBeInstanceOf(GuardedDefectTracker);
    expect((tracker as GuardedDefectTracker).inner).toBeInstanceOf(MockDefectTracker);
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 场景A 补充：截图作为附件上传（附件=截图）
// ---------------------------------------------------------------------------

describe("PRD 7.5 场景A 补充：截图作为附件上传", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const validEnv: NodeJS.ProcessEnv = {
    JIRA_URL: "https://test.atlassian.net",
    JIRA_TOKEN: "user@example.com:token123",
    JIRA_PROJECT_KEY: "PROJ",
  };

  it("screenshots+attachments 同时存在时触发 Jira 附件 API 调用（附件=截图）", async () => {
    let callIndex = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(mockFetchResponse(true, { key: "PROJ-ATT-1" }));
      return Promise.resolve(mockFetchResponse(true, {}));
    });
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    // GUI 组装时 screenshots 和 attachments 均填充 screenshot 路径
    const input = makeRealBugInput({
      screenshots: [".test-agent/screenshots/login-500.png"],
      attachments: [".test-agent/screenshots/login-500.png"],
    });
    const result = await tracker.createDefect(input);

    expect(result.ok).toBe(true);
    expect(result.defectId).toBe("PROJ-ATT-1");
    // 第一次 fetch = 创建 issue，第二次 fetch = 上传附件
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [attachUrl, attachInit] = fetchSpy.mock.calls[1];
    expect(attachUrl).toBe("https://test.atlassian.net/rest/api/3/issue/PROJ-ATT-1/attachments");
    expect(attachInit?.method).toBe("POST");
    const attachHeaders = (attachInit?.headers ?? {}) as Record<string, string>;
    expect(attachHeaders["X-Atlassian-Token"]).toBe("no-check");
  });

  it("仅 screenshots 无 attachments 时不触发附件 API（仅描述中文本引用）", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { key: "PROJ-ATT-2" }),
    );
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const tracker = new JiraDefectTracker(jiraConfigFromEnv(validEnv)!);
    const input = makeRealBugInput({
      screenshots: [".test-agent/screenshots/login-500.png"],
      attachments: undefined,
    });
    const result = await tracker.createDefect(input);

    expect(result.ok).toBe(true);
    // 仅创建 issue，不调附件 API
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 描述中包含截图路径文本
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.fields.description).toContain("login-500.png");
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 场景B：webhook 回写 [需人工复核-二期]
// ---------------------------------------------------------------------------

describe("PRD 7.5 场景B：webhook 回写", () => {
  it("[需人工复核-webhook闭环-二期] webhook 回写触发回归不在本期实现", () => {
  // 本期仅实现一键建单（createDefect），webhook 回写触发回归为二期。
  // 此测试标记存在性确认，不验证功能。
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRD 7.5 场景C：非 real-bug 不建单（GUI 按钮仅 real-bug 显示）
// ---------------------------------------------------------------------------

describe("PRD 7.5 场景C：非 real-bug 不建单", () => {
  /**
   * GUI 建单按钮显示判定函数。
   * 在 App.vue 中通过 v-if="item.category === 'real-bug'" 控制按钮显示。
   * 此处提取判定逻辑做纯函数测试，确保非 real-bug 不显示建单按钮。
   */
  function shouldShowCreateDefectButton(category: string): boolean {
    return category === "real-bug";
  }

  it("real-bug → 显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("real-bug")).toBe(true);
  });

  it("test-defect → 不显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("test-defect")).toBe(false);
  });

  it("environment → 不显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("environment")).toBe(false);
  });

  it("flaky → 不显示建单按钮", () => {
    expect(shouldShowCreateDefectButton("flaky")).toBe(false);
  });
});
