import { defineConfig } from "@playwright/test";

/**
 * GUI e2e 测试配置
 * 用 Edge channel（Chromium 内核），避免 playwright 下载 chromium
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  use: {
    channel: "msedge", // 用系统 Edge，不下载 chromium
    headless: true,
    viewport: { width: 1400, height: 900 },
    actionTimeout: 10000,
  },
  webServer: {
    command: "npx vite --config vite.e2e.config.ts",
    url: "http://127.0.0.1:5173/",
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: [["list"]],
});
