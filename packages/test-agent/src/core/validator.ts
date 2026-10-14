import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestCase } from './tools/test-tool-context.js'
import type { FailedCaseRecord } from './types.js'
import { assertInsideProject, sandboxEnvironment } from './sandbox.js'

function replacementCount(value: string): number {
  return value.split('\ufffd').length - 1
}

/** Decode Maven/Javac output without corrupting Windows GBK diagnostics. */
export function decodeProcessOutput(chunks: Buffer[]): string {
  if (!chunks.length) return ''
  const bytes = Buffer.concat(chunks)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (replacementCount(utf8) === 0) return utf8
  try {
    const gb18030 = new TextDecoder('gb18030').decode(bytes)
    return replacementCount(gb18030) < replacementCount(utf8) ? gb18030 : utf8
  } catch {
    return utf8
  }
}

function spawnSandboxed(
  sandbox: { confine(argv: readonly string[], policy: unknown): { argv: string[] } } | undefined,
  command: string,
  args: string[],
  options: import('node:child_process').SpawnSyncOptions,
  extraWritableDirs?: readonly string[]
): import('node:child_process').SpawnSyncReturns<string> {
  const policy: { mode: string; workspaceRoot: string; extraWritableDirs?: readonly string[] } = {
    mode: 'workspace-write',
    workspaceRoot: String(options.cwd ?? process.cwd())
  }
  if (extraWritableDirs && extraWritableDirs.length > 0) policy.extraWritableDirs = extraWritableDirs
  const argv = sandbox ? sandbox.confine([command, ...args], policy).argv : [command, ...args]
  return spawnSync(argv[0] ?? command, argv.slice(1), options) as import('node:child_process').SpawnSyncReturns<string>
}

export interface NodeTestOutcome {
  ok: boolean
  tests: number
  pass: number
  fail: number
  coverage: number | null
  compileError: boolean
  raw: string
  screenshots?: string[]
  branchCoverage?: number | null
  coverageEvidence?: CoverageEvidence
  failedCases?: Array<{ name: string; layer: string; error: string }>
  caseResults?: Array<{ caseId: string; status: 'passed' | 'failed' | 'skipped'; evidence: string }>
  riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
  uiSteps?: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number; screenshot?: string; error?: string }>
  recording?: { video?: string; trace?: string }
}

export interface UiRunOptions {
  entryUrl?: string
  env?: Record<string, string>
  /** 只运行指定的测试文件（相对项目根路径），不传则跑全部。 */
  file?: string
}


export interface MavenTestOutcome {
  ok: boolean
  tests: number
  pass: number
  fail: number
  coverage: number | null
  branchCoverage?: number | null
  coverageEvidence?: CoverageEvidence
  compileError: boolean
  raw: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  outputTruncated: boolean
  caseResults?: Array<{ caseId: string; status: 'passed' | 'failed' | 'skipped'; evidence: string }>
}

export interface CoverageEvidence {
  source: string
  generatedAt: string
  gaps: Array<{ file: string; uncoveredLines: number[] }>
}

/** Parse aggregate counters and the most useful uncovered-line evidence from JaCoCo XML. */
export function parseJacocoSummary(raw: string): { line: number | null; branch: number | null; gaps: CoverageEvidence['gaps'] } {
  const percentage = (type: string): number | null => {
    const matches = [...raw.matchAll(new RegExp(`<counter\\s+type="${type}"\\s+missed="(\\d+)"\\s+covered="(\\d+)"\\s*/>`, 'g'))]
    const match = matches.at(-1)
    if (!match) return null
    const missed = Number(match[1])
    const covered = Number(match[2])
    const total = missed + covered
    return total > 0 ? Math.round((covered / total) * 1000) / 10 : null
  }
  const gaps: CoverageEvidence['gaps'] = []
  const packagePattern = /<package\s+name="([^"]+)"[\s\S]*?<\/package>/g
  for (const pkg of raw.matchAll(packagePattern)) {
    const packageName = pkg[1]
    for (const source of pkg[0].matchAll(/<sourcefile\s+name="([^"]+)"[\s\S]*?<\/sourcefile>/g)) {
      const uncoveredLines = [...source[0].matchAll(/<line\s+nr="(\d+)"[^>]*\bmi="([1-9]\d*)"[^>]*\bci="0"[^>]*\/>/g)]
        .map((line) => Number(line[1]))
      if (uncoveredLines.length > 0) {
        gaps.push({ file: `${packageName}/${source[1]}`.replace(/\\/g, '/'), uncoveredLines })
      }
    }
  }
  gaps.sort((a, b) => b.uncoveredLines.length - a.uncoveredLines.length)
  return { line: percentage('LINE'), branch: percentage('BRANCH'), gaps: gaps.slice(0, 10) }
}

export function readFreshJacocoCoverage(projectPath: string, startedAtMs: number): { coverage: number | null; branchCoverage: number | null; evidence?: CoverageEvidence } {
  const reportPath = [
    join(projectPath, 'target', 'site', 'jacoco', 'jacoco.xml'),
    join(projectPath, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml')
  ].find((candidate) => existsSync(candidate))
  if (!reportPath) return { coverage: null, branchCoverage: null }
  try {
    const stats = statSync(reportPath)
    if (stats.mtimeMs < startedAtMs) return { coverage: null, branchCoverage: null }
    const parsed = parseJacocoSummary(readFileSync(reportPath, 'utf8'))
    if (parsed.line === null && parsed.branch === null) return { coverage: null, branchCoverage: null }
    return {
      coverage: parsed.line,
      branchCoverage: parsed.branch,
      evidence: {
        source: relative(projectPath, reportPath).replace(/\\/g, '/'),
        generatedAt: stats.mtime.toISOString(),
        gaps: parsed.gaps,
      },
    }
  } catch {
    return { coverage: null, branchCoverage: null }
  }
}

export interface MavenCommandSpec {
  command: string
  args: string[]
  cwd: string
}

const SENSITIVE_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i

/** Preserve toolchain environment while removing credentials owned by the Worker process. */
export function scrubExecutionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && !SENSITIVE_ENV_NAME.test(name)))
}

function matchNumber(lines: string[], pattern: RegExp): number {
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return Number(match[1])
  }
  return 0
}

interface NodeCoverageTable {
  line: number | null
  branch: number | null
  files: Array<{ file: string; line: number; branch: number; uncoveredLines: number[] }>
}

function expandLineRanges(value: string): number[] {
  const result: number[] = []
  for (const token of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token)
    if (range) {
      const start = Number(range[1]); const end = Number(range[2])
      for (let line = start; line <= end && result.length < 200; line++) result.push(line)
    } else if (/^\d+$/.test(token)) result.push(Number(token))
  }
  return result
}

