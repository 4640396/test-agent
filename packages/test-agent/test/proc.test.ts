import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killProcessTree } from '../src/core/proc.js'

describe.skipIf(process.platform !== 'win32')('killProcessTree (Windows)', () => {
  it('终止根进程及其子进程树', async () => {
    const child = spawn('cmd', ['/c', 'powershell -NoProfile -Command Start-Sleep -Seconds 60'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const rootPid = child.pid
    expect(rootPid).toBeGreaterThan(0)
    await new Promise<void>((resolve) => setTimeout(resolve, 1500))
    killProcessTree(rootPid ?? 0)
    await new Promise<void>((resolve) => setTimeout(resolve, 2000))
    let alive = true
    try {
      process.kill(rootPid ?? 0, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 30000)
})
