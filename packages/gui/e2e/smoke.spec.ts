import { test, expect } from "@playwright/test";

/**
 * GUI 工作台 e2e 冒烟自测
 *
 * 用 Edge channel（Chromium 内核，系统自带，不下载 chromium）连 vite dev server
 * (localhost:5173)，验证 P0→P3 关键 UI 元素能渲染 + 无模板编译错误。
 *
 * 注意：renderer 在纯浏览器（非 electron）里跑时，window.testAgent 等 preload
 * API 不存在，部分依赖 electron API 的交互组件会降级/隐藏。所以这里只验证
 * 「纯视图层能渲染 + 无 vue 编译 fatal」，不验证需 electron 环境的交互。
 *
 * 运行：npx playwright test --config packages/gui/playwright.config.ts
 * 前提：npm run dev 已起 vite (localhost:5173)
 */

const GUI_URL = process.env.TEST_AGENT_E2E_URL ?? "http://localhost:5173/";

test.describe("GUI 工作台冒烟", () => {
  test("首页工作台渲染 + 标题", async ({ page }) => {
    await page.goto(GUI_URL);
    // P1-0 首页标题改"工作台"
    await expect(page.locator("h1").first()).toHaveText("工作台", { timeout: 10000 });
  });

  test("左导航图标条渲染（P1-1 真工作台导航）", async ({ page }) => {
    await page.goto(GUI_URL);
    // 左导航至少 7 个图标按钮（首页/项目/运行/报告/回归套件/场景文件/覆盖率/设置）
    const navButtons = page.locator(".workspace-nav button, .workspace-nav-compact button, main > aside button").or(
      page.locator("button").filter({ hasText: /📋|▶|📊|📦|🎯|📈|📜|⚙/ })
    );
    const count = await navButtons.count();
    expect(count, "左导航应有多个图标按钮").toBeGreaterThan(3);
  });

  test("host pill 状态指示渲染", async ({ page }) => {
    await page.goto(GUI_URL);
    // 底部 host pill
    await expect(page.locator("text=/本机 Host/").first()).toBeVisible({ timeout: 10000 });
  });

  test("无模板编译错误（无 vue: Invalid end tag fatal）", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      const msg = e.message;
      // 只抓 vue 模板编译 fatal；preload/electron API 缺失的运行时错误不算（非 electron 环境正常）
      if (msg.includes("Invalid end tag") || msg.includes("Compiler Error") || msg.includes("compileTemplate")) {
        errors.push(`pageerror: ${msg}`);
      }
    });
    page.on("console", (msg) => {
      const t = msg.text();
      // 只抓 vue 模板编译 fatal，preload API 缺失的运行时错误不算（非 electron 环境）
      if (msg.type() === "error" && (t.includes("Invalid end tag") || t.includes("Compiler Error") || t.includes("compileTemplate"))) {
        errors.push(`console: ${t}`);
      }
    });
    await page.goto(GUI_URL);
    await page.waitForTimeout(2500);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("DOM 挂载成功（#app 有内容，非空 shell）", async ({ page }) => {
    await page.goto(GUI_URL);
    await page.waitForTimeout(1500);
    const appContent = await page.locator("#app").innerHTML();
    expect(appContent.length, "#app 不应为空").toBeGreaterThan(100);
  });

  test("Host 未就绪时说明禁用原因且选择项可由键盘访问", async ({ page }) => {
    await page.goto(GUI_URL);
    await expect(page.getByText('本机 Host 未就绪，暂时不能生成计划。')).toBeVisible();
    await expect(page.getByRole('button', { name: '生成测试计划' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '单元测试' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /传统 JUnit/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