function parseNodeCoverageTable(raw: string): NodeCoverageTable {
  const files: NodeCoverageTable['files'] = []
  let line: number | null = null
  let branch: number | null = null
  let currentDir = ''
  for (const rawLine of raw.split(/\r?\n/)) {
    const text = rawLine.replace(/^\s*#\s*/, '').replace(/^\s*ℹ\s*/, '').trim()
    if (!text.includes('|') || /^-+/.test(text)) continue
    const columns = text.split('|').map((item) => item.trim())
    if (columns.length < 4) continue
    const name = columns[0]
    const linePct = Number.parseFloat(columns.length >= 6 ? columns[4] : columns[1])
    const branchPct = Number.parseFloat(columns[2])
    if (name.toLowerCase() === 'all files') {
      line = Number.isFinite(linePct) ? linePct : null
      branch = Number.isFinite(branchPct) ? branchPct : null
      continue
    }
    if (!name || name === 'file') continue
    if (!Number.isFinite(linePct) && !Number.isFinite(branchPct)) {
      currentDir = name
      continue
    }
    files.push({ file: currentDir ? `${currentDir}/${name}` : name, line: linePct, branch: branchPct, uncoveredLines: expandLineRanges(columns.at(-1) ?? '') })
  }
  return { line, branch, files }
}

function parseNodeFailures(raw: string): Array<{ name: string; layer: string; error: string }> {
  const failures: Array<{ name: string; layer: string; error: string }> = []
  let current: { name: string; layer: string; error: string } | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*ℹ\s*/, '')
    const failMatch = /^✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/.exec(line.trim())
    if (failMatch) {
      if (current) failures.push(current)
      current = { name: failMatch[1].trim(), layer: 'unit', error: '' }
      continue
    }
    if (!current) continue
    if (/^✔\s|^✖\s|^ℹ\s/.test(line.trim()) && !/^\s/.test(rawLine)) {
      failures.push(current)
      current = null
      continue
    }
    if (line.trim() && (/^\s/.test(rawLine) || /Error|Assertion|expected|actual|at /.test(line))) {
      current.error += (current.error ? '\n' : '') + line.trimEnd()
    }
  }
  if (current) failures.push(current)
  return failures
}

function buildNodeRiskPoints(table: NodeCoverageTable, failures: Array<{ name: string; layer: string; error: string }>): Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }> {
  const risks: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }> = []
  for (const file of table.files) {
    if (Number.isFinite(file.branch) && file.branch < 80) {
      risks.push({
        severity: file.branch < 50 ? 'high' : 'medium',
        file: file.file,
        message: `分支覆盖率 ${file.branch}%，存在未覆盖分支。`,
        suggestion: '补充边界与异常分支测试。'
      })
    } else if (Number.isFinite(file.line) && file.line < 80) {
      risks.push({
        severity: 'medium',
        file: file.file,
        message: `行覆盖率 ${file.line}%，存在未覆盖代码。`,
        suggestion: '补充核心逻辑测试。'
      })
    }
  }
  for (const failure of failures) {
    risks.push({ severity: 'high', file: failure.name, message: `测试失败：${failure.error.split('\n')[0] || failure.name}`, suggestion: '修复断言或被测代码。' })
  }
  return risks.slice(0, 10)
}

function packageTestScript(projectPath: string): string | null {
  const packagePath = join(projectPath, 'package.json')
  if (!existsSync(packagePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> }
    return parsed.scripts?.test?.trim() || null
  } catch {
    return null
  }
}

export interface NodeTestCommandSpec {
  command: string
  args: string[]
  cwd: string
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'node'
}

/** Select the package manager declared by the project instead of assuming npm. */
export function nodeTestCommandSpec(projectPath: string, platform: NodeJS.Platform = process.platform): NodeTestCommandSpec {
  const script = packageTestScript(projectPath)
  if (!script) return { command: 'node', args: ['--test', '--experimental-test-coverage'], cwd: projectPath, packageManager: 'node' }
  let declared = ''
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as { packageManager?: string }
    declared = pkg.packageManager?.split('@')[0]?.toLowerCase() ?? ''
  } catch { /* packageTestScript already validated the manifest */ }
  const manager: 'npm' | 'pnpm' | 'yarn' | 'bun' = declared === 'pnpm' || declared === 'yarn' || declared === 'bun'
    ? declared
    : existsSync(join(projectPath, 'pnpm-lock.yaml')) ? 'pnpm'
      : existsSync(join(projectPath, 'yarn.lock')) ? 'yarn'
        : existsSync(join(projectPath, 'bun.lockb')) || existsSync(join(projectPath, 'bun.lock')) ? 'bun'
          : 'npm'
  if (platform === 'win32') {
    const executable = manager === 'bun' ? 'bun.exe' : `${manager}.cmd`
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `${executable} test`], cwd: projectPath, packageManager: manager }
  }
  return { command: manager, args: ['test'], cwd: projectPath, packageManager: manager }
}

export function parseVitestStats(raw: string): { tests: number; pass: number; fail: number; coverage: number | null; branchCoverage: number | null } {
  const passMatch = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(raw)
  const failMatch = /Tests\s+(\d+)\s+failed/.exec(raw)
  const pass = passMatch ? Number(passMatch[1]) : 0
  const total = passMatch ? Number(passMatch[2]) : 0
  const fail = failMatch ? Number(failMatch[1]) : 0
  // vitest coverage table: "All files      |    93.1 |       80 |     100 |    93.1 | ..."
  let coverage: number | null = null
  let branchCoverage: number | null = null
  const allFilesLine = raw
    .split(/\r?\n/)
    .find((line) => /All files/i.test(line) && line.includes('|'))
  if (allFilesLine) {
    const cols = allFilesLine.split('|').map((c) => c.trim())
    // cols: ["All files", "93.1", "80", "100", "93.1", "..."]
    if (cols.length >= 5) {
      const linePct = Number.parseFloat(cols[4]) // % Lines
      const branchPct = Number.parseFloat(cols[2]) // % Branch
      if (Number.isFinite(linePct)) coverage = linePct
      if (Number.isFinite(branchPct)) branchCoverage = branchPct
    }
  }
  return { tests: total || pass + fail, pass, fail, coverage, branchCoverage }
}

/** 解析 node --test 的 TAP 汇总行（# tests N / # pass N / # fail N）+ 覆盖率表。 */
function parseTAPStats(raw: string): { tests: number; pass: number; fail: number; coverage: number | null; branchCoverage: number | null } {
  const lines = raw.split(/\r?\n/)
  const tests = matchNumber(lines, /\btests\s+(\d+)/)
  const pass = matchNumber(lines, /\bpass\s+(\d+)/)
  const fail = matchNumber(lines, /\bfail\s+(\d+)/)
  const coverageTable = parseNodeCoverageTable(raw)
  return { tests, pass, fail, coverage: coverageTable.line, branchCoverage: coverageTable.branch }
}

