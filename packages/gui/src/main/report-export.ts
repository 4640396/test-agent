import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TaskSnapshot } from '../types.js'

function categoryLabel(category: string): string {
  switch (category) {
    case 'real-bug': return '真 bug'
    case 'test-defect': return '测试缺陷'
    case 'environment': return '环境问题'
    case 'flaky': return 'flaky'
    default: return category
  }
}

export function reportSummaryText(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  const lines = [
    'Test Agent 测试报告',
    `任务：${snapshot.taskId}`,
    `状态：${snapshot.status}`,
    `通过：${report?.passed ?? '--'}`,
    `失败：${report?.failed ?? '--'}`,
    `覆盖率：${report?.coverage == null ? 'N/A' : `${report.coverage}%`}`,
    report?.gate ? `质量门禁：${report.gate.passed ? '通过' : '未通过'}（${report.gate.reason}）` : '质量门禁：--'
  ]
  if (report?.summary) lines.push(`结论：${report.summary}`)
  if (report?.provenance) lines.push(`运行溯源：${report.provenance.gitCommitSha ?? '非 Git 项目'} · ${report.provenance.gitDirty == null ? 'dirty=N/A' : `dirty=${report.provenance.gitDirty}`} · ${report.provenance.projectType} · ${report.provenance.targetUrl ?? '未指定 URL'} · ${report.provenance.capturedAt}`)
  if (report?.caseResults?.length) lines.push(`逐用例证据：${report.caseResults.length} 条`)
  if (report?.api) lines.push(`API：${report.api.pass} 通过 / ${report.api.fail} 失败 / ${report.api.skipped} 跳过`)
  if (report?.failedCases?.length) {
    lines.push('失败诊断：')
    for (const item of report.failedCases) lines.push(`- ${item.name} [${categoryLabel(item.category)}] ${item.error}${item.suggestion ? `；建议：${item.suggestion}` : ''}`)
  }
  if (report?.readOnlyViolation?.changedFiles?.length) lines.push(`⚠️ read-only 违规：诊断修改了 ${report.readOnlyViolation.changedFiles.length} 个文件`)
  return lines.join('\n')
}

