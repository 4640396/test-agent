import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlaywrightModuleBridgeSource, decodeProcessOutput, enrichFailedCasesWithSurefire, gradleCommandSpec, mavenCommandSpec, nodeTestCommandSpec, parseCaseMarkerResults, parseJacocoSummary, parseJUnitXmlTotals, parsePlaywrightCaseResults, parsePlaywrightReport, parseSurefireSummary, parseSurefireTestCases, parseVitestStats, readCurrentGradleResults, readCurrentSurefireCases, readCurrentSurefireTotals, readFreshJacocoCoverage, runApiCases, runMavenCommand, runNodeUnitTests, scrubExecutionEnvironment, shouldRunExplicitPlaywrightFile } from '../src/core/validator.js'

const projects: string[] = []

it('uses the Windows Maven launcher instead of the extensionless Unix script', () => {
  expect(mavenCommandSpec('C:\\project', 'win32')).toEqual({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'mvn.cmd test'],
    cwd: 'C:\\project'
  })
})

it('prefers a project Maven wrapper over a machine-global Maven installation', () => {
  const root = makeProject({ 'mvnw.cmd': '@echo off', mvnw: '#!/bin/sh' })
  expect(mavenCommandSpec(root, 'win32').args.at(-1)).toBe('mvnw.cmd test')
  expect(mavenCommandSpec(root, 'linux')).toMatchObject({ command: './mvnw', args: ['test'] })
})

it('prefers a project Gradle wrapper over a machine-global Gradle installation', () => {
  const root = makeProject({ 'gradlew.bat': '@echo off', gradlew: '#!/bin/sh' })
  expect(gradleCommandSpec(root, 'win32').args.at(-1)).toBe('gradlew.bat test')
  expect(gradleCommandSpec(root, 'linux')).toMatchObject({ command: './gradlew', args: ['test'] })
})

it.each([
  ['pnpm@9.12.0', 'pnpm.cmd test', 'pnpm'],
  ['yarn@4.5.0', 'yarn.cmd test', 'yarn'],
  ['bun@1.1.0', 'bun.exe test', 'bun'],
  ['npm@10.8.0', 'npm.cmd test', 'npm']
] as const)('uses the project package manager %s', (packageManager, command, expected) => {
  const root = makeProject({ 'package.json': JSON.stringify({ packageManager, scripts: { test: 'node --test' } }) })
  expect(nodeTestCommandSpec(root, 'win32')).toMatchObject({ command: 'cmd.exe', args: ['/d', '/s', '/c', command], packageManager: expected })
})

it('decodes Windows GBK javac diagnostics across output chunks', () => {
  const gbk = Buffer.from([0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xb7, 0xfb, 0xba, 0xc5])
  expect(decodeProcessOutput([gbk.subarray(0, 3), gbk.subarray(3)])).toBe('找不到符号')
})

it('keeps UTF-8 Maven output intact across output chunks', () => {
  const utf8 = Buffer.from('测试代码编译完成', 'utf8')
  expect(decodeProcessOutput([utf8.subarray(0, 5), utf8.subarray(5)])).toBe('测试代码编译完成')
})

it('extracts stable plan IDs and statuses from Node, TAP, and Vitest output', () => {
  const output = [
    '✓ [CASE:UNIT_OK] returns the total',
    'not ok 2 - [CASE:UNIT_FAIL] rejects invalid input',
    'ok 3 - [CASE:UNIT_SKIP] optional path # SKIP',
    'unrelated framework output'
  ].join('\n')
  expect(parseCaseMarkerResults(output)).toEqual([
    { caseId: 'UNIT_OK', status: 'passed', evidence: '✓ [CASE:UNIT_OK] returns the total' },
    { caseId: 'UNIT_FAIL', status: 'failed', evidence: 'not ok 2 - [CASE:UNIT_FAIL] rejects invalid input' },
    { caseId: 'UNIT_SKIP', status: 'skipped', evidence: 'ok 3 - [CASE:UNIT_SKIP] optional path # SKIP' }
  ])
})

