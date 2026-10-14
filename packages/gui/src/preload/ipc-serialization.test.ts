import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { toIpcValue } from './ipc-serialization.js'

describe('toIpcValue', () => {
  it('returns detached JSON data and removes non-transport fields', () => {
    const source = {
      projectPath: 'D:/project',
      testTypes: ['ui'],
      nested: { url: 'http://127.0.0.1:4173' },
      omitted: undefined,
      callback: () => 'not cloneable',
    }

    const result = toIpcValue(source)

    expect(result).toEqual({
      projectPath: 'D:/project',
      testTypes: ['ui'],
      nested: { url: 'http://127.0.0.1:4173' },
    })
    expect(result).not.toBe(source)
    expect(result.nested).not.toBe(source.nested)
  })

  it('detaches Vue reactive proxies before Electron structured clone', () => {
    const source = reactive({
      projectPath: 'D:/project',
      testTypes: reactive(['unit', 'ui']),
      environment: reactive({ NODE_ENV: 'test' }),
    })

    const result = toIpcValue(source)

    expect(result).toEqual({
      projectPath: 'D:/project',
      testTypes: ['unit', 'ui'],
      environment: { NODE_ENV: 'test' },
    })
    expect(() => structuredClone(result)).not.toThrow()
  })
})
