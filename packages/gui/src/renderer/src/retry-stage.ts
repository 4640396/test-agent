export type RetryStageAction = 'restart-analysis' | 'rerun-design' | 'rerun-execute'

export interface RetryStageInput {
  status?: string
  phase: 'scout' | 'design' | 'generate' | 'execute' | 'fix' | ''
  projectReady: boolean
  hostReady: boolean
  hasScoutReport: boolean
  plannedCaseCount: number
}

/** An interrupted scout has no checkpoint artifact, but can safely restart from its beginning. */
export function retryStageAction(input: RetryStageInput): RetryStageAction | null {
  // 应用重启后运行快照不会恢复，但阶段产物会从 checkpoint 恢复。
  // 此时 status 为 undefined，仍应允许从已有产物继续；明确处于运行中或已完成时不提供重跑。
  if (input.status === 'running' || input.status === 'completed') return null
  if (input.status && input.status !== 'failed' && input.status !== 'cancelled') return null
  if (!input.projectReady || !input.hostReady) return null
  if (input.phase === 'scout') return 'restart-analysis'
  if (input.phase === 'design' && input.hasScoutReport) return 'rerun-design'
  if ((input.phase === 'generate' || input.phase === 'execute') && input.plannedCaseCount > 0) return 'rerun-execute'
  return null
}