function cell(value: unknown): string {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function latestEscalations(snapshot: TaskSnapshot): NonNullable<NonNullable<TaskSnapshot['report']>['escalations']> {
  const latest = new Map<string, NonNullable<NonNullable<TaskSnapshot['report']>['escalations']>[number]>()
  for (const item of snapshot.report?.escalations ?? []) latest.set(item.escalationId, item)
  return [...latest.values()]
}

function apiContract(item: NonNullable<NonNullable<TaskSnapshot['report']>['cases']>[number]): string {
  if (item.layer !== 'api') return '-'
  const assertions = [
    item.expectedStatus == null ? '' : `HTTP ${item.expectedStatus}`,
    item.expectedBodyContains?.length ? `包含 ${item.expectedBodyContains.join('、')}` : '',
    item.expectedJsonSubset ? `JSON⊇${JSON.stringify(item.expectedJsonSubset)}` : ''
  ].filter(Boolean).join('；')
  return `${item.method ?? '?'} ${item.path ?? '?'}${assertions ? `；${assertions}` : ''}`
}

export function reportMarkdown(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  let md = `# Test Agent 测试报告\n\n- 任务：\`${snapshot.taskId}\`\n- 状态：${snapshot.status}\n`
  if (!report) return md
  md += `- 通过：${report.passed}\n- 失败：${report.failed}\n- 覆盖率：${report.coverage == null ? 'N/A' : `${report.coverage}%`}\n`
  if (report.provenance) {
    md += `\n## 运行溯源\n\n| Git commit | 工作树 | 项目类型 | 执行环境 | 目标 URL | 捕获时间 |\n|---|---|---|---|---|---|\n`
    md += `| ${cell(report.provenance.gitCommitSha ?? '非 Git 项目')} | ${report.provenance.gitDirty == null ? '不适用' : report.provenance.gitDirty ? 'dirty' : 'clean'} | ${cell(report.provenance.projectType)} | ${cell(report.provenance.executionEnvironment)} | ${cell(report.provenance.targetUrl ?? '未指定')} | ${cell(report.provenance.capturedAt)} |\n`
  }
  if (report.gate) md += `- 质量门禁：${report.gate.passed ? '通过' : '未通过'}（${report.gate.reason}）\n`
  if (report.durationMs !== undefined) md += `- 耗时：${Math.round(report.durationMs / 1000)}s\n`
  if (report.summary) md += `\n## 结论\n\n${report.summary}\n`
  if (report.cases?.length) {
    md += `\n## 测试计划（${report.cases.length} 条）\n\n| 用例 | 层级 | 优先级 | 场景 | 预期 | API 契约 |\n|---|---|---|---|---|---|\n`
    for (const item of report.cases) md += `| ${cell(item.title)} | ${cell(item.layer)} | ${cell(item.priority)} | ${cell(item.scenario)} | ${cell(item.expected)} | ${cell(apiContract(item))} |\n`
  }
  if (report.caseResults?.length) {
    md += `\n## 逐用例执行证据\n\n| 用例 ID | 结果 | 执行工具 | 证据 |\n|---|---|---|---|\n`
    for (const item of report.caseResults) md += `| ${cell(item.caseId)} | ${cell(item.status)} | ${cell(item.tool)} | ${cell(item.evidence)} |\n`
  }
  if (report.api) {
    md += `\n## API 测试（${report.api.pass} 通过 / ${report.api.fail} 失败 / ${report.api.skipped} 跳过）\n\n| 用例 | 请求 | 状态 | HTTP | 耗时 | 说明 |\n|---|---|---|---|---|---|\n`
    for (const item of report.api.details) md += `| ${cell(item.caseId)} | ${cell(`${item.method} ${item.path}`)} | ${cell(item.status)} | ${cell(item.statusCode)} | ${item.durationMs == null ? '-' : `${item.durationMs}ms`} | ${cell(item.reason)} |\n`
  }
  if (report.failedCases?.length) {
    md += `\n## 失败诊断\n\n| 用例 | 层级 | 分类 | 错误 | 证据 | 建议 |\n|---|---|---|---|---|---|\n`
    for (const item of report.failedCases) md += `| ${cell(item.name)} | ${cell(item.layer)} | ${cell(categoryLabel(item.category))} | ${cell(item.error)} | ${cell(item.evidence)} | ${cell(item.suggestion)} |\n`
  }
  if (report.riskPoints?.length) {
    md += `\n## 风险点\n\n| 级别 | 文件 | 说明 | 建议 |\n|---|---|---|---|\n`
    for (const risk of report.riskPoints) md += `| ${cell(risk.severity)} | ${cell(risk.file)} | ${cell(risk.message)} | ${cell(risk.suggestion)} |\n`
  }
  if (report.fixes?.length) {
    md += `\n## 建议修复\n`
    for (const item of report.fixes) md += `\n### ${cell(item.title)}\n\n- 文件：${cell(item.file)}\n- 级别：${cell(item.severity)}\n- 说明：${cell(item.summary)}\n`
  }
  if (report.fixActions?.length) {
    md += `\n## 已执行修复与重跑\n\n| 诊断 | 分类 | 置信度 | 修改文件 | 重跑结果 |\n|---|---|---|---|---|\n`
    for (const item of report.fixActions) md += `| ${cell(item.diagnosisName)} | ${cell(categoryLabel(item.category))} | ${cell(item.confidence)} | ${cell(item.files.map((file) => file.path).join(', '))} | ${item.rerunResult.passed} 通过 / ${item.rerunResult.failed} 失败 |\n`
  }
  const escalations = latestEscalations(snapshot)
  if (escalations.length) {
    md += `\n## 执行决策审计\n\n| 角色 | 问题 | 状态 | 答复 / 降级方案 |\n|---|---|---|---|\n`
    for (const item of escalations) md += `| ${cell(item.role)} | ${cell(item.question)} | ${item.resolved ? '已答复' : item.degraded ? '已降级' : '未解决'} | ${cell(item.answer ?? item.fallback)} |\n`
  }
  if (report.fitness) {
    md += `\n## 自动修复收敛\n\n- 结果：${report.fitness.converged ? '已收敛' : '未收敛'}\n- 迭代：${report.fitness.iterations}\n- 停止原因：${cell(report.fitness.message)}\n`
  }
  if (report.timeline?.length) {
    md += `\n## 执行时间线\n\n| 阶段 | 状态 | 耗时 | 说明 |\n|---|---|---|---|\n`
    for (const item of report.timeline) md += `| ${cell(item.stage)} | ${cell(item.status)} | ${item.durationMs == null ? '-' : `${Math.round(item.durationMs / 1000)}s`} | ${cell(item.message)} |\n`
  }
  if (report.uiSteps?.length) {
    md += `\n## UI 执行步骤\n\n| 步骤 | 状态 | 耗时 | 错误 | 截图 |\n|---|---|---|---|---|\n`
    for (const item of report.uiSteps) md += `| ${cell(item.name)} | ${cell(item.status)} | ${item.durationMs == null ? '-' : `${Math.round(item.durationMs / 1000)}s`} | ${cell(item.error)} | ${cell(item.screenshot)} |\n`
  }
  if (report.coverageEvidence) {
    md += `\n## 覆盖率证据\n\n- 来源：${report.coverageEvidence.source}\n- 生成时间：${report.coverageEvidence.generatedAt}\n`
    for (const gap of report.coverageEvidence.gaps) md += `- ${cell(gap.file)}：未覆盖行 ${gap.uncoveredLines.join(', ') || '-'}\n`
  }
  if (report.screenshots?.length) md += `\n## 截图\n\n${report.screenshots.map((shot) => `- ${cell(shot)}`).join('\n')}\n`
  if (report.recording?.video || report.recording?.trace) md += `\n## 执行录像 / Trace\n\n- 录像：${report.recording.video ?? '-'}\n- Trace：${report.recording.trace ?? '-'}\n`
  if (report.readOnlyViolation?.changedFiles?.length) md += `\n## ⚠️ read-only 违规\n\n${report.readOnlyViolation.changedFiles.map((file) => `- ${cell(file)}`).join('\n')}\n`
  else if (report.readOnlyViolation?.unavailable) md += `\n## 变更追踪不可用\n\n${cell(report.readOnlyViolation.unavailable)}\n`
  return md
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function screenshotDataUri(projectPath: string | undefined, relPath: string | undefined): string {
  if (!projectPath || !relPath) return ''
  try {
    const projectRoot = realpathSync(resolve(projectPath))
    const requested = resolve(projectRoot, relPath)
    if (!existsSync(requested)) return ''
    const absolute = realpathSync(requested)
    const relation = relative(projectRoot, absolute)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return ''
    if (!/\.(?:png|jpe?g)$/i.test(absolute)) return ''
    if (statSync(absolute).size > 10 * 1024 * 1024) return ''
    const buffer = readFileSync(absolute)
    const mime = /\.jpe?g$/i.test(absolute) ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch { return '' }
}

function table(headers: string[], rows: string[][]): string {
  return `<table border="1" cellspacing="0" cellpadding="6"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

export function reportHtml(snapshot: TaskSnapshot, projectPath?: string): string {
  const report = snapshot.report
  const sections: string[] = []
  if (report?.provenance) sections.push(`<h2>运行溯源</h2>${table(['Git commit', '工作树', '项目类型', '执行环境', '目标 URL', '捕获时间'], [[report.provenance.gitCommitSha ?? '非 Git 项目', report.provenance.gitDirty == null ? '不适用' : report.provenance.gitDirty ? 'dirty' : 'clean', report.provenance.projectType, report.provenance.executionEnvironment, report.provenance.targetUrl ?? '未指定', report.provenance.capturedAt].map(escapeHtml)])}`)
  if (report?.cases?.length) sections.push(`<h2>测试计划</h2>${table(['用例', '层级', '优先级', '场景', '预期', 'API 契约'], report.cases.map((item) => [item.title, item.layer ?? '-', item.priority, item.scenario, item.expected, apiContract(item)].map(escapeHtml)))}`)
  if (report?.caseResults?.length) sections.push(`<h2>逐用例执行证据</h2>${table(['用例 ID', '结果', '执行工具', '证据'], report.caseResults.map((item) => [item.caseId, item.status, item.tool, item.evidence].map(escapeHtml)))}`)
  if (report?.api) sections.push(`<h2>API 测试（${report.api.pass} 通过 / ${report.api.fail} 失败 / ${report.api.skipped} 跳过）</h2>${table(['用例', '请求', '状态', 'HTTP', '耗时', '说明'], report.api.details.map((item) => [item.caseId, `${item.method} ${item.path}`, item.status, item.statusCode ?? '-', item.durationMs == null ? '-' : `${item.durationMs}ms`, item.reason ?? '-'].map(escapeHtml)))}`)
  if (report?.failedCases?.length) sections.push(`<h2>失败诊断</h2>${table(['用例', '层级', '分类', '错误', '证据', '建议'], report.failedCases.map((item) => [item.name, item.layer, categoryLabel(item.category), item.error, item.evidence ?? '-', item.suggestion ?? '-'].map(escapeHtml)))}`)
  if (report?.riskPoints?.length) sections.push(`<h2>风险点</h2>${table(['级别', '文件', '说明', '建议'], report.riskPoints.map((item) => [item.severity, item.file, item.message, item.suggestion ?? '-'].map(escapeHtml)))}`)
  if (report?.fixes?.length) sections.push(`<h2>建议修复</h2>${table(['级别', '文件', '标题', '说明'], report.fixes.map((item) => [item.severity, item.file, item.title, item.summary].map(escapeHtml)))}`)
  if (report?.fixActions?.length) sections.push(`<h2>已执行修复与重跑</h2>${table(['诊断', '分类', '置信度', '修改文件', '重跑结果'], report.fixActions.map((item) => [item.diagnosisName, categoryLabel(item.category), item.confidence, item.files.map((file) => file.path).join(', '), `${item.rerunResult.passed} 通过 / ${item.rerunResult.failed} 失败`].map(escapeHtml)))}`)
  const escalations = latestEscalations(snapshot)
  if (escalations.length) sections.push(`<h2>执行决策审计</h2>${table(['角色', '问题', '状态', '答复 / 降级方案'], escalations.map((item) => [item.role, item.question, item.resolved ? '已答复' : item.degraded ? '已降级' : '未解决', item.answer ?? item.fallback ?? '-'].map(escapeHtml)))}`)
  if (report?.fitness) sections.push(`<h2>自动修复收敛</h2><p><b>${report.fitness.converged ? '已收敛' : '未收敛'}</b> · ${report.fitness.iterations} 次迭代 · ${escapeHtml(report.fitness.message)}</p>`)
  if (report?.timeline?.length) sections.push(`<h2>执行时间线</h2>${table(['阶段', '状态', '耗时', '说明'], report.timeline.map((item) => [item.stage, item.status, item.durationMs == null ? '-' : `${Math.round(item.durationMs / 1000)}s`, item.message ?? '-'].map(escapeHtml)))}`)
  if (report?.uiSteps?.length) sections.push(`<h2>UI 执行步骤</h2>${table(['步骤', '状态', '耗时', '错误', '截图'], report.uiSteps.map((item) => {
    const uri = screenshotDataUri(projectPath, item.screenshot)
    const screenshot = uri ? `<img src="${uri}" style="max-width:220px" alt="${escapeHtml(item.screenshot)}" />` : escapeHtml(item.screenshot)
    return [escapeHtml(item.name), escapeHtml(item.status), escapeHtml(item.durationMs == null ? '-' : `${Math.round(item.durationMs / 1000)}s`), escapeHtml(item.error), screenshot]
  }))}`)
  if (report?.coverageEvidence) sections.push(`<h2>覆盖率证据</h2><p>来源：${escapeHtml(report.coverageEvidence.source)} · 生成时间：${escapeHtml(report.coverageEvidence.generatedAt)}</p>${table(['文件', '未覆盖行'], report.coverageEvidence.gaps.map((gap) => [escapeHtml(gap.file), escapeHtml(gap.uncoveredLines.join(', ') || '-')] ))}`)
  if (report?.screenshots?.length) sections.push(`<h2>截图</h2><div>${report.screenshots.map((shot) => { const uri = screenshotDataUri(projectPath, shot); return uri ? `<figure><img src="${uri}" style="max-width:420px" alt="${escapeHtml(shot)}"/><figcaption>${escapeHtml(shot)}</figcaption></figure>` : `<p>${escapeHtml(shot)}（本机未找到）</p>` }).join('')}</div>`)
  if (report?.recording?.video || report?.recording?.trace) sections.push(`<h2>执行录像 / Trace</h2><ul><li>录像：${escapeHtml(report.recording.video)}</li><li>Trace：${escapeHtml(report.recording.trace)}</li></ul>`)
  if (report?.readOnlyViolation?.changedFiles?.length) sections.push(`<h2>⚠️ read-only 违规</h2><ul>${report.readOnlyViolation.changedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>`)
  else if (report?.readOnlyViolation?.unavailable) sections.push(`<h2>变更追踪不可用</h2><p>${escapeHtml(report.readOnlyViolation.unavailable)}</p>`)
  const gate = report?.gate ? `<p><b>质量门禁：${report.gate.passed ? '通过' : '未通过'}</b> — ${escapeHtml(report.gate.reason)}</p>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Test Agent 测试报告</title><style>body{font-family:system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%;margin-bottom:24px}th{background:#f3f6fb;text-align:left}th,td{vertical-align:top}img{border:1px solid #ccd5e3;border-radius:6px}</style></head><body><h1>Test Agent 测试报告</h1><p>任务 ${escapeHtml(snapshot.taskId)} · 状态 ${escapeHtml(snapshot.status)}</p><p>通过 ${report?.passed ?? '--'} · 失败 ${report?.failed ?? '--'} · 覆盖率 ${report?.coverage == null ? 'N/A' : `${report.coverage}%`}</p>${gate}${report?.summary ? `<p>${escapeHtml(report.summary)}</p>` : ''}${sections.join('')}</body></html>`
}
