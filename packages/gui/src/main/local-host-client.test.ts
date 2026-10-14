import { describe, expect, it } from 'vitest'
import type { TaskInput, HostMessage } from '@cxmt/protocol'
import { LocalHostClient, normalizeRunTerminalMessage, writeDiagnostic, type LocalHostIO } from './local-host-client.js'
import { Writable } from 'node:stream'

class FakeIO implements LocalHostIO {
  readonly writes: string[] = []
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()

  write(line: string): void {
    this.writes.push(line)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => { this.lineListeners.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  push(message: HostMessage): void {
    for (const listener of this.lineListeners) listener(JSON.stringify(message))
  }
}

describe('LocalHostClient', () => {
  it('does not crash the main process when a diagnostic pipe is already closed', () => {
    const closedStream = new Writable({ write: (_chunk, _encoding, callback) => callback() }) as NodeJS.WriteStream
    closedStream.destroy()
    expect(() => writeDiagnostic(closedStream, 'late host diagnostic')).not.toThrow()
  })

  it('does not crash the main process when a diagnostic write throws synchronously', () => {
    const brokenStream = {
      destroyed: false,
      writable: true,
      write: () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) },
    } as unknown as NodeJS.WriteStream
    expect(() => writeDiagnostic(brokenStream, 'late host diagnostic')).not.toThrow()
  })

  it('waits for host acknowledgement before treating an escalation as dismissed', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const pending = client.dismissEscalation('exec-1', 'esc-1')
    const request = JSON.parse(io.writes[0]) as { id: string; kind: string }
    expect(request.kind).toBe('escalation-dismiss')
    io.push({ id: request.id, kind: 'escalation-dismissed', executionId: 'exec-1', escalationId: 'esc-1' })
    await expect(pending).resolves.toBe(true)
  })
  it('correlates a handshake response by request id', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const promise = client.handshake()
    const request = JSON.parse(io.writes[0]) as { id: string; kind: string }

    io.push({ id: request.id, kind: 'handshake', ok: true, protocolVersion: 1, hostVersion: '0.1.0' })

    await expect(promise).resolves.toMatchObject({ id: request.id, kind: 'handshake', ok: true })
  })

  it('streams run messages and resolves only on the terminal run message', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const received: HostMessage[] = []
    client.onMessage((message) => received.push(message))
    const input: TaskInput = { projectPath: 'C:/tmp/project', systemName: 'demo', version: '1', testTypes: [] }
    const promise = client.run(input, 'exec-1')
    const request = JSON.parse(io.writes[0]) as { id: string }

    io.push({ id: request.id, kind: 'run-accepted', executionId: 'exec-1' })
    io.push({ id: request.id, kind: 'event', executionId: 'exec-1', event: { type: 'log', level: 'info', message: 'running' } })

    let resolved = false
    void promise.then(() => { resolved = true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    expect(resolved).toBe(false)

    io.push({ id: request.id, kind: 'run-result', executionId: 'exec-1', outcome: { ok: true } })
    await expect(promise).resolves.toMatchObject({ kind: 'run-result', executionId: 'exec-1' })
    expect(received.map((message) => message.kind)).toEqual(['run-accepted', 'event', 'run-result'])
  })

  it('resolves an immediate host validation error instead of waiting for the one-hour run timeout', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const promise = client.run({ projectPath: 'C:/tmp/project', systemName: 'demo', version: '1', testTypes: ['unit'] }, 'exec-invalid')
    const request = JSON.parse(io.writes[0]) as { id: string }
    io.push({ id: request.id, kind: 'error', message: '本机缺少任务所需工具链：maven' })
    await expect(promise).resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('maven') })
  })

  it('converts a pre-accept validation error into a task-scoped run error for the renderer', () => {
    expect(normalizeRunTerminalMessage({ id: 'request-1', kind: 'error', message: '缺少 maven' }, 'execution-1')).toEqual({
      id: 'request-1',
      kind: 'run-error',
      executionId: 'execution-1',
      error: '缺少 maven',
      cancelled: false
    })
  })
})
