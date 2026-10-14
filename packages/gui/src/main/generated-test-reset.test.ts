import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyGeneratedTestFiles, removeGeneratedTestFiles } from './generated-test-reset.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('generated test reset', () => {
  it('removes only untracked tests linked to stored Test Agent cases', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-agent-reset-'))
    dirs.push(root)
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    const testDir = join(root, 'src', 'test', 'java', 'sample')
    mkdirSync(testDir, { recursive: true })
    const generated = join(testDir, 'GeneratedTest.java')
    const tracked = join(testDir, 'TrackedTest.java')
    const unrelated = join(testDir, 'UserDraftTest.java')
    writeFileSync(generated, '// 用例 abcdef0123456789\nclass GeneratedTest {}')
    writeFileSync(tracked, '// 用例 abcdef0123456789\nclass TrackedTest {}')
    writeFileSync(unrelated, 'class UserDraftTest {}')
    execFileSync('git', ['add', 'src/test/java/sample/TrackedTest.java'], { cwd: root })

    const preview = classifyGeneratedTestFiles(root, ['abcdef0123456789'])
    expect(preview.removableFiles).toEqual(['src/test/java/sample/GeneratedTest.java'])
    expect(preview.protectedFiles).toEqual(['src/test/java/sample/TrackedTest.java'])

    const result = removeGeneratedTestFiles(root, preview)
    expect(result.removedFiles).toEqual(preview.removableFiles)
    expect(existsSync(generated)).toBe(false)
    expect(existsSync(tracked)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })
})