/** Extract plan-to-execution evidence from Node/Vitest/TAP output titles. */
export function parseCaseMarkerResults(raw: string): NonNullable<NodeTestOutcome['caseResults']> {
  const byId = new Map<string, NonNullable<NodeTestOutcome['caseResults']>[number]>()
  for (const line of raw.split(/\r?\n/)) {
    const markers = [...line.matchAll(/\[CASE:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g)]
    if (markers.length === 0) continue
    const failed = /(?:^|\s)(?:not ok\b|[×✗✕]|FAIL(?:ED)?\b)/i.test(line)
    const skipped = /(?:#\s*SKIP|\bskipp?ed\b|○)/i.test(line)
    const status = skipped ? 'skipped' as const : failed ? 'failed' as const : 'passed' as const
    for (const marker of markers) {
      const caseId = marker[1]
      const existing = byId.get(caseId)
      if (!existing || existing.status === 'skipped' || status === 'failed') {
        byId.set(caseId, { caseId, status, evidence: line.trim().slice(0, 1000) })
      }
    }
  }
  return [...byId.values()]
}

/** 独立重跑 node 单元测试（真实执行，不信任 Agent 返回的数字）。 */
export function runNodeUnitTests(projectPath: string, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): NodeTestOutcome {
  assertInsideProject(projectPath, projectPath)
  const script = packageTestScript(projectPath)
  const spec = nodeTestCommandSpec(projectPath)
  const result = script
    ? spawnSandboxed(sandbox, spec.command, spec.args, {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 180_000,
        windowsHide: true,
        env: sandboxEnvironment()
      }, extraWritableDirs)
    : spawnSandboxed(sandbox, 'node', ['--test', '--experimental-test-coverage'], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: sandboxEnvironment()
    }, extraWritableDirs)
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (script) {
    const vitestStats = parseVitestStats(raw)
    // npm test 可能跑 node --test（TAP 输出）而非 vitest——vitest 解析返回 tests=0 时回退 TAP 解析
    const useTAP = vitestStats.tests === 0
    const stats = useTAP ? parseTAPStats(raw) : vitestStats
    const failedCases = useTAP ? parseNodeFailures(raw) : []
    const riskPoints = useTAP ? buildNodeRiskPoints(parseNodeCoverageTable(raw), failedCases) : []
    const coverageTable = parseNodeCoverageTable(raw)
    return {
      ok: result.status === 0 && stats.fail === 0,
      tests: stats.tests,
      pass: stats.pass,
      fail: stats.fail,
      coverage: stats.coverage,
      compileError: result.status !== 0 && /Cannot find module|SyntaxError|ERR_MODULE_NOT_FOUND|TypeError/.test(raw),
      raw,
      branchCoverage: stats.branchCoverage,
      coverageEvidence: stats.coverage !== null ? { source: '测试命令覆盖率输出', generatedAt: new Date().toISOString(), gaps: coverageTable.files.filter((file) => file.uncoveredLines.length > 0).map((file) => ({ file: file.file, uncoveredLines: file.uncoveredLines })).slice(0, 10) } : undefined,
      failedCases,
      riskPoints,
      caseResults: parseCaseMarkerResults(raw)
    }
  }
  const stats = parseTAPStats(raw)
  const failedCases = parseNodeFailures(raw)
  const compileError = result.status !== 0 && /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(raw)
  const coverageTable = parseNodeCoverageTable(raw)
  return {
    ok: result.status === 0,
    tests: stats.tests,
    pass: stats.pass,
    fail: stats.fail,
    coverage: stats.coverage,
    compileError,
    raw,
    branchCoverage: stats.branchCoverage,
    coverageEvidence: stats.coverage !== null ? { source: 'node --test --experimental-test-coverage', generatedAt: new Date().toISOString(), gaps: coverageTable.files.filter((file) => file.uncoveredLines.length > 0).map((file) => ({ file: file.file, uncoveredLines: file.uncoveredLines })).slice(0, 10) } : undefined,
    failedCases,
    riskPoints: buildNodeRiskPoints(coverageTable, failedCases),
    caseResults: parseCaseMarkerResults(raw)
  }
}

/** 解析 surefire 报告的 Tests run / Failures / Errors 汇总行。 */
export function parseSurefireSummary(content: string): { tests: number; fail: number } | null {
  const match = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(content)
  if (!match) return null
  const run = Number(match[1])
  const failures = Number(match[2])
  const errors = Number(match[3])
  return { tests: run, fail: failures + errors }
}

/** Only reports written by this invocation may contribute to its result. */
export function readCurrentSurefireTotals(projectPath: string, startedAtMs: number): { tests: number; pass: number; fail: number } {
  const totals = { tests: 0, pass: 0, fail: 0 }
  const reportDir = join(projectPath, 'target', 'surefire-reports')
  try {
    for (const file of readdirSync(reportDir)) {
      if (!file.endsWith('.txt')) continue
      const path = join(reportDir, file)
      if (statSync(path).mtimeMs < startedAtMs) continue
      const summary = parseSurefireSummary(readFileSync(path, 'utf8'))
      if (!summary) continue
      totals.tests += summary.tests
      totals.fail += summary.fail
      totals.pass += summary.tests - summary.fail
    }
  } catch {
    // No current Surefire report (for example, compilation failed before tests).
  }
  return totals
}

function xmlAttribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  return value?.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Surefire testcase names are evidence IDs; the UI matches only exact plan IDs. */
export function parseSurefireTestCases(xml: string): NonNullable<MavenTestOutcome['caseResults']> {
  const cases: NonNullable<MavenTestOutcome['caseResults']> = []
  const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  for (const match of xml.matchAll(testcase)) {
    const name = xmlAttribute(match[1], 'name')
    if (!name) continue
    const className = xmlAttribute(match[1], 'classname') ?? ''
    const body = match[2] ?? ''
    const status = /<(?:failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
    cases.push({ caseId: name, status, evidence: `Surefire XML · ${className ? `${className}#` : ''}${name}` })
  }
  return cases
}

export function readCurrentSurefireCases(projectPath: string, startedAtMs: number): NonNullable<MavenTestOutcome['caseResults']> {
  const reportDir = join(projectPath, 'target', 'surefire-reports')
  const cases: NonNullable<MavenTestOutcome['caseResults']> = []
  try {
    for (const file of readdirSync(reportDir)) {
      if (!file.startsWith('TEST-') || !file.endsWith('.xml')) continue
      const path = join(reportDir, file)
      const stats = statSync(path)
      if (stats.mtimeMs < startedAtMs || stats.size > 20_000_000) continue
      cases.push(...parseSurefireTestCases(readFileSync(path, 'utf8')))
    }
  } catch {
    // XML evidence is optional; aggregate counts still come from current .txt reports.
  }
  return cases
}

export function parseJUnitXmlTotals(xml: string): { tests: number; pass: number; fail: number } {
  let tests = 0
  let fail = 0
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)]
  for (const suite of suites) {
    tests += Number(xmlAttribute(suite[1], 'tests') ?? 0)
    fail += Number(xmlAttribute(suite[1], 'failures') ?? 0) + Number(xmlAttribute(suite[1], 'errors') ?? 0)
  }
  return { tests, fail, pass: Math.max(0, tests - fail) }
}

/** Read only Gradle JUnit XML files written by the current invocation. */
export function readCurrentGradleResults(projectPath: string, startedAtMs: number): { tests: number; pass: number; fail: number; caseResults: NonNullable<MavenTestOutcome['caseResults']> } {
  const reportDir = join(projectPath, 'build', 'test-results', 'test')
  const result = { tests: 0, pass: 0, fail: 0, caseResults: [] as NonNullable<MavenTestOutcome['caseResults']> }
  try {
    for (const file of readdirSync(reportDir)) {
      if (!file.startsWith('TEST-') || !file.endsWith('.xml')) continue
      const path = join(reportDir, file)
      const stats = statSync(path)
      if (stats.mtimeMs < startedAtMs || stats.size > 20_000_000) continue
      const xml = readFileSync(path, 'utf8')
      const totals = parseJUnitXmlTotals(xml)
      result.tests += totals.tests
      result.pass += totals.pass
      result.fail += totals.fail
      result.caseResults.push(...parseSurefireTestCases(xml).map((item) => ({ ...item, evidence: item.evidence.replace('Surefire XML', 'Gradle JUnit XML') })))
    }
  } catch {
    // Compilation can fail before Gradle writes test results.
  }
  return result
}

/**
 * P0 项4 + P1-4：从 surefire *.txt 报告提取失败测试的 testClass + 源码位置。
 * P1-4：收集所有 stack 帧，过滤 framework/runner 帧取首个被测帧（传统 JUnit 有效）。
 * 反射用例全帧被滤 → location 不填（诚实降级，不回退第一帧误导）。
 * 返回 Map<testClass, { testClass, method?, path, line } | { testClass, reflect: true }>：
 *   反射用例（全帧被滤）标 reflect:true，testClass 指向 ReflectTestRunner，enrich 侧从场景 JSON 取真实被测类。
 */
function isFrameworkFrame(testClass: string): boolean {
  return (
    testClass.startsWith('org.junit.') ||
    testClass.startsWith('junit.framework.') ||
    testClass.startsWith('org.hamcrest.') ||
    testClass.startsWith('org.opentest4j.') ||
    testClass.startsWith('org.apiguardian.') ||
    testClass.startsWith('java.lang.reflect.') ||
    testClass.startsWith('sun.reflect.') ||
    testClass.startsWith('jdk.internal.reflect.') ||
    testClass.startsWith('com.cxmt.testagent.') ||
    testClass.includes('ReflectTestRunner') ||
    testClass === 'java.lang.Thread'
  )
}

function parseSurefireFailures(projectPath: string): Map<string, { testClass: string; method?: string; path?: string; line?: number; reflect?: boolean }> {
  const reportDir = join(projectPath, 'target', 'surefire-reports')
  const result = new Map<string, { testClass: string; method?: string; path?: string; line?: number; reflect?: boolean }>()
  if (!existsSync(reportDir)) return result
  let files: string[]
  try { files = readdirSync(reportDir) } catch { return result }
  for (const file of files) {
    if (!file.endsWith('.txt')) continue
    let content: string
    try { content = readFileSync(join(reportDir, file), 'utf8') } catch { continue }
    // “in <testClass>” 行提取测试类全名
    const inMatch = /<<< (?:FAILURE|ERROR)!\s*$[^\n]*?\n|Tests run:[^\n]*?\s+in\s+([\w.]+)/m.exec(content + '\n')
    const testClass = inMatch?.[1] ?? file.replace(/^TEST-|\.txt$/g, '').replace(/\./g, '/')
    // P1-4：收集所有 at 帧，过滤 framework/runner 帧取首个被测帧
    const frameRegex = /\bat\s+([\w.$]+)\.([\w$<>]+)\(([^()]+):([0-9]+)\)/g
    let m: RegExpExecArray | null
    const allFrames: Array<{ testClass: string; method: string; path: string; line: number }> = []
    while ((m = frameRegex.exec(content)) !== null) {
      allFrames.push({ testClass: m[1], method: m[2], path: m[3], line: Number(m[4]) })
    }
    const targetFrame = allFrames.find(f => !isFrameworkFrame(f.testClass))
    if (targetFrame) {
      result.set(testClass, { testClass: targetFrame.testClass, method: targetFrame.method, path: targetFrame.path, line: targetFrame.line })
    } else if (allFrames.length) {
      // 反射用例：全帧被滤 → 标 reflect，testClass 指向第一帧（enrich 侧从场景 JSON 取真实类）
      result.set(testClass, { testClass: allFrames[0].testClass, method: allFrames[0].method, reflect: true })
    }
    // 无 stack → 不填（现状）
  }
  return result
}

/**
 * P0 项4 + P1-4：用 surefire 报告补全 FailedCaseRecord 的 location / testClass（追加式可选字段）。
 * 匹配策略：failedCase.name 含 testClass 或 method 名 → 补字段；匹配不上保持原样（可选字段不阻断）。
 * caseId 不在此处填：LLM 产 name 不一定含 caseId 模式，靠 GUI 侧 resolveRerunCaseId 从 plannedCases name 匹配更稳。
 * P1-4：反射用例（info.reflect）location 不填（栈里无被测源码），testClass 从场景 JSON target.className 取真实被测类。
 */
function readScenarioTargetClass(projectPath: string, caseIdOrName: string): string | undefined {
  const scenariosDir = join(projectPath, '.test-agent', 'scenarios')
  if (!existsSync(scenariosDir)) return undefined
  // 先试 <caseIdOrName>.json，再遍历按 title/id 匹配
  const direct = join(scenariosDir, `${caseIdOrName}.json`)
  const tryParse = (p: string): string | undefined => {
    try {
      const sc = JSON.parse(readFileSync(p, 'utf8')) as { id?: string; title?: string; target?: { className?: string } }
      return sc.target?.className
    } catch { return undefined }
  }
  if (existsSync(direct)) return tryParse(direct)
  let files: string[]
  try { files = readdirSync(scenariosDir) } catch { return undefined }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const p = join(scenariosDir, f)
    try {
      const sc = JSON.parse(readFileSync(p, 'utf8')) as { id?: string; title?: string; target?: { className?: string } }
      if (sc.id === caseIdOrName || sc.title === caseIdOrName) return sc.target?.className
    } catch { continue }
  }
  return undefined
}

export function enrichFailedCasesWithSurefire(failedCases: FailedCaseRecord[], projectPath: string): FailedCaseRecord[] {
  if (failedCases.length === 0) return failedCases
  const surefireMap = parseSurefireFailures(projectPath)
  return failedCases.map((fc) => {
    // 已有 location/testClass 不覆盖
    if (fc.location && fc.testClass) return fc
    let matchedReflect = false
    // 按 name 含 testClass 或 method 匹配 surefire
    for (const [sureKey, info] of surefireMap) {
      const shortName = sureKey.split('.').pop() ?? sureKey
      if (fc.name.includes(sureKey) || fc.name.includes(shortName) || (info.method && fc.name.includes(info.method))) {
        if (info.reflect) {
          matchedReflect = true  // 命中反射报告，但 location 不填，testClass 从场景 JSON 取
          break
        }
        // 传统 JUnit：用过滤后的被测帧（info.testClass）而非 surefire 报告类（sureKey）
        return {
          ...fc,
          testClass: fc.testClass ?? info.testClass,
          location: fc.location ?? (info.path && info.line ? { path: info.path, line: info.line } : undefined),
        }
      }
    }
    // P1-4：反射用例（命中反射报告，或未命中但 name 可能是 caseId/title）→ testClass 从场景 JSON 取，location 不填
    if (fc.testClass) return fc  // 已有 testClass 不覆盖
    const realClass = readScenarioTargetClass(projectPath, fc.caseId ?? fc.name)
    if (realClass) return { ...fc, testClass: realClass }
    return fc  // 无场景 JSON 也不填（诚实降级）
  })
}

/** 独立重跑 Maven 单元测试，从 surefire 报告解析结果（覆盖率未配置时为 null）。 */
export async function runMavenUnitTests(projectPath: string, signal?: AbortSignal, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): Promise<MavenTestOutcome> {
  const usesGradle = !existsSync(join(projectPath, 'pom.xml')) && (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts')))
  return runMavenCommand(projectPath, usesGradle ? gradleCommandSpec(projectPath) : mavenCommandSpec(projectPath), signal, sandbox, extraWritableDirs)
}

export function mavenCommandSpec(projectPath: string, platform: NodeJS.Platform = process.platform): MavenCommandSpec {
  if (platform === 'win32') {
    const launcher = existsSync(join(projectPath, 'mvnw.cmd')) ? 'mvnw.cmd' : 'mvn.cmd'
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `${launcher} test`], cwd: projectPath }
  }
  return existsSync(join(projectPath, 'mvnw'))
    ? { command: './mvnw', args: ['test'], cwd: projectPath }
    : { command: 'mvn', args: ['test'], cwd: projectPath }
}

