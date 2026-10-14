import { test, expect } from "@playwright/test";

/**
 * GUI 人工直跑主路径 e2e（P4-1-d）
 *
 * mock window.testAgent（preload 只在 Electron 注入，纯浏览器不存在），
 * 覆盖首页三入口 → 写场景直跑 → 填场景 → 立即跑 → 看结果 全链路。
 *
 * 前提：npm run dev 已起 vite (localhost:5173)
 */

const GUI_URL = process.env.TEST_AGENT_E2E_URL ?? "http://127.0.0.1:5173/";

// ---- mock 数据 ----
const MOCK_SCENARIOS = [{ caseId: "TC001", title: "示例场景" }];
const MOCK_RERUN_OK = { ok: true, output: "Tests run: 1, Failures: 0", error: undefined as string | undefined };
const MOCK_RERUN_FAIL = { ok: false, output: "Tests run: 1, Failures: 1", error: "exit code 1" };

/** 非空 history 记录，使 recentProjects 非空 → 走"有项目"状态（三入口可见）。 */
const MOCK_HISTORY_ENTRY = {
  id: "h1",
  projectName: "mock-project",
  projectPath: "/mock/project",
  version: "main",
  savedAt: new Date().toISOString(),
  snapshot: {
    taskId: "t1",
    status: "completed" as const,
    logs: [] as unknown[],
    lanes: [] as unknown[],
    artifacts: [] as string[],
    report: { passed: 5, failed: 0, coverage: 80 },
  },
};

/**
 * 注入 mock desktopApi。rerunResult 控制 rerunLocal 返回值。
 * withHistory=true 时注入非空 history（三入口可见）。
 */
function mockDesktopApi(rerunResult: typeof MOCK_RERUN_OK | typeof MOCK_RERUN_FAIL = MOCK_RERUN_OK, withHistory = false, libraryCases: unknown[] = []): string {
  const history = withHistory ? `[${JSON.stringify(MOCK_HISTORY_ENTRY)}]` : "[]";
  return `
  window.__startInputs = [];
  window.__deletedCases = [];
  window.testAgent = {
    selectProject: async () => ({ path: '/mock/project', detectedSystem: 'mock-sys', detectedVersion: 'main' }),
    detectProject: async () => ({ path: '/mock/project', detectedSystem: 'mock-sys', detectedVersion: 'main' }),
    getKnowledgeRoots: async () => [],
    onKnowledgeRootsChanged: () => () => {},
    getRuntimeStatus: async () => ({ mode: 'real', provider: 'local-host', message: 'mock' }),
    startTask: async () => ({ taskId: 'mock' }),
    getTask: async () => null,
    cancelTask: async () => null,
    retryTask: async () => null,
    rollbackFix: async () => true,
    subscribeTask: () => () => {},
    exportReport: async () => ({ saved: false }),
    copyReportSummary: async () => ({ copied: true }),
    copyText: async () => ({ copied: true }),
    getHistory: async () => ${history},
    saveHistory: async () => {},
    clearHistory: async () => {},
    selectKnowledgeRoots: async () => [],
    getAiConfig: async () => null,
    saveAiConfig: async () => {},
    onNavigate: () => () => {},
    onCommand: () => () => {},
    loadCases: async () => ${JSON.stringify(libraryCases)},
    previewPlanImpact: async (_projectPath, cases) => window.__zeroImpact ? { total: cases.length, selected: 0, skipped: cases.length, changedFilesCount: 2, fallbackReason: null } : { total: cases.length, selected: cases.length, skipped: 0, changedFilesCount: 0, fallbackReason: '无变更文件，降级全量执行' },
    saveCase: async () => true,
    deleteCaseFromLibrary: async (_projectPath, title) => { window.__deletedCases.push(title); return true; },
    previewGeneratedTestReset: async () => ({ removableFiles: ['src/test/GeneratedTest.java'], protectedFiles: [] }),
    resetGeneratedTests: async () => ({ removedFiles: ['src/test/GeneratedTest.java'], failedFiles: [], protectedFiles: [] }),
    readScenario: async () => null,
    saveScenario: async () => true,
    listScenarios: async () => ${JSON.stringify(MOCK_SCENARIOS)},
    deleteScenario: async () => true,
    importScenarios: async () => ({ imported: 0, skipped: 0 }),
    exportScenarios: async () => [],
    rerunLocal: async () => (${JSON.stringify(rerunResult)}),
    runAllLocal: async () => ({ ok: true, output: 'Tests run: 20, Failures: 0' }),
    runSelectedReflect: async (_projectPath, caseIds) => ({ results: caseIds.map(id => ({ name: id, ok: true, output: '' })), summary: { total: caseIds.length, pass: caseIds.length, fail: 0, skipped: 0 } }),
    rerunFailedBatch: async () => ({ results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 } }),
    getMetrics: async () => [],
    createDefect: async () => ({ ok: true, defectId: 'mock' }),
    replyEscalation: async () => true,
    getEscalationAudit: async () => [],
    saveSuite: async () => ({ ok: true, suiteId: 'mock' }),
    listSuites: async () => [],
    deleteSuite: async () => ({ ok: true }),
    runSuite: async () => ({ results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 } }),
  };
  window.testAgentLocal = {
    getStatus: async () => ({ running: true }),
    start: async (input) => { window.__startInputs.push(input); if (window.__failNextStart) { window.__failNextStart = false; throw new Error('模拟启动失败'); } return { taskId: 'mock' }; },
    cancel: async () => ({ cancelled: true }),
    subscribe: (handler) => { window.__emitHost = handler; return () => {}; },
  };
  `;
}

