export function suiteCaseId(testCase: Record<string, unknown>, legacyId: string): string {
  return typeof testCase.id === 'string' && testCase.id.trim() ? testCase.id : legacyId
}

export function suiteContainsCase(caseIds: readonly string[], testCase: Record<string, unknown>, legacyId: string): boolean {
  const storedId = typeof testCase.id === 'string' ? testCase.id : ''
  return caseIds.includes(storedId) || caseIds.includes(legacyId)
}
