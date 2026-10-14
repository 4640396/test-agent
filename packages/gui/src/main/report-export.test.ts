import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskSnapshot } from '../types.js'
import { reportHtml, reportMarkdown, reportSummaryText } from './report-export.js'

const snapshot: TaskSnapshot = {
  taskId: 'production-run-1',
  status: 'completed',
  logs: [],
  lanes: [],
  artifacts: [],
  report: {
    provenance: {
      gitCommitSha: '0123456789abcdef0123456789abcdef01234567',
      gitDirty: true,
      projectType: 'mixed',
      executionEnvironment: 'win32 10.0.26100 (x64) · Node v22.0.0',
      targetUrl: 'http://127.0.0.1:8080',
      capturedAt: '2026-10-13T01:02:03.000Z'
    },
    passed: 3,
    failed: 1,
    coverage: 87,
    summary: '前后端联合验证完成',
    cases: [
      { id: 'ui-login', title: '登录 <成功>', scenario: '用户登录', steps: ['打开页面'], expected: '进入首页', priority: 'high', layer: 'ui' },
      { id: 'api-health', title: '健康检查', scenario: '读取服务状态', steps: ['请求接口'], expected: '服务正常', priority: 'high', layer: 'api', method: 'GET', path: '/health', expectedStatus: 200, expectedJsonSubset: { status: 'ok' } }
    ],
    caseResults: [
      { caseId: 'ui-login', status: 'passed', tool: 'playwright_test', evidence: 'locator assertion passed' },
      { caseId: 'api-health', status: 'passed', tool: 'api_test', evidence: 'HTTP 200' }
    ],
    api: {
      pass: 1,
      fail: 1,
      skipped: 0,
      details: [
        { caseId: 'api-health', method: 'GET', path: '/health', status: 'passed', statusCode: 200, durationMs: 18 },
        { caseId: 'api-missing', method: 'GET', path: '/missing', status: 'failed', statusCode: 500, reason: '期望 404' }
      ]
    },
    uiSteps: [{ name: '提交登录', status: 'passed', durationMs: 320, screenshot: 'artifacts/login.png' }],
    coverageEvidence: { source: 'coverage-final.json', generatedAt: '2026-10-11T10:00:00.000Z', gaps: [{ file: 'src/auth.ts', uncoveredLines: [20, 21] }] },
    riskPoints: [{ severity: 'high', file: 'src/auth.ts', message: '缺少鉴权', suggestion: '增加鉴权中间件' }],
    fixes: [{ severity: 'high', file: 'src/auth.ts', title: '修复鉴权', summary: '补充访问控制' }],
    fixActions: [{ diagnosisName: '鉴权失败', category: 'real-bug', confidence: 'high', files: [{ path: 'src/auth.ts', diff: '+ guard' }], rerunResult: { passed: 3, failed: 0 }, patch: 'patch' }],
    escalations: [
      { timestamp: '2026-10-11T09:00:00.000Z', escalationId: 'decision-1', role: 'tester', question: '是否使用测试账号', resolved: false, degraded: false },
      { timestamp: '2026-10-11T09:01:00.000Z', escalationId: 'decision-1', role: 'tester', question: '是否使用测试账号', resolved: true, degraded: false, answer: '使用隔离账号' }
    ],
    fitness: { iterations: 1, k: 2, converged: true, stoppedReason: 'converged', message: '失败已修复', curve: [] },
    gate: { coverageTarget: 80, coverage: 87, effectiveRate: 75, passed: false, reason: '有效用例率低于 80%' }
  }
}

describe('production report exports', () => {
  it('includes auditable frontend and backend evidence in Markdown', () => {
    const output = reportMarkdown(snapshot)
    expect(output).toContain('## 逐用例执行证据')
    expect(output).toContain('## 运行溯源')
    expect(output).toContain('0123456789abcdef0123456789abcdef01234567')
    expect(output).toContain('| dirty | mixed |')
    expect(output).toContain('playwright_test')
    expect(output).toContain('## API 测试（1 通过 / 1 失败 / 0 跳过）')
    expect(output).toContain('GET /health')
    expect(output).toContain('HTTP 200；JSON⊇{"status":"ok"}')
    expect(output).toContain('## UI 执行步骤')
    expect(output).toContain('## 覆盖率证据')
    expect(output).toContain('## 风险点')
    expect(output).toContain('## 建议修复')
    expect(output).toContain('## 已执行修复与重跑')
    expect(output).toContain('## 执行决策审计')
    expect(output).toContain('使用隔离账号')
    expect(output).toContain('## 自动修复收敛')
    expect(output).toContain('未通过（有效用例率低于 80%）')
  })

  it('includes the same evidence in HTML and escapes project-controlled text', () => {
    const output = reportHtml(snapshot)
    expect(output).toContain('逐用例执行证据')
    expect(output).toContain('运行溯源')
    expect(output).toContain('http://127.0.0.1:8080')
    expect(output).toContain('playwright_test')
    expect(output).toContain('API 测试（1 通过 / 1 失败 / 0 跳过）')
    expect(output).toContain('GET /health')
    expect(output).toContain('HTTP 200；JSON⊇{&quot;status&quot;:&quot;ok&quot;}')
    expect(output).toContain('UI 执行步骤')
    expect(output).toContain('覆盖率证据')
    expect(output).toContain('风险点')
    expect(output).toContain('建议修复')
    expect(output).toContain('已执行修复与重跑')
    expect(output).toContain('执行决策审计')
    expect(output).toContain('使用隔离账号')
    expect(output).toContain('自动修复收敛')
    expect(output).toContain('登录 &lt;成功&gt;')
    expect(output).not.toContain('登录 <成功>')
  })

  it('puts evidence counts and gate reason in the clipboard summary', () => {
    const output = reportSummaryText(snapshot)
    expect(output).toContain('逐用例证据：2 条')
    expect(output).toContain('运行溯源：0123456789abcdef0123456789abcdef01234567 · dirty=true')
    expect(output).toContain('API：1 通过 / 1 失败 / 0 跳过')
    expect(output).toContain('质量门禁：未通过（有效用例率低于 80%）')
  })

  it('embeds only bounded image files inside the selected project', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-agent-report-'))
    const project = join(root, 'project')
    mkdirSync(join(project, 'artifacts'), { recursive: true })
    writeFileSync(join(project, 'artifacts', 'inside.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(root, 'outside.png'), Buffer.from('secret-outside-project'))
    writeFileSync(join(project, 'artifacts', 'not-image.txt'), Buffer.from('secret-text'))
    try {
      const secured: TaskSnapshot = {
        ...snapshot,
        report: { ...snapshot.report!, screenshots: ['artifacts/inside.png', '../outside.png', 'artifacts/not-image.txt'] }
      }
      const output = reportHtml(secured, project)
      expect(output).toContain('data:image/png;base64,iVBORw==')
      expect(output).not.toContain(Buffer.from('secret-outside-project').toString('base64'))
      expect(output).not.toContain(Buffer.from('secret-text').toString('base64'))
      expect(output).toContain('../outside.png（本机未找到）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
