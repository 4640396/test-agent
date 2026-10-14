import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskInput } from '@cxmt/protocol'
import type { AgentRunResult } from '../src/core/types.js'
import { allowedTestToolNamesForProject, buildCaseDesignScopePrompt, missingGeneratedCaseIds, validateExecutionOutcome, validatePlanCoverage } from '../src/core/runner.js'

const tempDirs: string[] = []
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function input(testTypes: TaskInput['testTypes']): TaskInput {
  return { projectPath: 'C:/project', systemName: 'demo', version: '1', testTypes }
}

function result(lanes: AgentRunResult['lanes'], passed = 1, failed = 0): AgentRunResult {
  return { lanes, report: { passed, failed, coverage: null }, artifacts: [] }
}

const caseFor = (layer: 'unit' | 'api' | 'ui') => ({
  id: `CASE-${layer}`, title: `${layer} case`, scenario: 'scenario', steps: ['step'], expected: 'expected', priority: 'high' as const, layer,
  target: layer === 'api' ? '/health' : layer === 'ui' ? '首页' : 'src/example.ts#run',
  ...(layer === 'api' ? { method: 'GET', path: '/health', expectedStatus: 200, expectedJsonSubset: { status: 'ok' } } : {})
})

describe('plan coverage gate', () => {
  it('hard-limits test adapters by detected project kind', () => {
    expect([...allowedTestToolNamesForProject(['unit', 'ui'], 'node')!].sort())
      .toEqual(['node_test', 'playwright_test'])
    expect(allowedTestToolNamesForProject(['unit'], 'node')!.has('maven_test')).toBe(false)
    expect([...allowedTestToolNamesForProject(['unit'], 'maven')!].sort())
      .toEqual(['maven_test', 'reflect_test'])
  })

  it('does not reuse generated tests whose embedded IDs belong to an older plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'generated-case-evidence-'))
    tempDirs.push(root)
    mkdirSync(join(root, '.test-agent'), { recursive: true })
    writeFileSync(join(root, '.test-agent', 'unit-cases.mjs'), 'test("[CASE:oldoldoldoldold1] stale", () => {})')
    expect(missingGeneratedCaseIds(root, [caseFor('unit'), caseFor('ui')]))
      .toEqual(['CASE-unit', 'CASE-ui'])

    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'current.spec.ts'), 'test("[CASE:CASE-unit] unit", () => {}); test("[CASE:CASE-ui] ui", () => {})')
    expect(missingGeneratedCaseIds(root, [caseFor('unit'), caseFor('ui')])).toEqual([])
  })

  it('gives case-designer an explicit selected-layer contract', () => {
    const uiOnly = buildCaseDesignScopePrompt(['ui'])
    expect(uiOnly).toContain('仅设计以下层级：ui（UI 测试）')
    expect(uiOnly).toContain('不得输出未选择层级')
    expect(uiOnly).toContain('页面导航、用户交互和可验证的页面断言')
    expect(uiOnly).not.toContain('API 用例必须')

    const mixed = buildCaseDesignScopePrompt(['unit', 'regression', 'api', 'ui'])
    expect(mixed.match(/unit（单元测试）/g)).toHaveLength(1)
    expect(mixed).toContain('API 用例必须')
    expect(mixed).toContain('UI 用例必须')
  })

  it('requires at least one case for every selected concrete layer', () => {
    expect(() => validatePlanCoverage(input(['unit', 'api', 'ui']), [caseFor('unit')]))
      .toThrow(/api, ui/)
    expect(() => validatePlanCoverage(input(['unit', 'api', 'ui']), [caseFor('unit'), caseFor('api'), caseFor('ui')]))
      .not.toThrow()
  })

  it('treats regression as scope rather than a case layer and rejects empty plans', () => {
    expect(() => validatePlanCoverage(input(['unit', 'regression']), [caseFor('unit')])).not.toThrow()
    expect(() => validatePlanCoverage(input(['regression']), [])).toThrow(/没有测试用例/)
  })

  it('rejects duplicate, unsafe, and incomplete cases before any file generation', () => {
    const valid = caseFor('unit')
    expect(() => validatePlanCoverage(input(['unit']), [valid, { ...valid, title: 'duplicate' }]))
      .toThrow(/ID 重复/)
    expect(() => validatePlanCoverage(input(['unit']), [{ ...valid, id: '../escape' }]))
      .toThrow(/ID 非法/)
    expect(() => validatePlanCoverage(input(['unit']), [{ ...valid, steps: [], expected: '', target: '' }]))
      .toThrow(/缺少有效执行步骤.*缺少可验证的预期结果.*缺少明确的被测目标/)
  })

  it('accepts a reflect case with an explicit structured target', () => {
    const reflectCase = {
      ...caseFor('unit'),
      target: undefined,
      structuredScenario: {
        target: { className: 'com.example.Calculator', method: 'add' },
        params: [],
        assertion: { op: 'equals', expected: 0 }
      }
    }
    expect(() => validatePlanCoverage(input(['unit']), [reflectCase])).not.toThrow()
  })

  it('requires an explicit HTTP contract for API plans', () => {
    const apiCase = caseFor('api')
    expect(() => validatePlanCoverage(input(['api']), [{ ...apiCase, method: '', path: 'health', expectedStatus: 99 }]))
      .toThrow(/缺少有效 HTTP 方法.*缺少有效 API 路径.*缺少有效期望状态码/)
    expect(() => validatePlanCoverage(input(['api']), [{ ...apiCase, expectedBodyContains: [], expectedJsonSubset: undefined }]))
      .toThrow(/缺少响应内容断言/)
  })
})

