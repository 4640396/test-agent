import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Vendored from pi (MIT, Copyright (c) 2025 Mario Zechner). See packages/*/LICENSE.
// Directory-prefix aliases — Vite resolves @cxmt/pkg/subpath to packages/pkg/src/subpath.ts
const packagesRoot = resolve(process.cwd(), 'packages')
const packageAliases = {
  '@cxmt/telemetry': resolve(packagesRoot, 'telemetry/src'),
  '@cxmt/ai': resolve(packagesRoot, 'ai/src'),
  '@cxmt/agent-core': resolve(packagesRoot, 'agent-core/src')
}

export default defineConfig({
  resolve: {
    alias: { ...packageAliases }
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 60_000,
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'out/**'],
    // 慢测试（impact.test.ts 真实 git subprocess 90s）致 worker RPC onTaskUpdate 超时 exit 1。
    // singleFork 单进程跑无 worker RPC 通信，止血（根治需 impact mock git 或分离慢测试，二期）。
    poolOptions: { forks: { singleFork: true } },
  }
})