export function gradleCommandSpec(projectPath: string, platform: NodeJS.Platform = process.platform): MavenCommandSpec {
  if (platform === 'win32') {
    const launcher = existsSync(join(projectPath, 'gradlew.bat')) ? 'gradlew.bat' : 'gradle.bat'
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `${launcher} test`], cwd: projectPath }
  }
  return existsSync(join(projectPath, 'gradlew'))
    ? { command: './gradlew', args: ['test'], cwd: projectPath }
    : { command: 'gradle', args: ['test'], cwd: projectPath }
}

/**
 * P1-2：JUnit 批量重跑 Maven 命令（-Dtest=Class1,Class2 类级重跑）。
 * win32 用单字符串拼法（与 reflectMavenCommandSpec 一致，规避 cmd.exe 参数拼接坑）。
 */
export function junitBatchMavenCommandSpec(projectPath: string, testClasses: string[], platform: NodeJS.Platform = process.platform): MavenCommandSpec {
  const testArg = `-Dtest=${testClasses.join(',')}`
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `mvn.cmd test ${testArg}`], cwd: projectPath }
    : { command: 'mvn', args: ['test', testArg], cwd: projectPath }
}

/** Execute one Maven command and normalize process, Surefire and cancellation outcomes. */
export async function runMavenCommand(projectPath: string, spec: MavenCommandSpec, signal?: AbortSignal, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): Promise<MavenTestOutcome> {
  signal?.throwIfAborted()
  assertInsideProject(projectPath, spec.cwd)
  const mavenPolicy: { mode: string; workspaceRoot: string; extraWritableDirs?: readonly string[] } = { mode: 'workspace-write', workspaceRoot: projectPath }
  if (extraWritableDirs && extraWritableDirs.length > 0) mavenPolicy.extraWritableDirs = extraWritableDirs
  const command = sandbox
    ? sandbox.confine([spec.command, ...spec.args], mavenPolicy).argv
    : [spec.command, ...spec.args]
  const commandName = command[0] ?? spec.command
  const commandArgs = command.slice(1)
  const MAX_OUTPUT = 1_000_000
  const outputChunks: Buffer[] = []
  let outputBytes = 0
  let outputTruncated = false
  const append = (chunk: Buffer): void => {
    outputChunks.push(Buffer.from(chunk))
    outputBytes += chunk.length
    while (outputBytes > MAX_OUTPUT && outputChunks.length > 1) {
      outputBytes -= outputChunks.shift()?.length ?? 0
      outputTruncated = true
    }
  }
  const startedAtMs = Date.now()
  const child = spawn(commandName, commandArgs, { cwd: spec.cwd, env: scrubExecutionEnvironment(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let aborted = false
  const abort = (): void => {
    aborted = true
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => { child.kill('SIGKILL') })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const settled = await new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    child.once('error', (spawnError) => resolve({ exitCode: null, exitSignal: null, spawnError }))
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
  }).finally(() => signal?.removeEventListener('abort', abort))
  if (settled.spawnError) throw settled.spawnError
  const raw = decodeProcessOutput(outputChunks)
  const isGradle = !existsSync(join(projectPath, 'pom.xml')) && (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts')))
  const gradle = isGradle ? readCurrentGradleResults(projectPath, startedAtMs) : null
  const { tests, pass, fail } = gradle ?? readCurrentSurefireTotals(projectPath, startedAtMs)
  const caseResults = gradle?.caseResults ?? readCurrentSurefireCases(projectPath, startedAtMs)
  const jacoco = readFreshJacocoCoverage(projectPath, startedAtMs)
  const compileError = isMavenCompilationFailure(raw, settled.exitCode)
  return {
    ok: settled.exitCode === 0 && !aborted,
    tests,
    pass,
    fail,
    coverage: jacoco.coverage,
    branchCoverage: jacoco.branchCoverage,
    coverageEvidence: jacoco.evidence,
    compileError,
    raw,
    exitCode: settled.exitCode,
    signal: settled.exitSignal,
    timedOut: signal?.reason instanceof Error && (signal.reason.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(signal.reason.message)),
    aborted,
    outputTruncated,
    caseResults
  }
}

/** Distinguish compiler failures from ordinary failing tests; both end in BUILD FAILURE. */
export function isMavenCompilationFailure(raw: string, exitCode: number | null): boolean {
  if (exitCode === 0 || exitCode === null) return false
  return /COMPILATION ERROR|Compilation failure|maven-compiler-plugin[^\r\n]*(?:compile|test-compile|testCompile)|Execution failed for task ["']?:?(?:compileJava|compileTestJava)|(?:compileJava|compileTestJava) FAILED/i.test(raw)
}

export interface ApiCaseOutcome {
  ok: boolean
  pass: number
  fail: number
  skipped: number
  details: Array<{ caseId: string; method: string; path: string; status: string; statusCode?: number; durationMs?: number; reason?: string; body?: string; assertions?: string[] }>
}

function findApiTarget(caseItem: TestCase): { method: string; path: string } | null {
  if (caseItem.path?.trim()) return { method: (caseItem.method?.trim() || 'GET').toUpperCase(), path: caseItem.path.trim() }
  const candidates = [caseItem.scenario, ...caseItem.steps].join('\n')
  const explicit = candidates.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+["']?(\/[a-zA-Z0-9_\-/.{}?=&%]+)["']?/i)
  if (explicit) return { method: explicit[1].toUpperCase(), path: explicit[2] }
  const match = candidates.match(/["']?(\/[a-zA-Z0-9_\-/.{}?=&%]+)["']?/)
  if (!match) return null
  const text = `${caseItem.title} ${candidates}`.toLowerCase()
  const method = text.includes('post') || text.includes('创建') || text.includes('新增') || text.includes('提交')
    ? 'POST'
    : text.includes('put') || text.includes('更新') || text.includes('修改')
      ? 'PUT'
      : text.includes('delete') || text.includes('删除')
        ? 'DELETE'
        : 'GET'
  return { method, path: match[1] }
}

function assertExpected(status: number, expected: string): boolean {
  const exact = expected.match(/(?:^|\D)([1-5]\d{2})(?:\D|$)/)
  if (exact) return status === Number(exact[1])
  const text = expected.toLowerCase()
  if (text.includes('404')) return status === 404
  if (text.includes('401')) return status === 401
  if (text.includes('400')) return status === 400
  if (text.includes('200') || text.includes('成功') || text.includes('通过')) return status >= 200 && status < 300
  return status >= 200 && status < 300
}

function jsonSubsetMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length <= actual.length && expected.every((item, index) => jsonSubsetMatches(actual[index], item))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => jsonSubsetMatches((actual as Record<string, unknown>)[key], value))
  }
  return Object.is(actual, expected)
}

/** 基础 API 执行器：从用例提取接口路径，发起 HTTP 请求并按 expected 断言。
 *
 * options.keepBody=true 时 details 每项保留响应体（body 字段），用于 cleanup 实体提取。
 * 不传 keepBody 或 keepBody=false 时行为同今（不保留 body，节省内存）。 */
export async function runApiCases(cases: TestCase[], baseUrl: string, headers: Record<string, string> = {}, options?: { keepBody?: boolean }): Promise<ApiCaseOutcome> {
  let pass = 0
  let fail = 0
  let skipped = 0
  const details: ApiCaseOutcome['details'] = []
  const root = baseUrl.replace(/\/$/, '')
  const keepBody = options?.keepBody === true
  for (const caseItem of cases) {
    const target = findApiTarget(caseItem)
    if (!target) {
      skipped += 1
      details.push({ caseId: caseItem.id, method: 'GET', path: '', status: 'skipped', reason: '未从用例提取到接口路径' })
      continue
    }
    const startedAt = Date.now()
    try {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(target.method)) {
        fail += 1
        details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'failed', durationMs: 0, reason: `不支持的 HTTP 方法：${target.method}` })
        continue
      }
      const requestBody = caseItem.body === undefined ? undefined : JSON.stringify(caseItem.body)
      const response = await fetch(`${root}${target.path}`, {
        method: target.method,
        headers: { ...headers, ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }) },
        body: target.method === 'GET' || target.method === 'HEAD' ? undefined : requestBody,
        signal: AbortSignal.timeout(10_000)
      })
      const body = await response.text()
      const assertions: string[] = []
      const failures: string[] = []
      const statusMatches = caseItem.expectedStatus === undefined
        ? assertExpected(response.status, caseItem.expected)
        : response.status === caseItem.expectedStatus
      assertions.push(`HTTP ${caseItem.expectedStatus ?? caseItem.expected}`)
      if (!statusMatches) failures.push(`状态码期望=${caseItem.expectedStatus ?? caseItem.expected} 实际=${response.status}`)
      for (const fragment of caseItem.expectedBodyContains ?? []) {
        assertions.push(`响应包含=${fragment}`)
        if (!body.includes(fragment)) failures.push(`响应体缺少文本：${fragment}`)
      }
      if (caseItem.expectedJsonSubset) {
        assertions.push('响应 JSON 子集匹配')
        try {
          if (!jsonSubsetMatches(JSON.parse(body), caseItem.expectedJsonSubset)) failures.push('响应 JSON 不包含期望字段和值')
        } catch {
          failures.push('响应体不是有效 JSON')
        }
      }
      if (failures.length === 0) {
        pass += 1
        details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'passed', statusCode: response.status, durationMs: Date.now() - startedAt, assertions, ...(keepBody ? { body } : {}) })
      } else {
        fail += 1
        details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'failed', statusCode: response.status, durationMs: Date.now() - startedAt, reason: failures.join('；'), assertions, ...(keepBody ? { body } : {}) })
      }
    } catch (error) {
      fail += 1
      details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'failed', durationMs: Date.now() - startedAt, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: fail === 0, pass, fail, skipped, details }
}

