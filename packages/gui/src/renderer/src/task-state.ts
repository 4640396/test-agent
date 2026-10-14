import type { TestType } from '@cxmt/protocol'
import type { LaneState, TaskSnapshot } from '../../types.js'

export const laneLabels: Record<TestType, string> = {
  unit: '单元测试',
  regression: '回归测试',
  ui: 'UI 测试',
  api: '接口测试'
}

export function emptyLanes(types: TestType[]): LaneState[] {
  return types.map((type) => ({ type, status: 'pending', summary: '等待执行' }))
}

export function progressOf(snapshot: TaskSnapshot | null): number {
  if (!snapshot) return 0
  if (snapshot.status === 'completed') return 100
  if (snapshot.lanes.length === 0) return 0
  const passed = snapshot.lanes.filter((lane) => lane.status === 'passed').length
  return Math.round((passed / snapshot.lanes.length) * 100)
}
