import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureRunProvenance } from '../src/core/run-provenance.js'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-agent-provenance-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
  return root
}

function input(projectPath: string) {
  return { projectPath, systemName: 'fixture', version: '1', testTypes: ['unit' as const], apiBaseUrl: 'http://127.0.0.1:8080' }
}

describe('captureRunProvenance', () => {
  it('captures a clean Git commit and run context', () => {
    const root = project()
    execFileSync('git', ['init'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test Agent'], { cwd: root })
    execFileSync('git', ['add', 'package.json'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
    const capturedAt = new Date('2026-10-13T01:02:03.000Z')

    const result = captureRunProvenance(input(root), capturedAt)

    expect(result.gitCommitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.gitDirty).toBe(false)
    expect(result.projectType).toBe('node')
    expect(result.executionEnvironment).toContain(`Node ${process.version}`)
    expect(result.targetUrl).toBe('http://127.0.0.1:8080')
    expect(result.capturedAt).toBe(capturedAt.toISOString())
  })

  it('marks tracked and untracked changes as dirty', () => {
    const root = project()
    execFileSync('git', ['init'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test Agent'], { cwd: root })
    execFileSync('git', ['add', 'package.json'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
    writeFileSync(join(root, 'untracked.txt'), 'dirty')

    expect(captureRunProvenance(input(root)).gitDirty).toBe(true)
  })

  it('reports null Git fields for a non-Git Maven project', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-agent-provenance-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'pom.xml'), '<project/>')

    const result = captureRunProvenance({ ...input(root), apiBaseUrl: undefined, uiEntryUrl: 'http://127.0.0.1:4173' })

    expect(result.gitCommitSha).toBeNull()
    expect(result.gitDirty).toBeNull()
    expect(result.projectType).toBe('maven')
    expect(result.targetUrl).toBe('http://127.0.0.1:4173')
  })
})