/** 解析 Test Agent 内置的 Playwright CLI 路径（Worker 预置能力，被测项目无需安装）。 */
export function resolveBundledPlaywrightCli(): string {
  const fromEnv = process.env.TEST_AGENT_PLAYWRIGHT_CLI
  if (fromEnv) return fromEnv
  return join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js')
}

/** 检测 Playwright stderr 中的 webServer/dev server 失败模式，返回可操作提示。未检测到返回 undefined。 */
function detectWebServerFailure(raw: string, entryUrl?: string): string | undefined {
  const text = raw.toLowerCase()
  const missingPackage = /cannot find package ['"]([^'"]+)['"]/.exec(raw)
  if (missingPackage) {
    return missingPackage[1] === '@playwright/test'
      ? 'UI 测试未能加载 Test Agent 内置 Playwright；请检查内置模块解析桥接'
      : `项目依赖 ${missingPackage[1]} 未安装，无法启动 UI 测试；请先在项目目录安装锁文件依赖（如 npm ci）`
  }
  // webServer 起不来或超时：Playwright 的真实错误信息包含 "webserver" + "did not start"/"timed out"/"failed to start"。
  // 不匹配 JSON report 里的配置块（"webserver": {...}）和字段名（"globaltimeout"）。
  if (text.includes('webserver') && (text.includes('did not start') || text.includes('timed out') || text.includes('failed to start') || text.includes('was not able to start'))) {
    if (entryUrl) return `UI 入口地址 ${entryUrl} 在超时时间内无响应，请确认该地址可达且服务已启动`
    return `dev server 在超时时间内未启动成功，请检查项目的 dev 脚本（package.json scripts.dev）、端口 5199 是否被占用、依赖是否安装完整（npm install）`
  }
  if (text.includes('eaddrinuse') || text.includes('address already in use')) {
    return `端口 5199 被占用，请关闭占用该端口的进程，或在 UI 入口地址中指定已运行的服务地址`
  }
  // Playwright 二进制缺失（ffmpeg/video、browser channel）
  if (text.includes("executable doesn't exist") || text.includes('executable does not exist')) {
    if (text.includes('ffmpeg')) return `Playwright 缺少 ffmpeg 二进制（录像功能需要）。请在 Worker 机器运行 npx playwright install ffmpeg`
    if (text.includes('msedge') || text.includes('edge')) return `未找到 Microsoft Edge 浏览器，Playwright UI 执行需要预装 Edge。可在 Worker 机器运行 npx playwright install msedge 或改用项目自带 Playwright 配置`
    return `Playwright 缺少浏览器二进制。请在 Worker 机器运行 npx playwright install`
  }
  if (text.includes('webserver') && text.includes('command') && text.includes('failed')) {
    return `启动 dev server 的命令失败，请检查 package.json 是否定义了 dev 脚本（如 "dev": "vite"）`
  }
  return undefined
}

