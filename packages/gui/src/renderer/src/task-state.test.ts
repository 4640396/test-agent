import { describe, expect, it } from 'vitest'
import { emptyLanes, progressOf } from './task-state'

describe('task state', () => {
  it('creates one lane per selected test type', () => {
    expect(emptyLanes(['unit', 'ui']).map((lane) => lane.type)).toEqual(['unit', 'ui'])
  })

  it('reports completed tasks as 100 percent', () => {
    expect(progressOf({ taskId: '1', status: 'completed', logs: [], lanes: [], artifacts: [] })).toBe(100)
  })
})
