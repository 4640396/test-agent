export interface CaseEvidence {
  caseId: string
  status: 'passed' | 'failed' | 'skipped'
  evidence: string
  tool: string
}

/** Never infer a plan-case result from suite totals or a fuzzy title match. */
export function evidenceByCaseId(results: readonly CaseEvidence[]): Map<string, CaseEvidence> {
  const byId = new Map<string, CaseEvidence>()
  for (const result of results) {
    const id = result.caseId.trim()
    if (!id) continue
    // Conflicting explicit records must not be displayed as a pass.
    const previous = byId.get(id)
    if (previous?.status === 'failed') continue
    if (!previous || result.status === 'failed') byId.set(id, result)
  }
  return byId
}
