import { describe, expect, it } from 'vitest'
import { assertInsideProject, sandboxCommandSpec, sandboxEnvironment } from '../src/core/sandbox.js'

describe('sandbox command policy', () => {
  it('allows commands inside the project root', () => {
    expect(() => sandboxCommandSpec('C:\\project', 'C:\\project\\src', 'workspace-write')).not.toThrow()
  })

  it('rejects commands outside the project root', () => {
    expect(() => assertInsideProject('C:\\project', 'C:\\other')).toThrow('Sandbox violation')
  })

  it('scrubs credential-like environment variables', () => {
    const env = sandboxEnvironment({ NODE_ENV: 'test', API_TOKEN: 'secret', HOME: 'C:\\home' })
    expect(env.NODE_ENV).toBe('test')
    expect(env.API_TOKEN).toBeUndefined()
  })
})