test.describe("GUI 人工直跑主路径", () => {
  test("有项目状态 → 三入口行动卡可见", async ({ page }) => {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, true));
    await page.goto(GUI_URL);
    await expect(page.getByRole('button', { name: /场景直跑/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /运行回归套件/ })).toBeVisible();
    await expect(page.locator("text=发起 AI 测试")).toBeVisible();
  });

  test("点击写场景直跑 → 展开面板 → 填场景 → 立即跑 → 看结果（pass）", async ({ page }) => {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, true));
    await page.goto(GUI_URL);
    // 先点击项目卡片选中项目（设置 form.projectPath）
    await page.locator(".project-card").first().click();
    // 点击"写场景直跑"行动卡
    await page.getByRole('button', { name: /场景直跑/ }).click();
    // 面板展开
    await expect(page.locator(".quick-reflect-panel")).toBeVisible();
    // 填 JSON（点击 POJO 模板按钮）
    await page.locator('button:has-text("填充 POJO 模板")').click();
    // 点击立即跑
    await page.locator('button:has-text("立即跑")').click();
    // 等待结果
    await expect(page.locator(".quick-reflect-result.pass")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("text=✅ 通过")).toBeVisible();
  });

  test("用例库支持全量测试与严格选择反射场景", async ({ page }) => {
    const cases = [
      { id: 'TC001', title: '可执行反射场景', scenario: '输入', expected: '输出', priority: 'high', layer: 'unit' },
      { id: 'TC002', title: '仅计划用例', scenario: '输入', expected: '输出', priority: 'medium', layer: 'unit' },
    ];
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, true, cases));
    await page.goto(GUI_URL);
    await page.locator('.project-card').first().click();
    await page.locator('.nav-case-summary').click();
    await expect(page.getByRole('heading', { name: '2 条已保存用例' })).toBeVisible();
    const rows = page.locator('.library-case-row');
    await expect(rows.nth(0)).toContainText('可反射执行');
    await expect(rows.nth(1)).toContainText('无反射场景');
    await expect(rows.nth(1).locator('input')).toBeDisabled();
    await expect(page.getByRole('button', { name: '清空用例库并重新开始' })).toBeVisible();
    await rows.nth(0).locator('input').check();
    await page.getByRole('button', { name: '仅运行已选反射场景' }).click();
    await expect(page.getByRole('heading', { name: '执行过程' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('1 通过、0 失败');
    await page.getByRole('button', { name: '返回用例与计划' }).click();
    await page.getByRole('button', { name: '运行全部项目测试' }).click();
    await expect(page.getByRole('heading', { name: '执行过程' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('全量项目测试执行完成');
    await page.getByRole('button', { name: '返回用例与计划' }).click();
    await page.getByRole('button', { name: '删除用例 仅计划用例' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('删除这条用例？');
    await page.getByRole('button', { name: '删除此用例' }).click();
    await expect(page.getByRole('heading', { name: '1 条已保存用例' })).toBeVisible();
    await page.getByRole('button', { name: '清空用例库并重新开始' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('清空当前项目用例库？');
    await expect(page.getByRole('alertdialog')).toContainText('清理 1 个可确认由 Test Agent 生成的未跟踪测试文件');
    await page.getByRole('button', { name: '清空 1 条用例' }).click();
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    expect(await page.evaluate(() => window.__deletedCases)).toEqual(['仅计划用例', '可执行反射场景']);
  });

  test("立即跑失败 → 显示失败结果", async ({ page }) => {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_FAIL, true));
    await page.goto(GUI_URL);
    await page.locator(".project-card").first().click();
    await page.getByRole('button', { name: /场景直跑/ }).click();
    await expect(page.locator(".quick-reflect-panel")).toBeVisible();
    await page.locator('button:has-text("填充 POJO 模板")').click();
    await page.locator('button:has-text("立即跑")').click();
    await expect(page.locator(".quick-reflect-result.fail")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("text=❌ 失败")).toBeVisible();
  });

  test("JSON 格式错误 → 显示错误不跑", async ({ page }) => {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, true));
    await page.goto(GUI_URL);
    await page.locator(".project-card").first().click();
    await page.getByRole('button', { name: /场景直跑/ }).click();
    await expect(page.locator(".quick-reflect-panel")).toBeVisible();
    // 填入非法 JSON：直接在 textarea 里输入
    const textarea = page.locator(".scenario-json-textarea");
    await textarea.fill("{ invalid json }");
    // 填 caseId（模板按钮会覆盖 JSON，所以手动填 caseId）
    await page.locator('input[placeholder="如 TC001"]').fill("TC001");
    // 点击立即跑
    await page.locator('button:has-text("立即跑")').click();
    // 应显示 JSON 解析错误，不显示结果
    await expect(page.locator(".scenario-editor .error")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".quick-reflect-result")).not.toBeVisible();
  });

  test("无项目状态 → 显示 hero 卡 + 引导", async ({ page }) => {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, false));
    await page.goto(GUI_URL);
    await expect(page.locator("text=新建测试任务")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /场景直跑/ })).not.toBeVisible();
  });
});