function findPlaywrightConfig(projectPath: string): string | undefined {
  const names = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
  for (const name of names) {
    const path = join(projectPath, name)
    if (existsSync(path)) return path
  }
  return undefined
}

export function shouldRunExplicitPlaywrightFile(configPath?: string, filePath?: string): boolean {
  return Boolean(configPath || filePath?.trim())
}

export function buildPlaywrightModuleBridgeSource(playwrightModuleUrl: string): string {
  return `export * from ${JSON.stringify(playwrightModuleUrl)}
export { default } from ${JSON.stringify(playwrightModuleUrl)}
`
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

type PlaywrightStepStatus = 'passed' | 'failed' | 'skipped'

interface PlaywrightAttachment {
  name?: string
  path?: string
  contentType?: string
}

interface PlaywrightStep {
  title?: string
  status?: PlaywrightStepStatus | 'timedOut' | 'interrupted'
  duration?: number
  error?: { message?: string }
}

interface PlaywrightTestResult {
  status?: PlaywrightStepStatus | 'timedOut' | 'interrupted'
  duration?: number
  error?: { message?: string }
  steps?: PlaywrightStep[]
  attachments?: PlaywrightAttachment[]
}

interface PlaywrightTest {
  title?: string
  results?: PlaywrightTestResult[]
}

interface PlaywrightSpec {
  title?: string
  tests?: PlaywrightTest[]
}

interface PlaywrightSuite {
  specs?: PlaywrightSpec[]
}

interface ParsedPlaywrightStep {
  name: string
  status: PlaywrightStepStatus
  durationMs: number
  error?: string
  screenshot?: string
}

interface ParsedPlaywrightTest {
  title: string
  status: PlaywrightStepStatus
  durationMs: number
  error?: string
  steps: ParsedPlaywrightStep[]
  screenshots: string[]
  video?: string
  trace?: string
}

interface ParsedPlaywrightReport {
  stats: { tests: number; pass: number; fail: number; flaky: number; skipped: number }
  tests: ParsedPlaywrightTest[]
}

function normalizePlaywrightStatus(status: string | undefined): PlaywrightStepStatus {
  if (status === 'passed' || status === 'failed' || status === 'skipped') return status
  return 'failed'
}

function firstAttachmentPath(attachments: PlaywrightAttachment[] | undefined, predicate: (attachment: PlaywrightAttachment) => boolean): string | undefined {
  return (attachments ?? []).find(predicate)?.path
}

function imageAttachmentPaths(attachments: PlaywrightAttachment[] | undefined): string[] {
  return (attachments ?? []).filter((attachment) => attachment.contentType?.startsWith('image/') && attachment.path).map((attachment) => attachment.path as string)
}

export function parsePlaywrightReport(stdout: string): ParsedPlaywrightReport {
  const empty = { stats: { tests: 0, pass: 0, fail: 0, flaky: 0, skipped: 0 }, tests: [] as ParsedPlaywrightTest[] }
  const jsonText = firstJsonObject(stdout)
  if (!jsonText) return empty
  try {
    const parsed = JSON.parse(jsonText) as { stats?: Record<string, unknown>; suites?: PlaywrightSuite[]; tests?: PlaywrightTest[] }
    const stats = parsed.stats ?? {}
    const testEntries = (parsed.suites ?? []).flatMap((suite) => (suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test) => ({ specTitle: spec.title, test }))))
    const tests = testEntries.map(({ specTitle, test }) => {
      const result = test.results?.[0]
      const status = normalizePlaywrightStatus(result?.status)
      const screenshots = imageAttachmentPaths(result?.attachments)
      const steps = (result?.steps ?? []).map((step) => {
        const stepStatus = step.status ? normalizePlaywrightStatus(step.status) : 'passed'
        const status = step.error?.message ? 'failed' : stepStatus
        return {
          name: step.title ?? '未命名步骤',
          status,
          durationMs: Number(step.duration ?? 0),
          ...(step.error?.message ? { error: step.error.message } : {}),
          ...(status === 'failed' && screenshots.length > 0 ? { screenshot: screenshots[0] } : {})
        }
      })
      return {
        title: specTitle ?? test.title ?? '未命名测试',
        status,
        durationMs: Number(result?.duration ?? 0),
        ...(result?.error?.message ? { error: result.error.message } : {}),
        steps,
        screenshots,
        video: firstAttachmentPath(result?.attachments, (attachment) => attachment.name === 'video'),
        trace: firstAttachmentPath(result?.attachments, (attachment) => attachment.name === 'trace')
      }
    })
    return {
      stats: {
        tests: Number(stats.expected ?? 0) + Number(stats.unexpected ?? 0) + Number(stats.flaky ?? 0) + Number(stats.skipped ?? 0),
        pass: Number(stats.expected ?? 0),
        fail: Number(stats.unexpected ?? 0),
        flaky: Number(stats.flaky ?? 0),
        skipped: Number(stats.skipped ?? 0)
      },
      tests
    }
  } catch {
    return empty
  }
}

