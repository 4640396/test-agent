import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { LOCAL_HOST_PROTOCOL_VERSION, type ClientMessage, type EscalationReplyRequest, type HostMessage, type TaskInput } from '@cxmt/protocol'

export interface LocalHostIO {
  write(line: string): void
  close(): void
  onLine(listener: (line: string) => void): () => void
  onClose(listener: () => void): () => void
}

/**
 * Electron may inherit stdout/stderr from a launcher (Playwright, terminal, updater).
 * That launcher can close its pipe before the app/host sidecar finishes shutting down.
 * Diagnostic forwarding must never turn that normal teardown race into an uncaught EPIPE.
 */
export function writeDiagnostic(stream: NodeJS.WriteStream, chunk: string): void {
  if (stream.destroyed || !stream.writable) return
  try {
    stream.write(chunk, () => { /* A diagnostic sink failure is non-fatal. */ })
  } catch {
    // Ignore synchronous EPIPE/destroyed-stream failures as well. There is no safe
    // fallback sink at this point, and crashing the main process would be worse.
  }
}

interface PendingRequest {
  predicate: (message: HostMessage) => boolean
  resolve: (message: HostMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Minimal client for the local Host Sidecar over a newline-delimited JSON stream. */
export class LocalHostClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private sequence = 0

  constructor(private readonly io: LocalHostIO) {
    io.onLine((line) => this.handleLine(line))
    io.onClose(() => this.failAll(new Error('Local host closed')))
  }

  nextId(): string {
    this.sequence += 1
    return `r${this.sequence}-${randomUUID().slice(0, 8)}`
  }

  close(): void {
    this.io.close()
  }

  onMessage(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  handshake(): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'handshake', protocolVersion: LOCAL_HOST_PROTOCOL_VERSION },
      (message) => message.kind === 'handshake'
    )
  }

  health(): Promise<HostMessage> {
    return this.request({ id: this.nextId(), kind: 'health' }, (message) => message.kind === 'health')
  }

  cancel(executionId: string): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'cancel', executionId },
      (message) => message.kind === 'cancelled' || message.kind === 'error'
    )
  }

  /** 发送 escalation 答复到 host-cli 子进程（不等待回复，fire-and-forget）。 */
  sendEscalationReply(executionId: string, escalationId: string, answer: string): void {
    const msg: EscalationReplyRequest = { id: this.nextId(), kind: 'escalation-reply', executionId, escalationId, answer }
    this.io.write(JSON.stringify(msg))
  }

  dismissEscalation(executionId: string, escalationId: string): Promise<boolean> {
    return this.request(
      { id: this.nextId(), kind: 'escalation-dismiss', executionId, escalationId },
      (message) => message.kind === 'escalation-dismissed' || message.kind === 'error'
    ).then((message) => message.kind === 'escalation-dismissed')
  }

  run(input: TaskInput, executionId: string): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'run', executionId, input },
      (message) => message.kind === 'error' || ((message.kind === 'run-result' || message.kind === 'run-error') && message.executionId === executionId),
      3_600_000
    )
  }

  private request(message: ClientMessage, predicate: (message: HostMessage) => boolean, timeoutMs = 10_000): Promise<HostMessage> {
    return new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`${message.kind} request timed out`))
      }, timeoutMs)
      this.pending.set(message.id, { predicate, resolve, reject, timer })
      this.io.write(JSON.stringify(message))
    })
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    let message: HostMessage
    try {
      message = JSON.parse(line) as HostMessage
    } catch {
      return
    }
    for (const listener of this.listeners) {
      try { listener(message) } catch { /* A faulty observer must not break the transport. */ }
    }
    const pending = this.pending.get(message.id)
    if (pending && pending.predicate(message)) {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

/** Attach the desktop execution id to pre-accept validation errors so the renderer can finish the correct task. */
export function normalizeRunTerminalMessage(message: HostMessage, executionId: string): HostMessage {
  return message.kind === 'error'
    ? { id: message.id, kind: 'run-error', executionId, error: message.message, cancelled: false }
    : message
}

export function createStdioHostIO(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): LocalHostIO {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as ChildProcessByStdio<Writable, Readable, Readable>
  // 记录 PID 用于退出时杀整个进程树（Windows child.kill 不杀孙进程）
  const childPid = child.pid ?? 0
  let buffer = ''
  const lineListeners = new Set<(line: string) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false
  let closeNotified = false
  const notifyClosed = (): void => {
    closed = true
    if (closeNotified) return
    closeNotified = true
    for (const listener of closeListeners) listener()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') {
        for (const listener of lineListeners) listener(line)
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { writeDiagnostic(process.stderr, chunk) })
  child.stdin.on('error', notifyClosed)
  child.on('error', notifyClosed)
  child.on('close', notifyClosed)

  return {
    write: (line) => {
      if (closed || child.stdin.destroyed || !child.stdin.writable) return
      try {
        child.stdin.write(`${line}\n`, (error) => { if (error) notifyClosed() })
      } catch {
        notifyClosed()
      }
    },
    close: () => {
      closed = true
      // Windows 上 child.kill() 只杀直接子进程，不杀孙进程（host-cli spawn 的 node worker）。
      // 用 taskkill /T /F 杀整个进程树，确保测试运行中关闭也能清干净。
      if (process.platform === 'win32' && childPid) {
        try { execFileSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 进程可能已退出 */ }
      }
      try { child.kill() } catch { /* 已退出 */ }
    },
    onLine: (listener) => {
      lineListeners.add(listener)
      return () => { lineListeners.delete(listener) }
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    }
  }
}
