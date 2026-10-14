import { describe, expect, it } from 'vitest'
import { mapCoreQualityGate } from './quality-gate-view'

describe('quality gate view mapping', () => {
  it('preserves authoritative target, coverage, status, and blockers', () => {
    expect(mapCoreQualityGate({
      status: 'failed', summary: '发布阻断', coverageTarget: 85, coverage: 82,
      blockingReasons: ['覆盖率 82% 低于目标 85%']
    }, 10, 20, 0.75)).toEqual({
      passed: false, reason: '发布阻断', coverageTarget: 85, coverage: 82,
      effectiveRate: 0.75, blockingReasons: ['覆盖率 82% 低于目标 85%']
    })
  })

  it('uses task values only for legacy gate payloads', () => {
    expect(mapCoreQualityGate({ status: 'passed', summary: '通过' }, 91, 80, 0.9)).toMatchObject({
      passed: true, coverageTarget: 80, coverage: 91, effectiveRate: 0.9
    })
  })
})
