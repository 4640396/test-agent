import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeProjectPath, parseAllowedProjectRoots } from '../src/core/security.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('worker project path authorization', () => {
  it('allows descendants of configured roots and rejects siblings', () => {
    const parent = mkdtempSync(join(tmpdir(), 'test-agent-paths-'))
    roots.push(parent)
    const allowed = join(parent, 'allowed')
    const project = join(allowed, 'project')
    const denied = join(parent, 'denied')
    mkdirSync(project, { recursive: true })
    mkdirSync(denied)
    const configured = parseAllowedProjectRoots([allowed].join(delimiter))
    expect(authorizeProjectPath(project, configured).ok).toBe(true)
    expect(authorizeProjectPath(denied, configured)).toMatchObject({ ok: false })
  })

  it('resolves symbolic links before checking containment', () => {
    const parent = mkdtempSync(join(tmpdir(), 'test-agent-symlink-'))
    roots.push(parent)
    const allowed = join(parent, 'allowed')
    const outside = join(parent, 'outside')
    const link = join(allowed, 'escape')
    mkdirSync(allowed)
    mkdirSync(outside)
    symlinkSync(outside, link, 'junction')
    expect(authorizeProjectPath(link, parseAllowedProjectRoots(allowed))).toMatchObject({ ok: false })
  })
})