it('links Playwright JSON tests to plan IDs without guessing from unrelated titles', () => {
  const parsed = parsePlaywrightReport(JSON.stringify({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{ specs: [
      { title: '[CASE:UI_LOGIN] login flow', tests: [{ results: [{ status: 'passed', duration: 20 }] }] },
      { title: 'unlinked smoke', tests: [{ results: [{ status: 'failed', duration: 10, error: { message: 'boom' } }] }] }
    ] }]
  }))
  expect(parsePlaywrightCaseResults(parsed.tests)).toEqual([
    { caseId: 'UI_LOGIN', status: 'passed', evidence: 'Playwright JSON · [CASE:UI_LOGIN] login flow · passed' }
  ])
})

it('runs an explicitly supplied Playwright file even when the project has no config', () => {
  expect(shouldRunExplicitPlaywrightFile(undefined, 'e2e/generated.spec.js')).toBe(true)
  expect(shouldRunExplicitPlaywrightFile('playwright.config.ts', undefined)).toBe(true)
  expect(shouldRunExplicitPlaywrightFile(undefined, undefined)).toBe(false)
})

it('bridges generated test imports to the bundled Playwright module', () => {
  const source = buildPlaywrightModuleBridgeSource('file:///agent/node_modules/@playwright/test/index.mjs')
  expect(source).toContain('export * from')
  expect(source).toContain('file:///agent/node_modules/@playwright/test/index.mjs')
  expect(source).toContain('export { default }')
})

it('parses Playwright JSON reporter into UI steps and recording artifacts', () => {
  const report = JSON.stringify({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{
      specs: [{
        title: 'login flow',
        tests: [{
          results: [{
            status: 'failed',
            duration: 1200,
            error: { message: 'login button not found' },
            steps: [
              { title: '打开登录页', duration: 200 },
              { title: '点击登录按钮', duration: 300, status: 'failed', error: { message: 'login button not found' } }
            ],
            attachments: [
              { name: 'screenshot', contentType: 'image/png', path: 'C:\\works\\app\\failure.png' },
              { name: 'video', contentType: 'video/webm', path: 'C:\\works\\app\\video.webm' },
              { name: 'trace', contentType: 'application/zip', path: 'C:\\works\\app\\trace.zip' }
            ]
          }]
        }]
      }]
    }]
  })
  const parsed = parsePlaywrightReport(report)
  expect(parsed.stats).toMatchObject({ tests: 2, pass: 1, fail: 1 })
  expect(parsed.tests[0]).toMatchObject({ title: 'login flow', status: 'failed', video: 'C:\\works\\app\\video.webm', trace: 'C:\\works\\app\\trace.zip' })
  expect(parsed.tests[0].steps).toEqual([
    expect.objectContaining({ name: '打开登录页', status: 'passed', durationMs: 200 }),
    expect.objectContaining({ name: '点击登录按钮', status: 'failed', error: 'login button not found', screenshot: 'C:\\works\\app\\failure.png' })
  ])
})

