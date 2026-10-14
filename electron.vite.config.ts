import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// Vendored from pi (MIT, Copyright (c) 2025 Mario Zechner). See packages/*/LICENSE.
// Directory-prefix aliases — Vite resolves @cxmt/pkg/subpath to packages/pkg/src/subpath.ts
const packagesRoot = resolve(process.cwd(), 'packages')
const packageAliases = {
  '@cxmt/telemetry': resolve(packagesRoot, 'telemetry/src'),
  '@cxmt/ai': resolve(packagesRoot, 'ai/src'),
  '@cxmt/agent-core': resolve(packagesRoot, 'agent-core/src'),
  '@cxmt/test-agent': resolve(packagesRoot, 'test-agent/src'),
  '@cxmt/protocol': resolve(packagesRoot, 'protocol/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { ...packageAliases } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('packages/gui/src/main/index.ts'),
          'host-cli': resolve('packages/gui/src/main/host-cli.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('packages/gui/src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('packages/gui/src/renderer'),
    plugins: [vue()],
    resolve: { alias: { '@renderer': resolve('packages/gui/src/renderer/src') } },
    build: { rollupOptions: { input: resolve('packages/gui/src/renderer/index.html') } }
  }
})