describe('execution evidence gate', () => {
  it('rejects an empty or all-skipped execution', () => {
    expect(() => validateExecutionOutcome(input(['unit']), result([{ type: 'unit', status: 'passed', summary: '0/0 通过' }], 0, 0)))
      .toThrow(/没有产出任何通过或失败结果/)
  })

  it('rejects a selected frontend or backend lane that never ran', () => {
    expect(() => validateExecutionOutcome(input(['unit', 'ui']), result([{ type: 'unit', status: 'passed', summary: '1/1 通过' }])))
      .toThrow(/ui/)
    expect(() => validateExecutionOutcome(input(['unit', 'api']), result([{ type: 'unit', status: 'passed', summary: '1/1 通过' }])))
      .toThrow(/api/)
  })

  it('rejects a failed lane with no structured failure count', () => {
    expect(() => validateExecutionOutcome(input(['ui']), result([{ type: 'ui', status: 'failed', summary: '0/1 通过' }], 1, 0)))
      .toThrow(/没有结构化失败结果/)
  })

  it('reports a selected 0\/0 lane before secondary missing-case evidence', () => {
    const mixed = result([
      { type: 'unit', status: 'passed', summary: '41/42 通过，1 失败' },
      { type: 'ui', status: 'passed', summary: '0/0 通过' }
    ], 41, 1)
    mixed.cases = [caseFor('unit'), caseFor('ui')]
    mixed.report.caseResults = [{ caseId: 'CASE-unit', status: 'passed', tool: 'node_test', evidence: 'ok' }]
    expect(() => validateExecutionOutcome(input(['unit', 'ui']), mixed))
      .toThrow(/ui 通道未收集到任何测试（0\/0）/)
  })

  it('accepts real results for every selected lane and treats regression as an execution scope', () => {
    const complete = result([
      { type: 'unit', status: 'passed', summary: '2/2 通过' },
      { type: 'ui', status: 'passed', summary: '1/1 通过' }
    ], 3, 0)
    complete.fullReport = { uiSteps: [{ name: '打开首页', status: 'passed' }] }
    expect(() => validateExecutionOutcome(input(['unit', 'ui']), complete)).not.toThrow()
    expect(() => validateExecutionOutcome(input(['unit', 'regression']), result([{ type: 'unit', status: 'passed', summary: '2/2 通过' }], 2, 0))).not.toThrow()
  })

  it('requires UI steps or screenshots instead of totals alone', () => {
    expect(() => validateExecutionOutcome(input(['ui']), result([{ type: 'ui', status: 'passed', summary: '1/1 通过' }])))
      .toThrow(/UI 通道没有步骤或截图证据/)
    const withSteps = result([{ type: 'ui', status: 'passed', summary: '1/1 通过' }])
    withSteps.fullReport = { uiSteps: [{ name: '打开首页', status: 'passed' }] }
    expect(() => validateExecutionOutcome(input(['ui']), withSteps)).not.toThrow()
  })

  it('requires a non-skipped HTTP result for every planned API case', () => {
    const apiResult = result([{ type: 'api', status: 'passed', summary: '2/2 通过' }], 2, 0)
    apiResult.cases = [
      { id: 'API-1', title: 'health', scenario: 'health', steps: ['GET /health'], expected: '200', priority: 'high', layer: 'api' },
      { id: 'API-2', title: 'missing', scenario: 'missing', steps: ['GET /missing'], expected: '404', priority: 'high', layer: 'api' }
    ]
    apiResult.report.caseResults = [{ caseId: 'API-1', status: 'passed', tool: 'api_test', evidence: 'GET /health · HTTP 200' }]
    expect(() => validateExecutionOutcome(input(['api']), apiResult)).toThrow(/API-2/)
    apiResult.report.caseResults.push({ caseId: 'API-2', status: 'passed', tool: 'api_test', evidence: 'GET /missing · HTTP 404' })
    expect(() => validateExecutionOutcome(input(['api']), apiResult)).not.toThrow()
  })

  it('requires non-skipped execution evidence for every planned unit and UI case', () => {
    const unitResult = result([{ type: 'unit', status: 'passed', summary: '2/2 通过' }], 2, 0)
    unitResult.cases = [caseFor('unit'), { ...caseFor('unit'), id: 'CASE-unit-2' }]
    unitResult.report.caseResults = [{ caseId: 'CASE-unit', status: 'passed', tool: 'node_test', evidence: 'TAP · ok' }]
    expect(() => validateExecutionOutcome(input(['unit']), unitResult)).toThrow(/CASE-unit-2/)
    unitResult.report.caseResults.push({ caseId: 'CASE-unit-2', status: 'passed', tool: 'node_test', evidence: 'TAP · ok' })
    expect(() => validateExecutionOutcome(input(['unit']), unitResult)).not.toThrow()

    const uiResult = result([{ type: 'ui', status: 'passed', summary: '1/1 通过' }], 1, 0)
    uiResult.cases = [caseFor('ui')]
    uiResult.fullReport = { uiSteps: [{ name: '打开首页', status: 'passed' }] }
    uiResult.report.caseResults = [{ caseId: 'CASE-ui', status: 'skipped', tool: 'playwright_test', evidence: 'skipped' }]
    expect(() => validateExecutionOutcome(input(['ui']), uiResult)).toThrow(/CASE-ui/)
  })

  it('rejects evidence produced by the wrong test lane', () => {
    const uiResult = result([{ type: 'ui', status: 'passed', summary: '1/1 通过' }], 1, 0)
    uiResult.cases = [caseFor('ui')]
    uiResult.fullReport = { uiSteps: [{ name: '打开首页', status: 'passed' }] }
    uiResult.report.caseResults = [{ caseId: 'CASE-ui', status: 'passed', tool: 'node_test', evidence: 'same ID in a unit test' }]
    expect(() => validateExecutionOutcome(input(['ui']), uiResult)).toThrow(/对应测试层级/)
  })

  it('rejects contradictory per-case and aggregate results', () => {
    const unitResult = result([{ type: 'unit', status: 'passed', summary: '1/1 通过' }], 1, 0)
    unitResult.cases = [caseFor('unit')]
    unitResult.report.caseResults = [{ caseId: 'CASE-unit', status: 'failed', tool: 'node_test', evidence: 'not ok' }]
    expect(() => validateExecutionOutcome(input(['unit']), unitResult)).toThrow(/汇总失败数为 0/)
  })

  it('rejects aggregate totals smaller than the planned and evidenced case set', () => {
    const unitResult = result([{ type: 'unit', status: 'passed', summary: '1/1 通过' }], 1, 0)
    unitResult.cases = [caseFor('unit'), { ...caseFor('unit'), id: 'CASE-unit-2' }]
    unitResult.report.caseResults = unitResult.cases.map((item) => ({ caseId: item.id, status: 'passed' as const, tool: 'node_test', evidence: 'ok' }))
    expect(() => validateExecutionOutcome(input(['unit']), unitResult)).toThrow(/少于计划用例/)
  })
})
