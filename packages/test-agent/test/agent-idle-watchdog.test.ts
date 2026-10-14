import { describe, expect, it, vi } from 'vitest'
import { runAgentWithIdleWatchdog } from '../src/core/agent-idle-watchdog.js'

function fakeAgent(abortReleases = true) {
  let listener: ((event: string) => void) | undefined
  let release: (() => void) | undefined
  return {
    agent: {
      subscribe: vi.fn((next: (event: string) => void) => { listener = next; return () => { listener = undefined } }),
      prompt: vi.fn(async () => {}),
      waitForIdle: vi.fn(() => new Promise<void>(resolve => { release = resolve })),
      abort: vi.fn(() => { if (abortReleases) release?.() }),
    },
    event: (value: string) => listener?.(value),
    release: () => release?.(),
  }
}

describe('runAgentWithIdleWatchdog', () => {
  it('aborts and reports a useful error after the idle deadline', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeAgent(false)
      const run = runAgentWithIdleWatchdog({
        agent: fake.agent,
        prompt: 'plan',
        onEvent: vi.fn(),
        timeoutMs: 180_000,
        timeoutMessage: '用例设计阶段连续 3 分钟没有新事件',
      })
      const rejection = expect(run).rejects.toThrow('用例设计阶段连续 3 分钟没有新事件')
      await vi.advanceTimersByTimeAsync(180_000)
      await rejection
      expect(fake.agent.abort).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the deadline whenever the agent emits progress', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeAgent()
      const run = runAgentWithIdleWatchdog({ agent: fake.agent, prompt: 'plan', onEvent: vi.fn(), timeoutMs: 100, timeoutMessage: 'timeout' })
      await vi.advanceTimersByTimeAsync(80)
      fake.event('progress')
      await vi.advanceTimersByTimeAsync(80)
      expect(fake.agent.abort).not.toHaveBeenCalled()
      fake.release()
      await run
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses the idle deadline while waiting for human escalation input', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeAgent()
      let awaitingHuman = true
      const run = runAgentWithIdleWatchdog({
        agent: fake.agent,
        prompt: 'execute',
        onEvent: vi.fn(),
        timeoutMs: 100,
        timeoutMessage: 'timeout',
        isPaused: () => awaitingHuman,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(fake.agent.abort).not.toHaveBeenCalled()
      awaitingHuman = false
      await vi.advanceTimersByTimeAsync(99)
      expect(fake.agent.abort).not.toHaveBeenCalled()
      fake.release()
      await run
    } finally {
      vi.useRealTimers()
    }
  })
})
