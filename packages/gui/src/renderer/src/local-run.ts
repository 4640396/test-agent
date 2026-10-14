import type { TaskInput } from '@cxmt/protocol'

export interface LocalRunStartResult { taskId: string }

/** contextBridge clones arguments before preload code runs, so detach proxies here. */
export function toLocalRunInput(input: TaskInput): TaskInput {
  return JSON.parse(JSON.stringify(input)) as TaskInput
}

/** Reserve the id before starting so early Host messages are correlated. */
export async function startReservedLocalRun(
  input: TaskInput,
  start: (input: TaskInput, executionId: string) => Promise<LocalRunStartResult>,
  setCurrentTaskId: (executionId: string) => void,
  createExecutionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<LocalRunStartResult> {
  const executionId = createExecutionId()
  setCurrentTaskId(executionId)
  const result = await start(toLocalRunInput(input), executionId)
  if (result.taskId !== executionId) setCurrentTaskId(result.taskId)
  return result
}
