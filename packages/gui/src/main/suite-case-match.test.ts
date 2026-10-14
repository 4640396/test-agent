import { describe, expect, it } from 'vitest'
import { suiteCaseId, suiteContainsCase } from './suite-case-match.js'

describe('suite case identity', () => {
  it('uses the persisted case id saved by the plan UI', () => {
    const testCase = { id: 'API-HEALTH', title: '健康检查' }
    expect(suiteContainsCase(['API-HEALTH'], testCase, 'legacy-hash')).toBe(true)
    expect(suiteCaseId(testCase, 'legacy-hash')).toBe('API-HEALTH')
  })

  it('keeps legacy title-hash suites runnable', () => {
    const testCase = { title: '旧用例' }
    expect(suiteContainsCase(['legacy-hash'], testCase, 'legacy-hash')).toBe(true)
    expect(suiteCaseId(testCase, 'legacy-hash')).toBe('legacy-hash')
  })
})
