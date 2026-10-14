import { describe, expect, it } from 'vitest'
import { retryStageAction, type RetryStageInput } from './retry-stage'

const base: RetryStageInput = {
  status: 'cancelled', phase: 'scout', projectReady: true, hostReady: true,
  hasScoutReport: false, plannedCaseCount: 0,
}

describe('retryStageAction', () => {
  it('offers restart after cancelling project analysis before an artifact exists', () => {
    expect(retryStageAction(base)).toBe('restart-analysis')
  })

  it('does not offer restart while analysis is still running', () => {
    expect(retryStageAction({ ...base, status: 'running' })).toBeNull()
    expect(retryStageAction({ ...base, status: 'completed' })).toBeNull()
  })

  it('continues from checkpoint artifacts after an application restart', () => {
    expect(retryStageAction({ ...base, status: undefined, phase: 'generate', plannedCaseCount: 86 })).toBe('rerun-execute')
    expect(retryStageAction({ ...base, status: undefined, phase: 'execute', plannedCaseCount: 86 })).toBe('rerun-execute')
  })

  it('requires a ready project and host', () => {
    expect(retryStageAction({ ...base, projectReady: false })).toBeNull()
    expect(retryStageAction({ ...base, hostReady: false })).toBeNull()
  })

  it('only retries later stages when their input artifact exists', () => {
    expect(retryStageAction({ ...base, phase: 'design' })).toBeNull()
    expect(retryStageAction({ ...base, phase: 'design', hasScoutReport: true })).toBe('rerun-design')
    expect(retryStageAction({ ...base, phase: 'execute', plannedCaseCount: 52 })).toBe('rerun-execute')
    expect(retryStageAction({ ...base, phase: 'fix', plannedCaseCount: 52 })).toBeNull()
  })
})
