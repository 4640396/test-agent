import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../src/core/types.js'
import type { TaskInput, EscalationReplyRequest } from '@cxmt/protocol'
import { LocalAgentHost } from '../src/modes/host-mode.js'
import { LOCAL_HOST_PROTOCOL_VERSION, type HostMessage } from '@cxmt/protocol'
import type { EscalationHandler } from '../src/core/escalation-handler.js'

class FakeAdapter implements AgentAdapter {
  readonly name = 'fake'

  async run(_input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    emit({ level: 'info', message: 'fake local run' })
    return {
      lanes: [{ type: 'unit', status: 'passed', summary: 'local run passed' }],
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases: []
    }
  }
}

async function waitForMessage(messages: HostMessage[], kind: HostMessage['kind'], timeoutMs = 5000): Promise<HostMessage> {
  const start = Date.now()
  return await new Promise<HostMessage>((resolve, reject) => {
    const check = (): void => {
      const found = messages.find((message) => message.kind === kind)
      if (found) {
        resolve(found)
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${kind}`))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

async function waitForEscalationEvent(messages: HostMessage[], timeoutMs = 5000): Promise<Extract<HostMessage, { kind: 'event' }>> {
  const start = Date.now()
  return await new Promise((resolve, reject) => {
    const check = (): void => {
      const found = messages.find((m) => m.kind === 'event' && m.event.type === 'escalation')
      if (found) {
        resolve(found as Extract<HostMessage, { kind: 'event' }>)
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for escalation event'))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

class EscalatingFakeAdapter implements AgentAdapter {
  readonly name = 'escalating-fake'
  receivedAnswer?: string

  async run(
    _input: TaskInput,
    emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
    context?: { escalationHandler?: unknown },
  ): Promise<AgentRunResult> {
    const handler = context?.escalationHandler as EscalationHandler | undefined
    if (!handler) throw new Error('no escalationHandler in context')
    const answer = await handler.ask({ role: 'reviewer', question: '继续修复?', fallback: '保守方案' })
    this.receivedAnswer = answer
    emit({ type: 'agent_start' })
    return {
      lanes: [{ type: 'unit', status: 'passed', summary: 'escalation answered' }],
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases: [],
    }
  }
}

class AutoFixFakeAdapter extends FakeAdapter {
  fixCalls = 0
  async runExecute(): Promise<AgentRunResult> {
    return { lanes: [], report: { passed: 0, failed: 1, coverage: null, failedCases: [] }, artifacts: [], fixDecision: { action: 'auto-fix', reason: '高置信诊断' }, diagnosis: { failedCases: [] } }
  }
  async runFix(): Promise<AgentRunResult> {
    this.fixCalls++
    return { lanes: [], report: { passed: 1, failed: 0, coverage: null }, artifacts: [] }
  }
}

describe('LocalAgentHost', () => {
  const dirs: string[] = []

  beforeEach(() => {
    // CI/test environment: disable DSH sandbox to avoid native FFI init delays
    process.env.TEST_AGENT_DISABLE_SANDBOX = 'true'
  })

  afterEach(() => {
    delete process.env.TEST_AGENT_DISABLE_SANDBOX
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    }
    dirs.length = 0
  })

  it('handshakes, runs an endpoint task and streams local events', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-'))
    dirs.push(projectPath)
    const allowedRoots = [realpathSync(projectPath)]
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: allowedRoots,
      createProvider: () => new FakeAdapter()
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }

    await host.handle({ id: 'h1', kind: 'handshake', protocolVersion: LOCAL_HOST_PROTOCOL_VERSION }, send)
    await host.handle({ id: 'h2', kind: 'health' }, send)
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }
    await host.handle({ id: 'r1', kind: 'run', executionId: 'exec-1', input }, send)

    const result = await waitForMessage(messages, 'run-result')
    expect(messages.some((message) => message.kind === 'run-accepted')).toBe(true)
    expect(messages.some((message) => message.kind === 'event')).toBe(true)
    expect(result).toMatchObject({ id: 'r1', kind: 'run-result', executionId: 'exec-1' })
  })

  it('rejects a task before provider startup when a required toolchain is missing', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-capability-'))
    dirs.push(projectPath)
    let providerCreated = false
    const host = new LocalAgentHost({
      capabilities: ['node', 'npm'],
      allowedProjectRoots: [realpathSync(projectPath)],
      createProvider: () => { providerCreated = true; return new FakeAdapter() }
    })
    const messages: HostMessage[] = []
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: ['unit'], requiredCapabilities: ['node', 'maven'] }
    await host.handle({ id: 'missing-tool', kind: 'run', executionId: 'exec-missing-tool', input }, (message) => { messages.push(message) })
    expect(providerCreated).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('maven') }))
  })

  it.each([
    ['go.mod', '暂未支持 Go'],
    ['pyproject.toml', '暂未支持 Python']
  ])('rejects a deferred project kind before provider startup: %s', async (manifest, expected) => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-unsupported-'))
    dirs.push(projectPath)
    writeFileSync(join(projectPath, manifest), '', 'utf8')
    let providerCreated = false
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: [realpathSync(projectPath)],
      createProvider: () => { providerCreated = true; return new FakeAdapter() }
    })
    const messages: HostMessage[] = []
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: ['unit'] }
    await host.handle({ id: 'unsupported', kind: 'run', executionId: `exec-${manifest.replace(/\W/g, '-')}`, input }, (message) => { messages.push(message) })
    expect(providerCreated).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining(expected) }))
  })

  it('rejects unknown projects and duplicated executions', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-'))
    const otherPath = mkdtempSync(join(tmpdir(), 'local-host-other-'))
    dirs.push(projectPath, otherPath)
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: [realpathSync(projectPath)],
      createProvider: () => new FakeAdapter()
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }
    const input: TaskInput = { projectPath: otherPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }

    await host.handle({ id: 'r2', kind: 'run', executionId: 'exec-2', input }, send)
    await host.handle({ id: 'r3', kind: 'run', executionId: 'exec-2', input }, send)

    expect(messages.filter((message) => message.kind === 'error')).toHaveLength(2)
  })

  it('handles escalation-reply for unknown execution with error', async () => {
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: [],
      createProvider: () => new FakeAdapter()
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }

    await host.handle(
      { id: 'er1', kind: 'escalation-reply', executionId: 'no-such-exec', escalationId: 'esc-1', answer: 'yes' },
      send,
    )

    const err = messages.find((m) => m.kind === 'error')
    expect(err).toBeDefined()
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      expect(err.id).toBe('er1')
      expect(err.message).toContain('no-such-exec')
    }
  })

  it('rejects an empty confirmed case list before starting a run', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-empty-'))
    dirs.push(projectPath)
    const host = new LocalAgentHost({ capabilities: ['node'], allowedProjectRoots: [realpathSync(projectPath)], createProvider: () => new FakeAdapter() })
    const messages: HostMessage[] = []
    await host.handle({ id: 'empty', kind: 'run', executionId: 'exec-empty', input: { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0, cases: [] } }, (m) => { messages.push(m) })
    expect(messages).toMatchObject([{ kind: 'error', message: expect.stringContaining('没有可执行用例') }])
  })

  it('rejects incomplete or duplicate confirmed cases before creating a provider', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-invalid-plan-'))
    dirs.push(projectPath)
    let providerCreated = false
    const host = new LocalAgentHost({ capabilities: ['node'], allowedProjectRoots: [realpathSync(projectPath)], createProvider: () => { providerCreated = true; return new FakeAdapter() } })
    const validCase = { id: 'TC001', title: '边界值', scenario: '输入 0', expected: '返回 false', priority: 'high', layer: 'unit', steps: [] }
    const messages: HostMessage[] = []
    await host.handle({ id: 'invalid', kind: 'run', executionId: 'exec-invalid', input: { projectPath, systemName: 'demo', version: '1', testTypes: ['unit'], coverageTarget: 0, cases: [validCase, { ...validCase, title: '重复编号' }] } }, m => { messages.push(m) })
    expect(messages).toMatchObject([{ kind: 'error', message: expect.stringContaining('编号重复') }])
    expect(providerCreated).toBe(false)
  })

  it('requires explicit approval before an auto-fix recommendation changes project code', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-fix-consent-'))
    dirs.push(projectPath)
    const adapter = new AutoFixFakeAdapter()
    const host = new LocalAgentHost({ capabilities: ['node'], allowedProjectRoots: [realpathSync(projectPath)], createProvider: () => adapter })
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: ['unit'], coverageTarget: 0, cases: [{ id: 'TC001', title: '失败用例', scenario: '运行测试', expected: '通过', priority: 'high', layer: 'unit', steps: [] }] }
    const messages: HostMessage[] = []
    await host.handle({ id: 'execute', kind: 'run', executionId: 'exec-consent', input }, m => { messages.push(m) })
    const diagnosis = await waitForMessage(messages, 'run-result')
    expect(diagnosis).toMatchObject({ phase: 'diagnosis', outcome: { fixDecision: { action: 'needs-confirm' } } })
    expect(adapter.fixCalls).toBe(0)
    messages.length = 0
    await host.handle({ id: 'approved', kind: 'run', executionId: 'exec-approved', input: { ...input, diagnosis: { failedCases: [] } } }, m => { messages.push(m) })
    await waitForMessage(messages, 'run-result')
    expect(adapter.fixCalls).toBe(1)
  })

  it('dismisses an escalation immediately through the host protocol', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-dismiss-'))
    dirs.push(projectPath)
    const adapter = new EscalatingFakeAdapter()
    const host = new LocalAgentHost({ capabilities: ['node'], allowedProjectRoots: [realpathSync(projectPath)], createProvider: () => adapter })
    const messages: HostMessage[] = []
    const send = (m: HostMessage): void => { messages.push(m) }
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }
    await host.handle({ id: 'run', kind: 'run', executionId: 'exec-dismiss', input }, send)
    const escalation = await waitForEscalationEvent(messages)
    if (escalation.event.type !== 'escalation') throw new Error('expected escalation')
    await host.handle({ id: 'dismiss', kind: 'escalation-dismiss', executionId: 'exec-dismiss', escalationId: escalation.event.escalationId }, send)
    expect(messages).toContainEqual(expect.objectContaining({ id: 'dismiss', kind: 'escalation-dismissed' }))
    await waitForMessage(messages, 'run-error')
  })

  it('routes escalation-reply to the active run handler (happy path)', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-esc-'))
    dirs.push(projectPath)
    const adapter = new EscalatingFakeAdapter()
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: [realpathSync(projectPath)],
      createProvider: () => adapter,
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }

    await host.handle({ id: 'h1', kind: 'handshake', protocolVersion: LOCAL_HOST_PROTOCOL_VERSION }, send)
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }
    await host.handle({ id: 'r1', kind: 'run', executionId: 'exec-esc', input }, send)

    const escalationEvent = await waitForEscalationEvent(messages)
    const event = escalationEvent.event
    if (event.type !== 'escalation') throw new Error('expected escalation event')
    const escalationId = event.escalationId

    const reply: EscalationReplyRequest = {
      id: 'er1',
      kind: 'escalation-reply',
      executionId: 'exec-esc',
      escalationId,
      answer: 'yes-fix-it',
    }
    await host.handle(reply, send)

    const result = await waitForMessage(messages, 'run-result')
    expect(result).toMatchObject({ id: 'r1', kind: 'run-result', executionId: 'exec-esc' })

    expect(messages.some((m) => m.kind === 'error')).toBe(false)
    expect(adapter.receivedAnswer).toBe('yes-fix-it')
  })
})
