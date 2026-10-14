import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type { TaskInput } from '@cxmt/protocol'
import { startReservedLocalRun } from './local-run.js'

const input: TaskInput = {
  projectPath: 'D:/project', systemName: 'demo', version: '1', testTypes: ['unit']
}

describe('startReservedLocalRun', () => {
  it('publishes the execution id before the Host start can emit messages', async () => {
    const order: string[] = []
    const setCurrentTaskId = vi.fn((id: string) => order.push(`id:${id}`))
    const start = vi.fn(async (_input: TaskInput, id: string) => {
      order.push(`start:${id}`)
      return { taskId: id }
    })

    await startReservedLocalRun(input, start, setCurrentTaskId, () => 'plan-task')

    expect(order).toEqual(['id:plan-task', 'start:plan-task'])
    expect(start).toHaveBeenCalledWith(input, 'plan-task')
  })

  it('adopts a different id returned by the main process defensively', async () => {
    const ids: string[] = []
    await startReservedLocalRun(input, async () => ({ taskId: 'host-task' }), id => ids.push(id), () => 'reserved-task')
    expect(ids).toEqual(['reserved-task', 'host-task'])
  })

  it('detaches Vue proxies before crossing contextBridge', async () => {
    const reactiveInput = reactive({
      ...input,
      testTypes: reactive(['unit', 'ui'] as const),
      environment: reactive({ NODE_ENV: 'test' }),
    }) as unknown as TaskInput
    let received: TaskInput | undefined

    await startReservedLocalRun(reactiveInput, async (value, id) => {
      received = value
      expect(() => structuredClone(value)).not.toThrow()
      return { taskId: id }
    }, () => {}, () => 'proxy-safe-task')

    expect(received).toEqual({
      ...input,
      testTypes: ['unit', 'ui'],
      environment: { NODE_ENV: 'test' },
    })
    expect(received).not.toBe(reactiveInput)
  })
})