function relativeToProject(projectPath: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const absolute = isAbsolute(filePath) ? filePath : join(projectPath, filePath)
  return relative(projectPath, absolute).replace(/\\/g, '/')
}

export function parsePlaywrightCaseResults(tests: ParsedPlaywrightTest[]): NonNullable<NodeTestOutcome['caseResults']> {
  return tests.flatMap((test) => {
    const match = /\[CASE:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/.exec(test.title)
    if (!match) return []
    const detail = test.error ? ` · ${test.error}` : ''
    return [{ caseId: match[1], status: test.status, evidence: `Playwright JSON · ${test.title} · ${test.status}${detail}` }]
  })
}

function runProjectPlaywright(projectPath: string, cli: string, options: UiRunOptions, configPath?: string, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): NodeTestOutcome {
  const projectCli = join(projectPath, 'node_modules', '@playwright', 'test', 'cli.js')
  const resolvedCli = existsSync(projectCli) ? projectCli : cli
  const entryUrl = options.entryUrl?.trim() ? options.entryUrl : undefined
  const runEnv: NodeJS.ProcessEnv = { ...sandboxEnvironment(process.env), ...(options.env ?? {}) }
  if (entryUrl) runEnv.TEST_AGENT_UI_ENTRY_URL = entryUrl
  let temporaryPlaywrightBridge: string | undefined
  let temporaryConfigPath: string | undefined
  if (options.file) {
    const projectPlaywright = join(projectPath, 'node_modules', '@playwright', 'test')
    if (!existsSync(join(projectPlaywright, 'package.json'))) {
      temporaryPlaywrightBridge = projectPlaywright
      mkdirSync(projectPlaywright, { recursive: true })
      writeFileSync(join(projectPlaywright, 'package.json'), JSON.stringify({
        name: '@playwright/test',
        private: true,
        type: 'module',
        exports: './index.mjs'
      }), 'utf8')
      const playwrightModuleUrl = pathToFileURL(join(dirname(cli), 'index.mjs')).href
      writeFileSync(join(projectPlaywright, 'index.mjs'), buildPlaywrightModuleBridgeSource(playwrightModuleUrl), 'utf8')
    }
    if (!configPath) {
      const configRoot = join(projectPath, '.test-agent', 'pw-configs')
      mkdirSync(configRoot, { recursive: true })
      temporaryConfigPath = join(configRoot, `playwright-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`)
      writeFileSync(temporaryConfigPath, `export default {
  testDir: ${JSON.stringify(projectPath)},
  fullyParallel: false,
  use: { channel: 'msedge', headless: true, trace: 'on', video: 'off' },
  reporter: [['json']]
}
`, 'utf8')
    }
  }
  // 确保使用系统 Edge 浏览器（项目未预装 chromium 二进制时的回退）
  if (!runEnv.PW_BROWSER_CHANNEL) runEnv.PW_BROWSER_CHANNEL = 'msedge'
  // 构造命令行参数，可选指定单个测试文件
  const testArgs = ['test', '--reporter=json', '--trace=on']
  if (temporaryConfigPath) testArgs.push('--config', temporaryConfigPath)
  if (options.file) {
    assertInsideProject(projectPath, resolve(projectPath, options.file))
    testArgs.push(options.file)
  }
  let result: import('node:child_process').SpawnSyncReturns<string>
  try {
    result = spawnSandboxed(sandbox, 'node', [resolvedCli, ...testArgs], {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      env: runEnv
    }, extraWritableDirs)
  } finally {
    if (temporaryPlaywrightBridge) {
      try { rmSync(temporaryPlaywrightBridge, { recursive: true, force: true }) } catch { /* best-effort temporary bridge cleanup */ }
    }
    if (temporaryConfigPath) {
      try { rmSync(temporaryConfigPath, { force: true }) } catch { /* best-effort temporary config cleanup */ }
    }
  }
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const report = parsePlaywrightReport(result.stdout ?? '')
  const uiSteps = report.tests.flatMap((test) => {
    if (test.steps.length > 0) return test.steps
    return [{
      name: test.title,
      status: test.status,
      durationMs: test.durationMs,
      ...(test.error ? { error: test.error } : {}),
      ...(test.status === 'failed' && test.screenshots.length > 0 ? { screenshot: relativeToProject(projectPath, test.screenshots[0]) } : {})
    }]
  }).map((step) => ({
    name: step.name,
    status: step.status,
    durationMs: step.durationMs,
    ...(step.error ? { error: step.error } : {}),
    ...(step.screenshot ? { screenshot: relativeToProject(projectPath, step.screenshot) } : {})
  }))
  const screenshots = [...new Set(report.tests.flatMap((test) => test.screenshots).map((path) => relativeToProject(projectPath, path)))].filter((path): path is string => Boolean(path))
  const video = report.tests.map((test) => test.video).find((path) => Boolean(path))
  const trace = report.tests.map((test) => test.trace).find((path) => Boolean(path))
  const webServerHint = detectWebServerFailure(raw, entryUrl)
  const hintSteps = webServerHint && report.stats.tests === 0
    ? [{ name: 'dev server 启动诊断', status: 'failed' as const, durationMs: 0, error: webServerHint }]
    : []
  return {
    ok: result.status === 0,
    ...report.stats,
    coverage: null,
    compileError: false,
    raw: webServerHint ? `${raw}\n\n[可操作提示] ${webServerHint}` : raw,
    screenshots: [...new Set(screenshots)],
    uiSteps: [...hintSteps, ...uiSteps],
    recording: {
      video: relativeToProject(projectPath, video),
      trace: relativeToProject(projectPath, trace)
    },
    caseResults: parsePlaywrightCaseResults(report.tests)
  }
}

function runGenericPlaywrightSmoke(projectPath: string, cli: string, options: UiRunOptions, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): NodeTestOutcome {
  const stamp = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scaffoldRoot = join(projectPath, '.test-agent', 'pw', stamp)
  const screenshotDir = join(projectPath, '.test-agent', 'screenshots', stamp)
  const outputDir = join(projectPath, '.test-agent', 'ui-output', stamp)
  const entryUrl = options.entryUrl?.trim() ? options.entryUrl : undefined
  const baseUrl = entryUrl ?? 'http://127.0.0.1:5199'
  const playwrightTestModule = pathToFileURL(join(dirname(cli), 'index.js')).href
  const webServerBlock = entryUrl
    ? ''
    : `  webServer: {
    command: 'cmd /c "cd /d ' + project + ' && npm run dev -- --host 127.0.0.1 --port 5199"',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 180000
  },
`
  mkdirSync(join(scaffoldRoot, 'tests'), { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(join(scaffoldRoot, 'package.json'), '{"type":"module"}', 'utf8')
  writeFileSync(join(scaffoldRoot, 'pw.config.js'), `
const project = ${JSON.stringify(projectPath)}
export default {
  testDir: './tests',
  outputDir: ${JSON.stringify(outputDir)},
  timeout: 120000,
  fullyParallel: false,
  use: { baseURL: ${JSON.stringify(baseUrl)}, channel: 'msedge', headless: true, trace: 'on', video: 'off' },
  screenshot: 'only-on-failure',
${webServerBlock}  reporter: [['json']]
}
`, 'utf8')
  writeFileSync(join(scaffoldRoot, 'tests', 'smoke.spec.js'), `
import playwrightTest from ${JSON.stringify(playwrightTestModule)}
const { test, expect } = playwrightTest
import { mkdirSync, writeFileSync } from 'node:fs'
const shotDir = process.env.TEST_AGENT_SCREENSHOT_DIR
const steps = []
function record(name, file) {
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true })
    steps.push({ name, file })
    writeFileSync(shotDir + '/steps.json', JSON.stringify(steps, null, 2), 'utf8')
  }
}
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== 'passed' && shotDir) {
    await page.screenshot({ path: shotDir + '/99-failure.png', fullPage: true }).catch(() => {})
  }
})
test('frontend loads, fills and clicks', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).not.toBeEmpty()
  const homeTitle = (await page.title()) || '未命名页面'
  await test.step('打开首页：' + homeTitle, async () => {
    record('打开首页：' + homeTitle, '01-home.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/01-home.png', fullPage: true })
  })
  const inputs = page.locator('input:not([type="hidden"]), textarea, select')
  const inputCount = Math.min(await inputs.count(), 5)
  await test.step('填写表单：' + inputCount + ' 个字段', async () => {
    if (inputCount > 0) {
      for (let i = 0; i < inputCount; i += 1) {
        const el = inputs.nth(i)
        const type = ((await el.getAttribute('type')) ?? '').toLowerCase()
        const tag = await el.evaluate((node) => node.tagName.toLowerCase())
        if (tag === 'select') {
          await el.selectOption({ index: 0 }).catch(() => {})
        } else if (type === 'checkbox' || type === 'radio') {
          await el.check().catch(() => {})
        } else {
          await el.fill(type === 'email' ? 'demo@example.com' : type === 'password' ? 'Test1234!' : 'demo value').catch(() => {})
        }
      }
    }
    record('填写表单：' + inputCount + ' 个字段', '02-form.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/02-form.png', fullPage: true })
  })
  const primary = page.locator('button[type="submit"], input[type="submit"], button:has-text("登录"), button:has-text("提交"), button:has-text("确定")')
  const target = (await primary.count()) > 0 ? primary.first() : page.locator('a[href], button, [role="button"]').first()
  const targetText = ((await target.textContent()) || '').trim() || '主要按钮'
  await test.step('点击按钮：' + targetText, async () => {
    await target.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(900)
    record('点击按钮：' + targetText, '03-after-click.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/03-after-click.png', fullPage: true })
  })
  await test.step('检查页面反馈', async () => {
    await expect(page.locator('body')).not.toBeEmpty()
    record('检查页面反馈', '04-result.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/04-result.png', fullPage: true })
  })
})
`, 'utf8')
  try {
    const runEnv: NodeJS.ProcessEnv = { ...sandboxEnvironment(process.env), ...(options.env ?? {}), TEST_AGENT_SCREENSHOT_DIR: screenshotDir }
    if (entryUrl) runEnv.TEST_AGENT_UI_ENTRY_URL = entryUrl
    const result = spawnSandboxed(sandbox, 'node', [cli, 'test', '--config', join(scaffoldRoot, 'pw.config.js')], {
      cwd: scaffoldRoot,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      env: runEnv
    }, extraWritableDirs)
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const report = parsePlaywrightReport(result.stdout ?? '')
    const manualScreenshots = existsSync(screenshotDir)
      ? readdirSync(screenshotDir).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).sort().map((name) => relative(projectPath, join(screenshotDir, name)))
      : []
    const attachmentScreenshots = report.tests.flatMap((test) => test.screenshots).map((path) => relativeToProject(projectPath, path)).filter((path): path is string => Boolean(path))
    const stepScreenshots = new Map<string, string>()
    const stepManifestPath = join(screenshotDir, 'steps.json')
    if (existsSync(stepManifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(stepManifestPath, 'utf8')) as Array<{ name: string; file: string }>
        for (const item of manifest) stepScreenshots.set(item.name, relative(projectPath, join(screenshotDir, item.file)))
      } catch {
        // 忽略步骤清单解析失败，不影响执行结果
      }
    }
    const screenshots = [...new Set([...manualScreenshots, ...attachmentScreenshots])]
    const failureShot = manualScreenshots.find((path) => path.includes('failure'))
    const uiSteps = report.tests.flatMap((test) => {
      if (test.steps.length > 0) {
        return test.steps.map((step) => {
          const stepShot = stepScreenshots.get(step.name)
          const resolvedShot = step.status === 'failed'
            ? attachmentScreenshots[0] ?? failureShot
            : stepShot
          return {
            name: step.name,
            status: step.status,
            durationMs: step.durationMs,
            ...(step.error ? { error: step.error } : {}),
            ...(resolvedShot ? { screenshot: resolvedShot } : {})
          }
        })
      }
      const failedShot = attachmentScreenshots[0] ?? failureShot
      return [{
        name: test.title,
        status: test.status,
        durationMs: test.durationMs,
        ...(test.error ? { error: test.error } : {}),
        ...(test.status === 'failed' && failedShot ? { screenshot: failedShot } : {})
      }]
    })
    const video = report.tests.map((test) => test.video).find((path) => Boolean(path))
    const trace = report.tests.map((test) => test.trace).find((path) => Boolean(path))
    const webServerHint = detectWebServerFailure(raw, entryUrl)
    const hintSteps = webServerHint && report.stats.tests === 0
      ? [{ name: 'dev server 启动诊断', status: 'failed' as const, durationMs: 0, error: webServerHint }]
      : []
    return {
      ok: result.status === 0,
      ...report.stats,
      coverage: null,
      compileError: false,
      raw: webServerHint ? `${raw}\n\n[可操作提示] ${webServerHint}` : raw,
      screenshots,
      uiSteps: [...hintSteps, ...uiSteps],
      recording: { video: relativeToProject(projectPath, video), trace: relativeToProject(projectPath, trace) },
      caseResults: parsePlaywrightCaseResults(report.tests)
    }
  } finally {
    try {
      rmSync(scaffoldRoot, { recursive: true, force: true })
    } catch {
      // cleanup failure ignored
    }
  }
}

/** Independent Playwright UI verification: prefer the project's own config/tests, fall back to a generic smoke. */
export function runPlaywrightUiTests(projectPath: string, options: UiRunOptions = {}, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }, extraWritableDirs?: readonly string[]): NodeTestOutcome {
  assertInsideProject(projectPath, projectPath)
  const cli = resolveBundledPlaywrightCli()
  const config = findPlaywrightConfig(projectPath)
  // An explicit file is stronger evidence than the presence of a repository-level
  // config. Generated tests must never be silently replaced by the generic smoke.
  return shouldRunExplicitPlaywrightFile(config, options.file)
    ? runProjectPlaywright(projectPath, cli, options, config, sandbox, extraWritableDirs)
    : runGenericPlaywrightSmoke(projectPath, cli, options, sandbox, extraWritableDirs)
}

