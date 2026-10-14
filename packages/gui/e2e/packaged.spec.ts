import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const appPath = resolve('build-output/win-unpacked/Test Agent.exe')

test('打包后的桌面程序能打开工作台', async () => {
  test.skip(!existsSync(appPath), '先运行 npm run dist 构建安装包')
  const dataDir = mkdtempSync(join(tmpdir(), 'test-agent-packaged-smoke-'))
  const app = await electron.launch({
    executablePath: appPath,
    env: { ...process.env, APPDATA: dataDir, ELECTRON_RENDERER_URL: '' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: '首页' })).toBeVisible()
  } finally {
    await app.close()
    if (resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) rmSync(dataDir, { recursive: true, force: true })
  }
})
