import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isDirectWorkerEntry } from '../src/modes/worker-mode.js'

describe('worker entry guard', () => {
  it('starts only when the dedicated Worker file is invoked directly', () => {
    const worker = resolve('dist/modes/worker-mode.js')
    const host = resolve('out/main/host-cli.js')
    expect(isDirectWorkerEntry(pathToFileURL(worker).href, worker)).toBe(true)
    expect(isDirectWorkerEntry(pathToFileURL(host).href, host)).toBe(false)
    expect(isDirectWorkerEntry(pathToFileURL(worker).href, host)).toBe(false)
    expect(isDirectWorkerEntry(pathToFileURL(worker).href, undefined)).toBe(false)
  })
})
