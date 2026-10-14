export type JourneyStatus = 'done' | 'active' | 'attention' | 'waiting' | 'skipped' | 'blocked'

export interface JourneyStep {
  id: string
  title: string
  status: JourneyStatus
  detail: string
}

export interface JourneyInput {
  hasTask: boolean
  phase: 'scout' | 'design' | 'generate' | 'execute' | 'fix' | ''
  taskActive: boolean
  planPending: boolean
  executionConfirmed: boolean
  requiresGeneration: boolean
  hasScoutReport: boolean
  plannedCaseCount: number
  executionResult: { passed: number; failed: number } | null
  hasReport: boolean
  terminalStatus?: 'failed' | 'cancelled' | null
}

/** Business milestones shown to users. Internal dispatch, generation and diagnosis stay in technical logs. */
export function taskJourney(input: JourneyInput): JourneyStep[] {
  const interrupted = input.terminalStatus !== null && input.terminalStatus !== undefined
  const analysisDone = input.hasScoutReport || input.plannedCaseCount > 0 || input.planPending || input.executionConfirmed || input.hasReport
  const planStarted = input.phase === 'design' || input.planPending || input.plannedCaseCount > 0
  const planDone = input.executionConfirmed || input.executionResult !== null || input.hasReport
  const preparationStarted = input.executionConfirmed && !input.planPending
  const executionStarted = preparationStarted && (input.phase === 'execute' || input.phase === 'fix')
  const preparationDone = executionStarted || input.executionResult !== null || input.hasReport
  const executionDone = input.executionResult !== null
  const failedCount = input.executionResult?.failed ?? 0
  const diagnosing = input.phase === 'fix' && input.taskActive && failedCount > 0
  const resultUnavailable = input.hasReport && !executionDone
  const preparationStatus: JourneyStatus = !input.requiresGeneration && preparationStarted
    ? 'skipped'
    : preparationDone ? 'done' : interrupted && preparationStarted ? 'blocked' : input.phase === 'generate' && input.taskActive ? 'active' : 'waiting'

  return [
    { id: 'analysis', title: '项目分析', status: analysisDone ? 'done' : interrupted ? 'blocked' : input.hasTask && input.phase === 'scout' ? 'active' : 'waiting', detail: analysisDone ? '项目结构与测试条件已识别' : '识别项目结构与测试条件' },
    { id: 'plan', title: '计划确认', status: planDone ? 'done' : input.planPending ? 'attention' : interrupted && planStarted ? 'blocked' : planStarted ? 'active' : 'waiting', detail: planDone ? `已确认 ${input.plannedCaseCount} 条用例的执行范围` : input.planPending ? `待确认 ${input.plannedCaseCount} 条用例与执行范围` : '生成用例并确认执行范围' },
    { id: 'prepare', title: '测试准备', status: preparationStatus, detail: !input.requiresGeneration && preparationStarted ? '反射场景无需生成测试代码' : preparationDone ? '测试代码与编译校验已完成' : input.phase === 'generate' ? '正在并行生成测试代码并编译校验' : '确认后生成可执行的测试代码' },
    { id: 'execute', title: '测试执行', status: resultUnavailable ? 'attention' : input.hasReport || executionDone && !diagnosing ? 'done' : interrupted && preparationStarted ? 'blocked' : executionStarted ? 'active' : 'waiting', detail: diagnosing ? `已执行：${input.executionResult?.passed ?? 0} 通过 · ${failedCount} 失败，正在诊断` : input.executionResult ? `${input.executionResult.passed} 通过 · ${input.executionResult.failed} 失败` : resultUnavailable ? '未产生可核验的测试结果' : '运行已确认的测试' },
    { id: 'report', title: '结果报告', status: input.hasReport ? 'done' : interrupted && executionDone ? 'blocked' : executionDone && !input.taskActive ? 'active' : 'waiting', detail: input.hasReport ? '报告已生成，可查看证据与建议' : executionDone ? '正在汇总结果与可核验证据' : '等待测试执行完成' },
  ]
}