function makeProject(files: Record<string, string>): string {
  const root = join(tmpdir(), `cimdev-validator-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  projects.push(root)
  return root
}

afterAll(() => {
  for (const project of projects) {
    try {
      rmSync(project, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
})

describe('validator', () => {
  it('执行环境保留工具链变量但移除凭据', () => {
    expect(scrubExecutionEnvironment({ PATH: 'bin', JAVA_HOME: 'jdk', TEST_AGENT_API_TOKEN: 'secret', DB_PASSWORD: 'secret', AWS_ACCESS_KEY_ID: 'secret' }))
      .toEqual({ PATH: 'bin', JAVA_HOME: 'jdk' })
  })

  it('超时会终止受管根进程及其子进程树', { timeout: 15_000, retry: 2 }, async () => {
    const fixture = join(process.cwd(), 'packages', 'test-agent', 'test', 'fixtures', 'slow-process.cjs')
    const outcome = await runMavenCommand(process.cwd(), { command: process.execPath, args: [fixture], cwd: process.cwd() }, AbortSignal.timeout(3000))
    expect(outcome).toMatchObject({ ok: false, aborted: true, timedOut: true })
    const childPid = Number(/CHILD_PID=(\d+)/.exec(outcome.raw)?.[1])
    expect(childPid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(() => process.kill(childPid, 0)).toThrow()
  })
  it('独立重跑 node 测试并解析通过数、失败数与覆盖率', () => {
    const root = makeProject({
      'package.json': '{"name":"v","type":"module"}',
      'src/math.js': 'export const add = (a, b) => a + b\nexport function unused() {\n  return 42\n}\n',
      'test/math.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n"
    })
    const outcome = runNodeUnitTests(root)
    expect(outcome.ok).toBe(true)
    expect(outcome.tests).toBeGreaterThanOrEqual(1)
    expect(outcome.pass).toBeGreaterThanOrEqual(1)
    expect(outcome.fail).toBe(0)
    expect(outcome.coverage).not.toBeNull()
    expect(outcome.coverageEvidence?.source).toContain('node --test')
    expect(outcome.coverageEvidence?.gaps.some((gap) => gap.file.includes('math.js'))).toBe(true)
  })

  it('编译错误被识别为 compileError', () => {
    const root = makeProject({
      'package.json': '{"name":"v","type":"module"}',
      'test/bad.test.js': "import test from 'node:test'\ntest('bad', () => { this is not valid js })\n"
    })
    const outcome = runNodeUnitTests(root)
    expect(outcome.compileError).toBe(true)
  })

  it('解析 surefire 汇总行', () => {
    const summary = parseSurefireSummary('Tests run: 3, Failures: 1, Errors: 0, Skipped: 1, Time elapsed: 0.5 sec')
    expect(summary).toEqual({ tests: 3, fail: 1 })
    expect(parseSurefireSummary('no summary')).toBeNull()
  })

  it('解析 Gradle JUnit XML 汇总与逐用例证据', () => {
    const root = makeProject({
      'build/test-results/test/TEST-demo.PriceServiceTest.xml': '<?xml version="1.0"?><testsuite name="demo.PriceServiceTest" tests="2" skipped="0" failures="1" errors="0"><testcase name="calculatesTotal" classname="demo.PriceServiceTest"/><testcase name="rejectsNegative" classname="demo.PriceServiceTest"><failure message="expected exception"/></testcase></testsuite>'
    })
    const xml = '<?xml version="1.0"?><testsuite tests="2" failures="1" errors="0"><testcase name="ok"/><testcase name="bad"><failure/></testcase></testsuite>'
    expect(parseJUnitXmlTotals(xml)).toEqual({ tests: 2, pass: 1, fail: 1 })
    const result = readCurrentGradleResults(root, Date.now() - 1_000)
    expect(result).toMatchObject({ tests: 2, pass: 1, fail: 1 })
    expect(result.caseResults).toEqual([
      expect.objectContaining({ caseId: 'calculatesTotal', status: 'passed', evidence: expect.stringContaining('Gradle JUnit XML') }),
      expect.objectContaining({ caseId: 'rejectsNegative', status: 'failed' })
    ])
  })

  it('只统计本次运行产生的 Surefire 报告，不把旧报告算成新测试', () => {
    const root = makeProject({
      'target/surefire-reports/TEST-old.txt': 'Tests run: 10, Failures: 0, Errors: 0, Skipped: 0',
      'target/surefire-reports/TEST-current.txt': 'Tests run: 2, Failures: 1, Errors: 0, Skipped: 0',
    })
    const old = join(root, 'target', 'surefire-reports', 'TEST-old.txt')
    utimesSync(old, new Date(0), new Date(0))
    const startedAtMs = Date.now() - 100
    expect(readCurrentSurefireTotals(root, startedAtMs)).toEqual({ tests: 2, pass: 1, fail: 1 })
  })

  it('命令成功但没有产生新报告时，不沿用上次 Maven 测试数', async () => {
    const root = makeProject({
      'target/surefire-reports/TEST-stale.txt': 'Tests run: 12, Failures: 0, Errors: 0, Skipped: 0',
    })
    const stale = join(root, 'target', 'surefire-reports', 'TEST-stale.txt')
    utimesSync(stale, new Date(0), new Date(0))
    const outcome = await runMavenCommand(root, { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root })
    expect(outcome).toMatchObject({ ok: true, tests: 0, pass: 0, fail: 0 })
  })

  it('解析 JaCoCo 总覆盖率并列出真实未覆盖行', () => {
    const xml = '<report><package name="com/acme"><sourcefile name="Demo.java"><line nr="7" mi="2" ci="0"/><line nr="8" mi="0" ci="2"/></sourcefile></package><counter type="BRANCH" missed="3" covered="1"/><counter type="LINE" missed="2" covered="8"/></report>'
    expect(parseJacocoSummary(xml)).toEqual({
      line: 80,
      branch: 25,
      gaps: [{ file: 'com/acme/Demo.java', uncoveredLines: [7] }],
    })
  })

  it('只采信本次执行更新的 JaCoCo 报告', () => {
    const root = makeProject({
      'target/site/jacoco/jacoco.xml': '<report><counter type="LINE" missed="1" covered="9"/></report>',
    })
    const report = join(root, 'target', 'site', 'jacoco', 'jacoco.xml')
    utimesSync(report, new Date(0), new Date(0))
    expect(readFreshJacocoCoverage(root, Date.now())).toEqual({ coverage: null, branchCoverage: null })
    const now = new Date()
    utimesSync(report, now, now)
    expect(readFreshJacocoCoverage(root, now.getTime() - 100)).toMatchObject({ coverage: 90, branchCoverage: null })
  })

  it('读取 Gradle 默认目录中的 JaCoCo 报告', () => {
    const root = makeProject({
      'build/reports/jacoco/test/jacocoTestReport.xml': '<report><counter type="LINE" missed="2" covered="8"/><counter type="BRANCH" missed="1" covered="3"/></report>'
    })
    const result = readFreshJacocoCoverage(root, Date.now() - 1_000)
    expect(result).toMatchObject({ coverage: 80, branchCoverage: 75, evidence: { source: 'build/reports/jacoco/test/jacocoTestReport.xml' } })
  })

  it('解析本次 Surefire XML 的逐条结果且排除旧 XML', () => {
    const current = '<testsuite><testcase name="TC1" classname="demo.Test"/><testcase name="TC2" classname="demo.Test"><failure message="bad"/></testcase><testcase name="TC3" classname="demo.Test"><skipped/></testcase></testsuite>'
    expect(parseSurefireTestCases(current).map(item => [item.caseId, item.status])).toEqual([
      ['TC1', 'passed'], ['TC2', 'failed'], ['TC3', 'skipped'],
    ])
    const root = makeProject({
      'target/surefire-reports/TEST-old.xml': '<testsuite><testcase name="OLD" classname="demo.Test"/></testsuite>',
      'target/surefire-reports/TEST-current.xml': current,
    })
    utimesSync(join(root, 'target', 'surefire-reports', 'TEST-old.xml'), new Date(0), new Date(0))
    expect(readCurrentSurefireCases(root, Date.now() - 100).map(item => item.caseId)).toEqual(['TC1', 'TC2', 'TC3'])
  })

  it('runApiCases 按用例执行 HTTP 断言', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const outcome = await runApiCases([
        { id: 'a', title: 't', scenario: 'GET /hello', steps: ['请求 /hello'], expected: '200 成功', priority: 'high', layer: 'api' },
        { id: 'b', title: 't', scenario: 'GET /missing', steps: ['请求 /missing'], expected: '200 成功', priority: 'medium', layer: 'api' }
      ], `http://127.0.0.1:${port}`)
      expect(outcome.pass).toBe(1)
      expect(outcome.fail).toBe(1)
      expect(outcome.skipped).toBe(0)
    } finally {
      server.close()
    }
  })

  it('runApiCases sends structured JSON bodies and verifies response content', async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const requestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'created', order: { id: 42, name: requestBody?.name } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const outcome = await runApiCases([
        {
          id: 'create-order', title: 'create', scenario: 'create order', steps: ['POST /orders'], expected: '201', priority: 'high', layer: 'api',
          method: 'POST', path: '/orders', body: { name: 'book' }, expectedStatus: 201,
          expectedBodyContains: ['created'], expectedJsonSubset: { status: 'created', order: { name: 'book' } }
        },
        {
          id: 'wrong-content', title: 'wrong', scenario: 'verify body', steps: ['POST /orders'], expected: '201', priority: 'medium', layer: 'api',
          method: 'POST', path: '/orders', body: { name: 'book' }, expectedStatus: 201,
          expectedJsonSubset: { status: 'missing' }
        }
      ], `http://127.0.0.1:${port}`)
      expect(outcome).toMatchObject({ pass: 1, fail: 1, skipped: 0 })
      expect(outcome.details[0].assertions).toEqual(expect.arrayContaining(['HTTP 201', '响应包含=created', '响应 JSON 子集匹配']))
      expect(outcome.details[1].reason).toContain('响应 JSON 不包含期望字段和值')
    } finally {
      server.close()
    }
  })
})

