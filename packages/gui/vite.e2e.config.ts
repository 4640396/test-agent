import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

/** Browser-only renderer server; no Electron process or native preload is needed for mocked E2E tests. */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [vue()],
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
