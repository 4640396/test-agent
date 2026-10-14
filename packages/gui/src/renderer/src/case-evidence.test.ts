import { describe, expect, it } from 'vitest'
import { evidenceByCaseId } from './case-evidence'

describe('evidenceByCaseId', () => {
  it('matches only exact IDs and ignores missing IDs', () => {
    const evidence = evidenceByCaseId([
      { caseId: 'TC1', status: 'passed', evidence: 'GET /health · HTTP 200', tool: 'api_test' },
      { caseId: '', status: 'passed', evidence: 'unknown', tool: 'api_test' },
    ])
    expect(evidence.get('TC1')?.status).toBe('passed')
    expect(evidence.has('TC1-extra')).toBe(false)
    expect(evidence.size).toBe(1)
  })

  it('keeps a failure when duplicate explicit IDs conflict', () => {
    const evidence = evidenceByCaseId([
      { caseId: 'TC1', status: 'passed', evidence: 'first', tool: 'api_test' },
      { caseId: 'TC1', status: 'failed', evidence: 'HTTP 500', tool: 'api_test' },
      { caseId: 'TC1', status: 'passed', evidence: 'later', tool: 'api_test' },
    ])
    expect(evidence.get('TC1')).toMatchObject({ status: 'failed', evidence: 'HTTP 500' })
  })
})