describe('parseVitestStats', () => {
  const VITEST_OUTPUT = `\n  \u2713 src/Calculator.test.ts (7 tests) 9ms\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)\n   Start at  16:21:45\n\n %  Coverage report from v8\n---------------|---------|----------|---------|---------|-------------------\nFile           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s \n---------------|---------|----------|---------|---------|-------------------\nAll files      |    93.1 |       80 |     100 |    93.1 |                   \n Calculator.ts |    93.1 |       80 |     100 |    93.1 | 30-31             \n---------------|---------|----------|---------|---------|-------------------\n`

  it('解析 vitest 通过/失败数', () => {
    const stats = parseVitestStats(VITEST_OUTPUT)
    expect(stats.tests).toBe(7)
    expect(stats.pass).toBe(7)
    expect(stats.fail).toBe(0)
  })

  it('解析 vitest coverage（line + branch）', () => {
    const stats = parseVitestStats(VITEST_OUTPUT)
    expect(stats.coverage).toBe(93.1)
    expect(stats.branchCoverage).toBe(80)
  })

  it('无 coverage 表时 coverage 为 null', () => {
    const noCov = ' Test Files  1 passed (1)\n      Tests  7 passed (7)\n'
    const stats = parseVitestStats(noCov)
    expect(stats.coverage).toBeNull()
    expect(stats.branchCoverage).toBeNull()
  })

  it('有失败时正确解析 fail 数', () => {
    const withFail = ' Test Files  1 failed (1)\n      Tests  6 passed (7)\n     Tests  1 failed (1)\n'
    const stats = parseVitestStats(withFail)
    expect(stats.pass).toBe(6)
    expect(stats.fail).toBe(1)
    expect(stats.tests).toBe(7)
  })

  it('无输出时返回零值', () => {
    const stats = parseVitestStats('')
    expect(stats.tests).toBe(0)
    expect(stats.pass).toBe(0)
    expect(stats.fail).toBe(0)
    expect(stats.coverage).toBeNull()
  })
})

