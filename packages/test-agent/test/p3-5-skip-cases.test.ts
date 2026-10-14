import { describe, expect, it } from 'vitest'
import type { TaskInput } from '@cxmt/test-agent/protocol'

/**
 * P3-5：skipCaseIds 过滤逻辑单元测试。
 *
 * runner.ts 在 computeExecutionCases 后过滤 input.skipCaseIds，
 * 这里测试过滤逻辑的正确性（不启动完整 runner，只验 filter 行为）。
 */
describe('P3-5 skipCaseIds filtering', () => {
  it('filters out cases whose id is in skipCaseIds', () => {
    const cases = [
      { id: 'TC001', title: 'case A', layer: 'unit', scenario: 'test A', expected: 'pass' },
      { id: 'TC002', title: 'case B', layer: 'unit', scenario: 'test B', expected: 'pass' },
      { id: 'TC003', title: 'case C', layer: 'unit', scenario: 'test C', expected: 'pass' },
    ]
    const skipCaseIds = ['TC002']
    const userSkipIds = new Set(skipCaseIds)
    const filtered = cases.filter((c) => !userSkipIds.has(c.id))
    expect(filtered).toHaveLength(2)
    expect(filtered.map((c) => c.id)).toEqual(['TC001', 'TC003'])
  })

  it('handles empty skipCaseIds (no filtering)', () => {
    const cases = [
      { id: 'TC001', title: 'case A', layer: 'unit', scenario: 'test A', expected: 'pass' },
    ]
    const userSkipIds = new Set<string>()
    const filtered = cases.filter((c) => !userSkipIds.has(c.id))
    expect(filtered).toHaveLength(1)
  })

  it('handles undefined skipCaseIds in TaskInput (backward compatible)', () => {
    const input: TaskInput = {
      projectPath: '/project',
      systemName: 'test',
      version: '1.0',
      testTypes: ['unit'],
    }
    const userSkipIds = new Set(input.skipCaseIds ?? [])
    expect(userSkipIds.size).toBe(0)
  })

  it('skips all cases when all ids are in skipCaseIds', () => {
    const cases = [
      { id: 'TC001', title: 'case A', layer: 'unit', scenario: 'test A', expected: 'pass' },
      { id: 'TC002', title: 'case B', layer: 'unit', scenario: 'test B', expected: 'pass' },
    ]
    const skipCaseIds = ['TC001', 'TC002']
    const userSkipIds = new Set(skipCaseIds)
    const filtered = cases.filter((c) => !userSkipIds.has(c.id))
    expect(filtered).toHaveLength(0)
  })

  it('TaskInput accepts optional skipCaseIds field', () => {
    const input: TaskInput = {
      projectPath: '/project',
      systemName: 'test',
      version: '1.0',
      testTypes: ['unit'],
      skipCaseIds: ['TC001', 'TC002'],
    }
    expect(input.skipCaseIds).toEqual(['TC001', 'TC002'])
  })
})
