import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { detectRequiredCapabilities, detectTestTypes, inspectProjectSupport } from './project-detection.js'

const roots: string[] = []
function project(files: string[]): string {
  const root = join(tmpdir(), `test-agent-detect-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  for (const file of files) writeFileSync(join(root, file), '', 'utf8')
  roots.push(root)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('project test-matrix detection', () => {
  it('selects both unit and UI lanes for frontend projects', () => {
    expect(detectTestTypes(project(['package.json', 'vite.config.ts']))).toEqual(['unit', 'ui'])
    expect(detectTestTypes(project(['package.json', 'playwright.config.ts']))).toEqual(['unit', 'ui'])
  })

  it.each(['pom.xml', 'build.gradle', 'build.gradle.kts'])('selects JVM unit and regression lanes for %s', (buildFile) => {
    expect(detectTestTypes(project([buildFile]))).toEqual(['unit', 'regression'])
  })

  it('keeps server-side Node projects on the unit lane', () => {
    expect(detectTestTypes(project(['package.json']))).toEqual(['unit'])
  })

  it('requires the package manager declared by the project and Playwright for UI', () => {
    const root = project(['package.json', 'vite.config.ts', 'pnpm-lock.yaml'])
    expect(detectRequiredCapabilities(root, ['unit', 'ui'])).toEqual(expect.arrayContaining(['node', 'pnpm', 'playwright']))
    expect(detectRequiredCapabilities(root, ['unit', 'ui'])).not.toContain('npm')
  })

  it('requires global Maven only when the project has no wrapper', () => {
    expect(detectRequiredCapabilities(project(['pom.xml']), ['unit'])).toEqual(expect.arrayContaining(['java', 'maven']))
    expect(detectRequiredCapabilities(project(['pom.xml', 'mvnw.cmd']), ['unit'])).toEqual(['java'])
  })

  it('reports the supported production project kinds without guessing unknown directories', () => {
    expect(inspectProjectSupport(project(['package.json']))).toMatchObject({ kind: 'node', supported: true })
    expect(inspectProjectSupport(project(['pom.xml']))).toMatchObject({ kind: 'maven', supported: true })
    expect(inspectProjectSupport(project(['package.json', 'pom.xml']))).toMatchObject({ kind: 'mixed', supported: true })
    expect(inspectProjectSupport(project([]))).toMatchObject({ kind: 'unknown', supported: false })
  })

  it('marks deferred Go and Python projects unsupported with an actionable reason', () => {
    expect(inspectProjectSupport(project(['go.mod']))).toMatchObject({ kind: 'go', supported: false, reason: expect.stringContaining('暂未支持 Go') })
    expect(inspectProjectSupport(project(['pyproject.toml']))).toMatchObject({ kind: 'python', supported: false, reason: expect.stringContaining('暂未支持 Python') })
  })
})