test.describe('测试计划核对', () => {
  async function ensurePlanCasesOpen(page: import('@playwright/test').Page): Promise<void> {
    const panel = page.locator('.plan-cases-panel')
    if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await panel.locator(':scope > summary').click()
    }
  }

  async function openPlan(page: import('@playwright/test').Page): Promise<void> {
    await page.addInitScript(mockDesktopApi(MOCK_RERUN_OK, true));
    await page.goto(GUI_URL);
    const projectCard = page.locator('.project-card').first();
    if (await projectCard.count()) await projectCard.click();
    await page.waitForFunction(() => typeof (window as typeof window & { __emitHost?: unknown }).__emitHost === 'function');
    await page.evaluate(() => {
      const win = window as typeof window & { __emitHost: (message: unknown) => void };
      const cases = Array.from({ length: 25 }, (_, i) => ({ id: `TC${i + 1}`, title: `用例 ${i + 1}`, layer: i % 2 ? 'api' : 'unit', priority: i % 2 ? 'medium' : 'high', scenario: `场景 ${i + 1}`, expected: `预期 ${i + 1}`, target: `src/Case${i + 1}.java` }));
      win.__emitHost({ kind: 'run-accepted', executionId: 'mock' });
      win.__emitHost({ kind: 'event', executionId: 'mock', event: { type: 'planning_end', caseCount: cases.length, cases } });
      win.__emitHost({ kind: 'run-result', executionId: 'mock', phase: 'plan', outcome: {} });
    });
    await expect(page.getByRole('heading', { name: '用例与计划' })).toBeVisible();
    await ensurePlanCasesOpen(page);
  }

  test('大量用例分页、搜索与展开详情', async ({ page }) => {
    await openPlan(page);
    await expect(page.locator('.nav-case-summary')).toContainText('25');
    await expect(page.locator('.nav-case-summary')).toContainText('当前计划');
    await expect(page.locator('.nav-case-summary')).toContainText('0');
    await expect(page.locator('.nav-case-summary')).toContainText('已保存用例');
    await expect(page.locator('.plan-case-item')).toHaveCount(10);
    await expect(page.locator('.plan-case-pagination')).toContainText('第 1 / 3 页');
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.plan-case-item')).toHaveCount(10);
    await page.getByRole('searchbox', { name: '搜索用例' }).fill('用例 25');
    await expect(page.locator('.plan-case-item')).toHaveCount(1);
    await page.locator('.plan-case-open').click();
    await expect(page.locator('.plan-case-detail textarea').last()).toHaveValue('预期 25');
  });

  test('当前页批量选择、修改及删除不影响其他页', async ({ page }) => {
    await openPlan(page);
    await page.getByText('全选当前页').click();
    await expect(page.locator('.plan-case-bulk')).toContainText('已选 10 条');
    await page.getByRole('combobox', { name: '批量修改优先级' }).selectOption('low');
    await page.locator('.plan-case-open').first().click();
    await expect(page.locator('.plan-case-detail').getByRole('combobox').last()).toHaveValue('low');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除所选' }).click();
    await expect(page.locator('.plan-case-result')).toContainText('15 / 15 条');
    await expect(page.locator('.plan-case-pagination')).toContainText('第 1 / 2 页');
  });

  test('执行范围与启动失败后可重新确认', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('radio', { name: /增量执行/ }).check();
    await expect(page.locator('.plan-impact-preview')).toContainText('拟执行 25 条');
    await page.evaluate(() => { (window as typeof window & { __failNextStart: boolean }).__failNextStart = true; });
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await expect(page.getByText('模拟启动失败')).toBeVisible();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeVisible();
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    const inputs = await page.evaluate(() => (window as typeof window & { __startInputs: Array<{ fullRun?: boolean; cases?: unknown[] }> }).__startInputs);
    expect(inputs.at(-1)?.fullRun).toBe(false);
    expect(inputs.at(-1)?.cases).toHaveLength(25);
  });

  test('仅处理跨页勾选用例，未选中的无效用例不阻塞', async ({ page }) => {
    await openPlan(page);
    await page.locator('.plan-case-row input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: '下一页' }).click();
    await page.locator('.plan-case-row input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: '添加用例' }).click();
    await page.getByRole('radio', { name: /仅处理已勾选用例/ }).check();
    await expect(page.getByText(/已勾选 2 条/)).toBeVisible();
    await expect(page.getByText(/底层验证命令可能仍会运行项目已有的其他测试/)).toBeVisible();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeEnabled();
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    const input = await page.evaluate(() => (window as typeof window & { __startInputs: Array<{ fullRun?: boolean; cases?: Array<{ id: string }> }> }).__startInputs.at(-1));
    expect(input?.fullRun).toBe(true);
    expect(input?.cases?.map(item => item.id)).toEqual(['TC1', 'TC11']);
  });

  test('仅选中范围与跨页选择在刷新后恢复', async ({ page }) => {
    await openPlan(page);
    await page.locator('.plan-case-row input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: '下一页' }).click();
    await page.locator('.plan-case-row input[type="checkbox"]').first().check();
    await page.getByRole('radio', { name: /仅处理已勾选用例/ }).check();
    await page.reload();
    await ensurePlanCasesOpen(page);
    await expect(page.getByRole('radio', { name: /仅处理已勾选用例/ })).toBeChecked();
    await expect(page.locator('.plan-case-bulk')).toContainText('已选 2 条');
  });

  test('任务状态只显示阶段摘要，工具完成结果留在日志', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      const emit = (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost;
      emit({ kind: 'run-accepted', executionId: 'mock' });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'agent_start', role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'turn_start', turn: 1, role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'src/App.java' }, role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: {}, isError: false, role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'tool_execution_start', toolCallId: 'tool-2', toolName: 'read', args: { path: 'src/Missing.java' }, role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'tool_execution_end', toolCallId: 'tool-2', toolName: 'read', result: { details: { ok: false } }, isError: true, role: 'tester' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'agent_end', role: 'tester' } });
    });
    const status = page.locator('.run-status-panel');
    await expect(status).toContainText('测试执行完成');
    await expect(status).not.toContainText('最近活动');
    await expect(status.getByRole('button', { name: '中断当前阶段' })).toBeVisible();
    await expect(status.locator('.run-state-pill')).toHaveCount(0);
    await expect(status).not.toContainText('src/App.java');
    await expect(page.locator('.agent-log-stream')).toContainText('完成');
    await expect(page.locator('.agent-log-stream')).not.toContainText('第1轮');
    await expect(page.locator('.agent-log-stream').getByText('测试执行完成')).toHaveCount(1);
    await expect(page.locator('.agent-log-stream')).toContainText('读取失败');
    await expect(page.locator('.agent-log-stream')).not.toContainText('0/0 通过');
    await expect(page.locator('.agent-details-collapse')).toContainText('测试执行工作记录');
    await expect(page.locator('.agent-details-collapse')).toContainText('已完成');
    await expect(page.locator('.agent-details-collapse')).not.toContainText('第 1 轮');
    await expect(page.locator('.agent-details-collapse')).not.toContainText('本轮结束');
    const logDetails = page.locator('.run-log-details');
    await expect(logDetails.locator('.run-log-label-closed')).toBeVisible();
    await expect(logDetails.locator('.run-log-label-open')).toBeHidden();
    await logDetails.locator(':scope > summary').click();
    await expect(logDetails.locator('.run-log-label-closed')).toBeHidden();
    await expect(logDetails.locator('.run-log-label-open')).toBeVisible();
  });

  test('任务失败原因只在红色提示中显示一次', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    const failure = '本轮生成成功，但项目已有测试编译失败。AuthorizationServiceTest.java:[94,40] 找不到符号。完整输出保留在技术日志中。';
    await page.evaluate((error) => {
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({ kind: 'run-error', executionId: 'mock', error });
    }, failure);
    const status = page.locator('.run-status-panel');
    await expect(status.getByRole('heading', { name: '任务执行失败' })).toBeVisible();
    await expect(status.locator('.run-failure-reason')).toContainText(failure);
    await expect(status.getByText(failure, { exact: true })).toHaveCount(1);
  });

  test('同一生成目标的多轮交互合并为一张工作记录', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      const emit = (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost;
      const role = 'test-generator:9:AlarmNotificationTaskService';
      emit({ kind: 'run-accepted', executionId: 'mock' });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'agent_start', role } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'turn_start', turn: 1, role } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'message_update', turn: 1, role, text: '先读取依赖' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'turn_end', turn: 1, role } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'turn_start', turn: 2, role } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'message_update', turn: 2, role, text: '再生成测试' } });
    });
    const details = page.locator('.agent-details-collapse');
    await page.locator('.run-log-details > summary').click();
    await details.locator(':scope > summary').click();
    await expect(details.locator('.agent-turn')).toHaveCount(1);
    await expect(details).toContainText('测试生成 9 · AlarmNotificationTaskService工作记录');
    await expect(details).toContainText('先读取依赖');
    await expect(details).toContainText('再生成测试');
    await expect(details).toContainText('正在处理');
  });

  test('测试生成按目标展示可续跑进度', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      const emit = (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost;
      emit({ kind: 'run-accepted', executionId: 'mock' });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'generation_progress', target: 'src/main/java/demo/Foo.java', outputPath: 'src/test/java/demo/FooAgentGeneratedTest.java', completed: 1, total: 3, status: 'reused', message: '复用上次已完成文件', role: 'test-generator' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'generation_progress', target: 'src/main/java/demo/Bar.java', outputPath: 'src/test/java/demo/BarAgentGeneratedTest.java', completed: 1, total: 3, status: 'running', role: 'test-generator:1:Bar' } });
      emit({ kind: 'event', executionId: 'mock', event: { type: 'generation_progress', target: 'src/main/java/demo/Baz.java', outputPath: 'src/test/java/demo/BazAgentGeneratedTest.java', completed: 1, total: 3, status: 'retrying', message: '首次未写入，正在自动重试', role: 'test-generator:2:Baz' } });
    });
    const progress = page.getByLabel('测试代码生成进度');
    await expect(progress).toContainText('1 / 3 个目标完成');
    await expect(progress).toContainText('2 个处理中');
    await expect(progress).toContainText('Foo');
    await expect(progress).toContainText('已复用');
    await expect(progress).toContainText('自动重试中');
    await expect(progress).toContainText('已完成的目标会保留');
  });

  test('增量零命中在确认前拦截，允许切回全量', async ({ page }) => {
    await openPlan(page);
    await page.evaluate(() => { (window as typeof window & { __zeroImpact: boolean }).__zeroImpact = true; });
    await page.getByRole('radio', { name: /增量执行/ }).check();
    await expect(page.locator('.plan-impact-preview')).toContainText('零命中');
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeDisabled();
    await page.getByRole('radio', { name: /全量执行/ }).check();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeEnabled();
  });

  test('信息不完整的新增用例不能直接执行', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '添加用例' }).click();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('1 条用例信息不完整');
    await page.getByRole('searchbox', { name: '搜索用例' }).fill('新用例');
    await page.locator('.plan-case-open').click();
    await page.locator('.plan-case-detail textarea').first().fill('给定有效输入');
    await page.locator('.plan-case-detail textarea').first().press('Tab');
    await page.locator('.plan-case-detail textarea').last().fill('返回成功');
    await page.locator('.plan-case-detail textarea').last().press('Tab');
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeEnabled();
  });

  test('计划编辑后刷新仍能继续人工确认', async ({ page }) => {
    await openPlan(page);
    await page.locator('.plan-case-open').first().click();
    await page.getByRole('textbox', { name: '用例名称' }).fill('已核对的用例');
    await page.getByRole('textbox', { name: '用例名称' }).press('Tab');
    await page.getByRole('radio', { name: /增量执行/ }).check();
    await page.reload();
    await expect(page.getByRole('heading', { name: '用例与计划' })).toBeVisible();
    await ensurePlanCasesOpen(page);
    await expect(page.locator('.plan-case-open').first()).toContainText('已核对的用例');
    await expect(page.getByRole('radio', { name: /增量执行/ })).toBeChecked();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeVisible();
  });

  test('确认执行后的计划在重启后仍可查看', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: /用例与计划/ })).toBeEnabled();
    await page.getByRole('button', { name: '执行过程' }).click();
    await expect(page.getByRole('heading', { name: '25 条计划等待继续执行' })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续执行 25 条计划' })).toBeEnabled();
    await page.getByRole('button', { name: '重新生成计划' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('用新计划替换现有的 25 条计划');
    await expect(page.getByRole('alertdialog')).toContainText('不会删除项目源码、已有 JUnit 文件或已保存用例');
    await page.getByRole('button', { name: '取消' }).click();
    await page.getByRole('button', { name: /用例与计划/ }).click();
    await expect(page.getByRole('heading', { name: '用例与计划' })).toBeVisible();
    await expect(page.locator('.plan-count')).toContainText('25 条');
    await expect(page.getByText('继续后会生成测试代码、运行 Maven，并在执行结束后自动保存用例。')).toBeVisible();
    await page.getByRole('button', { name: '仅保存用例' }).click();
    await expect(page.getByRole('status')).toContainText('已保存 25 条用例，暂未执行测试');
    await ensurePlanCasesOpen(page);
    await expect(page.locator('.plan-case-item')).toHaveCount(10);
  });

  test('诊断后跳过修复仍保留测试报告', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({
        kind: 'run-result', executionId: 'mock', phase: 'diagnosis',
        outcome: { lanes: [{ type: 'unit', status: 'failed', summary: '0/1 通过' }], report: { passed: 0, failed: 1, coverage: null, failedCases: [{ name: '失败用例', error: '断言失败', category: 'real-bug' }] }, fixDecision: { action: 'needs-confirm', reason: '先经人工同意' }, cases: [] },
      });
    });
    await expect(page.getByText('修复会修改项目代码')).toBeVisible();
    await page.getByRole('button', { name: '我自己处理' }).click();
    await expect(page.getByRole('heading', { name: '测试报告' })).toBeVisible();
    await expect(page.locator('.detail-view')).toContainText('失败用例');
  });

  test('零工具结果不会显示质量通过', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({
        kind: 'run-result', executionId: 'mock', phase: 'execute',
        outcome: { lanes: [], report: { passed: 0, failed: 0, coverage: null, qualityGate: { status: 'passed', passed: 0, failed: 0, flakyIsolated: 0, flakyFailed: 0, summary: 'mock' } }, cases: [{ id: 'TC1', title: '未核验用例', scenario: '输入', expected: '输出', priority: 'high' }] },
      });
    });
    await expect(page.getByRole('heading', { name: '测试报告' })).toBeVisible();
    await expect(page.locator('.verdict')).toContainText('无可核验测试结果');
    await expect(page.locator('.stat-grid')).toContainText('未验证');
    await expect(page.locator('.stat-grid')).not.toContainText('工具测试通过');
    await expect(page.locator('.stat-grid')).not.toContainText('工具测试失败');
    await expect(page.locator('.stat-grid')).not.toContainText('N/A');
    await expect(page.locator('.report-evidence-note')).toContainText('工具报告 0 个测试结果');
    await expect(page.locator('.report-data-unavailable')).toContainText('测试结果尚未生成');
    await expect(page.locator('.report-data-unavailable')).toContainText('没有测试计数、泳道统计或覆盖率数据');
    await expect(page.getByRole('heading', { name: '覆盖率' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '测试泳道' })).toHaveCount(0);
    await expect(page.locator('.report-neutral-empty')).toContainText('测试结果未生成');
    const auditDetails = page.locator('.report-secondary-details');
    await expect(auditDetails.getByText('跨任务升级审计')).toBeVisible();
    await expect(auditDetails.locator('.report-secondary-body')).toBeHidden();
  });

  test('只有相同用例 ID 的工具证据才显示逐条通过', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({
        kind: 'run-result', executionId: 'mock', phase: 'execute',
        outcome: {
          lanes: [{ type: 'api', status: 'passed', summary: '2/2 通过' }],
          report: { passed: 2, failed: 0, coverage: null, caseResults: [{ caseId: 'TC1', status: 'passed', evidence: 'GET /health · HTTP 200', tool: 'api_test' }] },
          cases: [
            { id: 'TC1', title: '健康检查', scenario: '访问接口', expected: '200', priority: 'high', layer: 'api' },
            { id: 'TC2', title: '没有证据的用例', scenario: '访问接口', expected: '200', priority: 'high', layer: 'api' },
          ],
        },
      });
    });
    await expect(page.getByRole('heading', { name: '测试报告' })).toBeVisible();
    await expect(page.locator('.report-evidence-note')).toContainText('1 条有逐条证据');
    const rows = page.locator('.report-section').filter({ has: page.getByRole('heading', { name: '计划用例核验' }) }).locator('tbody tr');
    await expect(rows.nth(0)).toContainText('已通过');
    await expect(rows.nth(0)).toContainText('GET /health · HTTP 200');
    await expect(rows.nth(1)).toContainText('未核验');
    await expect(rows.nth(1)).toContainText('测试工具未返回相同用例 ID');
  });

  test('报告时间线使用业务名称且候选用例分页', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      const cases = Array.from({ length: 23 }, (_, index) => ({ id: `TC${index + 1}`, title: `候选用例 ${index + 1}`, scenario: '输入', expected: '输出', priority: 'medium', layer: 'unit' }));
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({
        kind: 'run-result', executionId: 'mock', phase: 'execute',
        outcome: {
          lanes: [], cases,
          report: { passed: 0, failed: 0, coverage: null },
          fullReport: { passed: 0, failed: 0, coverage: null, timeline: [
            { stage: '读源码', status: 'passed', startedAt: new Date().toISOString(), durationMs: 100 },
            { stage: 'read', status: 'passed', startedAt: new Date().toISOString(), durationMs: 200 },
            { stage: 'escalate', status: 'failed', startedAt: new Date().toISOString(), durationMs: 300000, message: 'escalate: undefined/undefined 通过' },
            { stage: '写测试代码', status: 'passed', startedAt: new Date().toISOString(), durationMs: 100 },
          ] },
        },
      });
    });
    await expect(page.getByRole('heading', { name: '测试报告' })).toBeVisible();
    const timeline = page.locator('.timeline');
    await expect(timeline).toContainText('读取源码');
    await expect(page.getByRole('heading', { name: '执行摘要' })).toBeVisible();
    await expect(timeline).toContainText('2 项操作');
    await expect(timeline).toContainText('生成测试代码');
    await expect(timeline).not.toContainText('escalate');
    await expect(timeline).not.toContainText('undefined');
    const section = page.locator('.report-section').filter({ has: page.getByRole('heading', { name: '计划用例核验' }) });
    await expect(section.locator('tbody tr')).toHaveCount(10);
    await expect(section.getByLabel('报告候选用例分页')).toContainText('第 1 / 3 页 · 共 23 条');
    await section.getByRole('button', { name: '下一页' }).click();
    await expect(section).toContainText('候选用例 11');
    await expect(section.getByText('候选用例 1', { exact: true })).toHaveCount(0);
  });

  test('预估后变更导致增量零命中仍能返回计划重选', async ({ page }) => {
    await openPlan(page);
    await page.getByRole('radio', { name: /增量执行/ }).check();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeEnabled();
    await page.getByRole('button', { name: '生成测试代码并执行' }).click();
    await page.evaluate(() => {
      (window as typeof window & { __emitHost: (message: unknown) => void }).__emitHost({ kind: 'run-error', executionId: 'mock', error: '增量筛选零命中：文件变化，未启动测试' });
    });
    await expect(page.getByRole('heading', { name: '用例与计划' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('增量筛选零命中');
    await page.reload();
    await expect(page.getByRole('heading', { name: '用例与计划' })).toBeVisible();
    await page.getByRole('radio', { name: /全量执行/ }).check();
    await expect(page.getByRole('button', { name: '生成测试代码并执行' })).toBeEnabled();
  });
});

