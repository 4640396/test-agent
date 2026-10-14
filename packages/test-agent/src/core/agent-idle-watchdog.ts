export interface WatchdogAgent<Event = unknown> {
  subscribe(listener: (event: Event) => void): () => void
  prompt(prompt: string): Promise<void>
  waitForIdle(): Promise<void>
  abort(): void
}

export interface AgentIdleWatchdogOptions<Event = unknown> {
  agent: WatchdogAgent<Event>
  prompt: string
  onEvent: (event: Event) => void
  signal?: AbortSignal
  timeoutMs: number
  timeoutMessage: string
  onTimeout?: () => void
  /** Human-in-the-loop waits are intentional idle time and must not consume the deadline. */
  isPaused?: () => boolean
}

/** Run an Agent while treating every emitted event as an idle-heartbeat. */
export async function runAgentWithIdleWatchdog<Event>(options: AgentIdleWatchdogOptions<Event>): Promise<void> {
  const { agent, prompt, onEvent, signal, timeoutMs, timeoutMessage, onTimeout, isPaused } = options
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectTimeout: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
  const arm = (delayMs = timeoutMs): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (isPaused?.()) {
        arm(Math.min(1_000, timeoutMs))
        return
      }
      timedOut = true
      onTimeout?.()
      agent.abort()
      rejectTimeout?.(new Error(timeoutMessage))
    }, delayMs)
  }
  const unsubscribe = agent.subscribe((event) => {
    arm()
    onEvent(event)
  })
  const abortFromParent = (): void => agent.abort()
  signal?.addEventListener('abort', abortFromParent, { once: true })
  arm()
  const agentWork = (async () => {
    await agent.prompt(prompt)
    await agent.waitForIdle()
  })()
  // If timeout wins, Agent internals may settle later. Keep that late rejection
  // handled without making Host terminal delivery wait for it.
  void agentWork.catch(() => {})
  try {
    await Promise.race([agentWork, timeoutPromise])
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    unsubscribe()
    signal?.removeEventListener('abort', abortFromParent)
  }
  if (timedOut) throw new Error(timeoutMessage)
}
