import { describe, expect, it } from 'vitest'
import { taskJourney, type JourneyInput } from './task-journey'

const base: JourneyInput = {
  hasTask: true,
  phase: 'scout',
  taskActive: true,
  planPending: false,
  executionConfirmed: false,
  requiresGeneration: true,
  hasScoutReport: false,
  plannedCaseCount: 0,
  executionResult: null,
  hasReport: false,
  terminalStatus: null,
}

describe('taskJourney', () => {
  it('shows project analysis first, without claiming a plan exists', () => {
    expect(taskJourney(base).map((step) => step.status)).toEqual(['active', 'waiting', 'waiting', 'waiting', 'waiting'])
  })

  it('requires human confirmation before execution', () => {
    expect(taskJourney({ ...base, phase: 'execute', hasScoutReport: true, plannedCaseCount: 52, planPending: true }).map((step) => step.status))
      .toEqual(['done', 'attention', 'waiting', 'waiting', 'waiting'])
  })

  it('does not start execution merely because an internal planning event set phase to execute', () => {
    expect(taskJourney({ ...base, phase: 'execute', hasScoutReport: true, plannedCaseCount: 52 }).map((step) => step.status))
      .toEqual(['done', 'active', 'waiting', 'waiting', 'waiting'])
  })

  it('shows test generation as a distinct active phase before execution', () => {
    expect(taskJourney({ ...base, phase: 'generate', executionConfirmed: true, plannedCaseCount: 3 }).map((step) => step.status))
      .toEqual(['done', 'done', 'active', 'waiting', 'waiting'])
  })

  it('moves directly from successful execution to report generation', () => {
    expect(taskJourney({ ...base, phase: 'execute', executionConfirmed: true, plannedCaseCount: 2, executionResult: { passed: 2, failed: 0 } }).map((step) => step.status))
      .toEqual(['done', 'done', 'done', 'done', 'waiting'])
  })

  it('shows failure diagnosis inside the execution milestone', () => {
    const steps = taskJourney({ ...base, phase: 'fix', executionConfirmed: true, plannedCaseCount: 2, executionResult: { passed: 1, failed: 1 } })
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'active', 'waiting'])
    expect(steps[3].detail).toContain('正在诊断')
  })

  it('does not report success after interruption', () => {
    expect(taskJourney({ ...base, phase: 'execute', executionConfirmed: true, plannedCaseCount: 2, taskActive: false, terminalStatus: 'failed' }).map((step) => step.status))
      .toEqual(['done', 'done', 'done', 'blocked', 'waiting'])
  })

  it('shows a historical report as generated, not as a running task', () => {
    expect(taskJourney({ ...base, hasTask: true, taskActive: false, phase: '', hasReport: true, executionResult: { passed: 2, failed: 0 } }).map((step) => step.status))
      .toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('does not turn an empty report into zero passed and zero failed', () => {
    const steps = taskJourney({ ...base, phase: 'execute', executionConfirmed: true, plannedCaseCount: 3, taskActive: false, hasReport: true, executionResult: null })
    expect(steps[3]).toMatchObject({ status: 'attention', detail: '未产生可核验的测试结果' })
    expect(steps[4].status).toBe('done')
  })

  it('skips code generation for reflection scenarios without adding another stage', () => {
    const steps = taskJourney({ ...base, phase: 'execute', executionConfirmed: true, requiresGeneration: false, plannedCaseCount: 2 })
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'skipped', 'active', 'waiting'])
    expect(steps[2].detail).toContain('无需生成测试代码')
  })
})
