export interface CoreQualityGate {
  status: 'passed' | 'failed'
  summary: string
  coverageTarget?: number
  coverage?: number | null
  blockingReasons?: string[]
}

export interface ReportGate {
  coverageTarget: number
  coverage: number | null
  effectiveRate: number
  passed: boolean
  reason: string
  blockingReasons?: string[]
}

/** Preserve the authoritative core gate instead of replacing production values with UI defaults. */
export function mapCoreQualityGate(
  gate: CoreQualityGate,
  fallbackCoverage: number | null,
  fallbackTarget: number,
  effectiveRate: number
): ReportGate {
  return {
    passed: gate.status === 'passed',
    coverageTarget: gate.coverageTarget ?? fallbackTarget,
    coverage: gate.coverage ?? fallbackCoverage,
    effectiveRate,
    reason: gate.summary,
    ...(gate.blockingReasons?.length ? { blockingReasons: [...gate.blockingReasons] } : {})
  }
}
