import { describe, expect, it } from 'vitest'
import { configuredCapabilities, detectExecutionCapabilities } from '../src/modes/capabilities.js'

describe('worker capabilities', () => {
  it('advertises only installed package and JVM tools', () => {
    const installed = new Set(['npm.cmd', 'java.exe', 'mvn.cmd'])
    const result = detectExecutionCapabilities('win32', (command) => installed.has(command), () => true)
    expect(result).toEqual(expect.arrayContaining(['windows', 'node', 'playwright', 'npm', 'java', 'maven']))
    expect(result).not.toEqual(expect.arrayContaining(['pnpm', 'yarn', 'bun']))
    expect(result).not.toContain('go')
  })

  it('does not advertise Playwright when no launchable browser is installed', () => {
    expect(detectExecutionCapabilities('win32', () => true, () => false)).not.toContain('playwright')
  })

  it('honors an explicit production capability allowlist', () => {
    expect(configuredCapabilities('linux,node,npm,java,maven')).toEqual(['linux', 'node', 'npm', 'java', 'maven'])
  })
})
