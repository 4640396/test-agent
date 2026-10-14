import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestType } from '@cxmt/protocol'
import { inspectProjectSupport } from '@cxmt/test-agent'

export { inspectProjectSupport }

/** Infer a safe default matrix; users can still add or remove lanes before execution. */
export function detectTestTypes(projectPath: string): TestType[] {
  const hasPlaywright = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
    .some((name) => existsSync(join(projectPath, name)))
  if (hasPlaywright) return ['unit', 'ui']
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some((name) => existsSync(join(projectPath, name)))) return ['unit', 'regression']
  if (existsSync(join(projectPath, 'package.json'))) {
    const isFrontend = ['index.html', 'vite.config.ts', 'vite.config.js', 'vue.config.js', 'webpack.config.js']
      .some((name) => existsSync(join(projectPath, name)))
    return isFrontend ? ['unit', 'ui'] : ['unit']
  }
  return ['unit']
}

/** Capabilities a worker must actually have for this project's default test matrix. */
export function detectRequiredCapabilities(projectPath: string, testTypes: readonly TestType[] = detectTestTypes(projectPath)): string[] {
  const required = new Set<string>()
  if (existsSync(join(projectPath, 'package.json'))) {
    required.add('node')
    let declared = ''
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as { packageManager?: string }
      declared = pkg.packageManager?.split('@')[0]?.toLowerCase() ?? ''
    } catch { /* malformed manifests fail later with an actionable test error */ }
    if (declared === 'pnpm' || existsSync(join(projectPath, 'pnpm-lock.yaml'))) required.add('pnpm')
    else if (declared === 'yarn' || existsSync(join(projectPath, 'yarn.lock'))) required.add('yarn')
    else if (declared === 'bun' || existsSync(join(projectPath, 'bun.lock')) || existsSync(join(projectPath, 'bun.lockb'))) required.add('bun')
    else required.add('npm')
  }
  if (existsSync(join(projectPath, 'pom.xml'))) {
    required.add('java')
    if (!existsSync(join(projectPath, 'mvnw')) && !existsSync(join(projectPath, 'mvnw.cmd'))) required.add('maven')
  }
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    required.add('java')
    if (!existsSync(join(projectPath, 'gradlew')) && !existsSync(join(projectPath, 'gradlew.bat'))) required.add('gradle')
  }
  if (testTypes.includes('ui')) required.add('playwright')
  return [...required]
}