describe('enrichFailedCasesWithSurefire (P1-4)', () => {
  const tmpRoot = join(tmpdir(), `surefire-p14-${Date.now()}`)
  beforeEach(() => { mkdirSync(tmpRoot, { recursive: true }) })
  afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ } })

  function writeSurefire(testClass: string, content: string): void {
    mkdirSync(join(tmpRoot, 'target', 'surefire-reports'), { recursive: true })
    writeFileSync(join(tmpRoot, 'target', 'surefire-reports', `TEST-${testClass}.txt`), content, 'utf8')
  }

  it('传统 JUnit：第一帧 framework 被滤，取首个被测帧', () => {
    writeSurefire('com.demo.CalcTest', `Tests run: 1, Failures: 1, in com.demo.CalcTest
1) addTest(com.demo.CalcTest)
java.lang.AssertionError: expected 5 but was 4
	at org.junit.Assert.assertEquals(Assert.java:123)
	at com.demo.Calculator.add(Calculator.java:8)
	at com.demo.CalcTest.addTest(CalcTest.java:15)
`)
    const out = enrichFailedCasesWithSurefire([{ name: 'addTest(com.demo.CalcTest)', layer: 'unit', error: '', category: '' }], tmpRoot)
    expect(out[0].testClass).toBe('com.demo.Calculator')
    expect(out[0].location).toEqual({ path: 'Calculator.java', line: 8 })
  })

  it('反射用例：全帧被滤，location 不填，testClass 从场景 JSON 取', () => {
    mkdirSync(join(tmpRoot, '.test-agent', 'scenarios'), { recursive: true })
    writeFileSync(join(tmpRoot, '.test-agent', 'scenarios', 'TC003.json'), JSON.stringify({
      id: 'TC003', title: 'Calculator.divide', target: { className: 'com.demo.Calculator', method: 'divide' },
    }), 'utf8')
    writeSurefire('com.cxmt.testagent.ReflectTestRunner', `Tests run: 1, Failures: 1, in com.cxmt.testagent.ReflectTestRunner
1) runScenario(com.cxmt.testagent.ReflectTestRunner)
java.lang.AssertionError: 场景 TC003 返回值断言失败
	at com.cxmt.testagent.ReflectTestRunner.checkReturn(ReflectTestRunner.java:199)
	at com.cxmt.testagent.ReflectTestRunner.runScenario(ReflectTestRunner.java:129)
	at java.lang.reflect.Method.invoke(Method.java:498)
`)
    const out = enrichFailedCasesWithSurefire([{ name: 'TC003', layer: 'unit', error: '', category: '', caseId: 'TC003' }], tmpRoot)
    expect(out[0].testClass).toBe('com.demo.Calculator')
    expect(out[0].location).toBeUndefined()
  })

  it('反射用例无场景 JSON：testClass + location 都不填（诚实降级）', () => {
    writeSurefire('com.cxmt.testagent.ReflectTestRunner', `Tests run: 1, Failures: 1, in com.cxmt.testagent.ReflectTestRunner
java.lang.AssertionError: 场景失败
	at com.cxmt.testagent.ReflectTestRunner.checkReturn(ReflectTestRunner.java:199)
	at java.lang.reflect.Method.invoke(Method.java:498)
`)
    const out = enrichFailedCasesWithSurefire([{ name: 'TC999', layer: 'unit', error: '', category: '' }], tmpRoot)
    expect(out[0].testClass).toBeUndefined()
    expect(out[0].location).toBeUndefined()
  })

  // P3-4：截图字段解析 + 无截图降级
  it('extracts screenshot from Playwright failure into FailedCaseRecord-like structure', () => {
    const report = JSON.stringify({
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [{
        specs: [{
          title: 'checkout flow',
          tests: [{
            results: [{
              status: 'failed',
              duration: 800,
              error: { message: 'cart total mismatch' },
              steps: [{ title: 'submit order', duration: 300, status: 'failed', error: { message: 'cart total mismatch' } }],
              attachments: [
                { name: 'screenshot', contentType: 'image/png', path: '/project/.test-agent/screenshots/fail.png' }
              ]
            }]
          }]
        }]
      }]
    })
    const parsed = parsePlaywrightReport(report)
    expect(parsed.tests[0].status).toBe('failed')
    expect(parsed.tests[0].screenshots).toContain('/project/.test-agent/screenshots/fail.png')
    // simulate what runner does: attach screenshot to FailedCaseRecord on failure
    const fc = { name: 'checkout flow', layer: 'ui', error: 'cart total mismatch', category: 'real-bug', screenshot: parsed.tests[0].screenshots[0] }
    expect(fc.screenshot).toBe('/project/.test-agent/screenshots/fail.png')
  })

  it('produces no screenshot when Playwright result has no image attachments', () => {
    const report = JSON.stringify({
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [{
        specs: [{
          title: 'api health check',
          tests: [{
            results: [{
              status: 'failed',
              duration: 100,
              error: { message: '500 error' },
              steps: [{ title: 'GET /health', duration: 50, status: 'failed', error: { message: '500 error' } }],
              attachments: []
            }]
          }]
        }]
      }]
    })
    const parsed = parsePlaywrightReport(report)
    expect(parsed.tests[0].screenshots).toEqual([])
    // simulate FailedCaseRecord without screenshot → GUI shows [无截图]
    const fc = { name: 'api health check', layer: 'api', error: '500 error', category: 'real-bug' }
    expect(fc.screenshot).toBeUndefined()
  })
})
