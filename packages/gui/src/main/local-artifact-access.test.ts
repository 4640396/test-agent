import { describe, expect, it } from 'vitest'
import { isAllowedLocalArtifact } from './local-artifact-access.js'

const canonicalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()

describe('local artifact protocol access', () => {
  it('allows report media only in approved artifact directories', () => {
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/.test-agent/screenshots/home.png', canonicalize)).toBe(true)
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/test-results/run/trace.zip', canonicalize)).toBe(true)
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/src/passwords.png', canonicalize)).toBe(false)
  })

  it('blocks traversal, another project, and unsupported file types', () => {
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/secret/.test-agent/shot.png', canonicalize)).toBe(false)
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/.test-agent/report.html', canonicalize)).toBe(false)
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/.test-agent/../../secret.png', canonicalize)).toBe(false)
  })

  it('uses canonical paths so a symlink escape is rejected', () => {
    const realpath = (value: string) => canonicalize(value).includes('/linked/') ? 'c:/outside/secret.png' : canonicalize(value)
    expect(isAllowedLocalArtifact(['C:/projects/app'], 'C:/projects/app/.test-agent/linked/secret.png', realpath)).toBe(false)
  })
})
