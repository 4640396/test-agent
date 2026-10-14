import { describe, expect, it } from 'vitest'
import type { Message, TextContent } from '@cxmt/ai'
import { parseDiagnosisResponse, degradeDiagnosis, diagnosisReadBudget, type FailedCaseInput } from '../src/core/orchestrator.js'

describe('diagnosis read budget', () => {
  it('scales with failures and keeps a hard ceiling', () => {
    expect(diagnosisReadBudget(1)).toBe(6)
    expect(diagnosisReadBudget(8)).toBe(16)
    expect(diagnosisReadBudget(100)).toBe(16)
  })
})

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text } as TextContent] }
}

describe('P1-5 caseId 端到端透传', () => {
  const inputs: FailedCaseInput[] = [
    { name: 'Calculator.add 正常相加', layer: 'unit', error: 'expected 5 but was 4', caseId: 'TC001' },
    { name: 'Calculator.divide 除零', layer: 'unit', error: 'ArithmeticException', caseId: 'TC002' },
  ]

  it('LLM 原样回填 caseId → 透传到 FailedCaseRecord', () => {
    const llmJson = JSON.stringify([
      { name: 'Calculator.add 正常相加', layer: 'unit', error: 'expected 5 but was 4', category: 'real-bug', confidence: 'high', evidence: '行8 算错', suggestion: '修 add', caseId: 'TC001' },
      { name: 'Calculator.divide 除零', layer: 'unit', error: 'ArithmeticException', category: 'test-defect', confidence: 'low', evidence: '未断言异常', suggestion: '加 assertThrows', caseId: 'TC002' },
    ])
    const out = parseDiagnosisResponse([assistantMsg('```json\n' + llmJson + '\n```')], inputs)
    expect(out[0].caseId).toBe('TC001')
    expect(out[1].caseId).toBe('TC002')
  })

  it('LLM 漏填 caseId → 按 name 回查 input.caseId 兜底（reviewer 必处理）', () => {
    const llmJson = JSON.stringify([
      { name: 'Calculator.add 正常相加', layer: 'unit', error: 'x', category: 'real-bug', confidence: 'low', evidence: 'e' },
      { name: 'Calculator.divide 除零', layer: 'unit', error: 'y', category: 'flaky', confidence: 'low', evidence: 'e' },
    ])
    const out = parseDiagnosisResponse([assistantMsg(llmJson)], inputs)
    expect(out[0].caseId).toBe('TC001')  // LLM 漏填，input 兜底
    expect(out[1].caseId).toBe('TC002')
  })

  it('LLM 改 name → input 找不到则 caseId 空（GUI fallback name 匹配）', () => {
    const llmJson = JSON.stringify([
      { name: 'add 测试', layer: 'unit', error: 'x', category: 'real-bug', confidence: 'low', evidence: 'e' },
    ])
    const out = parseDiagnosisResponse([assistantMsg(llmJson)], inputs)
    expect(out[0].caseId).toBeUndefined()
  })

  it('degradeDiagnosis 透传 caseId（条件展开不强制 undefined）', () => {
    const out = degradeDiagnosis(inputs)
    expect(out.failedCases[0].caseId).toBe('TC001')
    expect(out.failedCases[1].caseId).toBe('TC002')
    // 无 caseId 的 input 不填 caseId
    const outNoId = degradeDiagnosis([{ name: '合成名', layer: 'unit', error: 'e' }])
    expect(outNoId.failedCases[0].caseId).toBeUndefined()
  })
})
