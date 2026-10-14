import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, net, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { AiConfig, TaskInput, TestType } from '@cxmt/protocol'
import type { AppMenuCommand, AppNavTarget, DefectCreateInput, DefectCreateResult, EscalationRecord, HistoryRecord, LocalHostStatus, TaskSnapshot } from '../types.js'
import { createStdioHostIO, LocalHostClient, normalizeRunTerminalMessage } from './local-host-client.js'
import { createDefectTracker, getChangedFiles, selectAffectedCases } from '@cxmt/test-agent'
import { reflectMavenCommandSpec, reflectBatchMavenCommandSpec, injectReflectTestRunner, junitBatchMavenCommandSpec } from '@cxmt/test-agent'
import { summarizeMavenFailure } from './maven-result.js'
import { decodeProcessOutput } from './process-output.js'
import { classifyGeneratedTestFiles, removeGeneratedTestFiles } from './generated-test-reset.js'
import {
  reportHtml as buildReportHtml,
  reportMarkdown as buildReportMarkdown,
  reportSummaryText as buildReportSummaryText
} from './report-export.js'
import { suiteCaseId, suiteContainsCase } from './suite-case-match.js'
import { openProfiles, sealProfiles, type EnvironmentProfileData } from './secure-environment-store.js'
import { isAllowedLocalArtifact } from './local-artifact-access.js'
import { classifyNavigation } from './navigation-policy.js'
import { detectRequiredCapabilities, detectTestTypes, inspectProjectSupport } from './project-detection.js'

let mainWindow: BrowserWindow | null = null
const execFileAsync = promisify(execFile)
const serverUrl = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const taskWatchers = new Map<string, NodeJS.Timeout>()
let knowledgeRoots: string[] = []
let localHostClient: LocalHostClient | null = null
const authorizedArtifactRoots = new Set<string>()

function environmentProfilesPath(): string {
  return join(app.getPath('userData'), 'environment-profiles.v1.json')
}

function environmentCodec() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存包含凭据的环境配置')
  return {
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
}

function readEnvironmentProfiles(): EnvironmentProfileData[] {
  const path = environmentProfilesPath()
  if (!existsSync(path)) return []
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { profiles?: Parameters<typeof openProfiles>[0] }
    return openProfiles(stored.profiles ?? [], environmentCodec())
  } catch (reason) {
    throw new Error(`环境配置解密失败：${reason instanceof Error ? reason.message : String(reason)}`)
  }
}

function writeEnvironmentProfiles(profiles: EnvironmentProfileData[]): void {
  const path = environmentProfilesPath()
  mkdirSync(dirname(path), { recursive: true })
  const payload = { version: 1, profiles: sealProfiles(profiles, environmentCodec()) }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
}

function normalizedProjectPath(value: string): string {
  return resolve(value).replace(/\\/g, '/').toLowerCase()
}

// ---------------------------------------------------------------------------
// 用例库文件操作（与 test-agent core/cases.ts 同格式，GUI 自含实现避免跨包依赖）
// ---------------------------------------------------------------------------

function computeProjectHash(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/\\/g, '/').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function computeCaseId(projectHash: string, title: string): string {
  return createHash('sha256').update(`${projectHash}:${title}`).digest('hex').slice(0, 16)
}

function casesDirFor(projectPath: string): string {
  const projectHash = computeProjectHash(projectPath)
  return join(projectPath, '.test-agent', 'cases', projectHash, 'cases')
}

/** 反射场景持久化目录（R1 落定路径：.test-agent/scenarios/<caseId>.json）。与 cases 分库，无 projectHash 分层。 */
function scenariosDirFor(projectPath: string): string {
  return join(projectPath, '.test-agent', 'scenarios')
}

/** P6: 读项目级配置（.test-agent/config.json），多主类项目指定 springMainClass 避免 scan 选错。无配置文件 → 空对象（向后兼容）。 */
function readProjectConfig(projectPath: string): { springMainClass?: string } {
  const configPath = join(projectPath, '.test-agent', 'config.json')
  if (!existsSync(configPath)) return {}
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { springMainClass?: string }
    return cfg && typeof cfg.springMainClass === 'string' ? { springMainClass: cfg.springMainClass } : {}
  } catch { return {} }
}

/** 刷新用例库索引（caseCount + lastUpdatedAt），对齐 core/cases.ts refreshIndex 逻辑（review P2-6）。 */
function refreshCasesIndex(projectPath: string): void {
  const projectHash = computeProjectHash(projectPath)
  const indexDir = join(projectPath, '.test-agent', 'cases', projectHash)
  const indexPath = join(indexDir, 'index.json')
  const dir = casesDirFor(projectPath)

  let caseCount = 0
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const stored = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { deleted?: boolean }
        if (stored && !stored.deleted) caseCount++
      } catch { /* 忽略损坏文件 */ }
    }
  }

  const now = new Date().toISOString()
  let index: { projectHash: string; codeHash: string; fileHashes: Record<string, string>; lastUpdatedAt: string; caseCount: number }
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'))
    } catch {
      index = { projectHash, codeHash: '', fileHashes: {}, lastUpdatedAt: now, caseCount }
    }
  } else {
    index = { projectHash, codeHash: '', fileHashes: {}, lastUpdatedAt: now, caseCount }
  }
  index.caseCount = caseCount
  index.lastUpdatedAt = now
  mkdirSync(indexDir, { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
}

function loadCasesFromLibrary(projectPath: string): unknown[] {
  const dir = casesDirFor(projectPath)
  if (!existsSync(dir)) return []
  const cases: unknown[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const stored = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { deleted?: boolean; case?: unknown }
      if (stored && !stored.deleted && stored.case) cases.push(stored.case)
    } catch { /* 忽略损坏文件 */ }
  }
  return cases
}

function loadAllStoredCaseIds(projectPath: string): string[] {
  const dir = casesDirFor(projectPath)
  if (!existsSync(dir)) return []
  const ids: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const stored = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { caseId?: string; case?: { id?: string } }
      const id = stored.caseId ?? stored.case?.id
      if (id) ids.push(id)
    } catch { /* ignore damaged records */ }
  }
  return ids
}

function saveCaseToLibrary(projectPath: string, testCase: Record<string, unknown>): boolean {
  const dir = casesDirFor(projectPath)
  mkdirSync(dir, { recursive: true })
  const projectHash = computeProjectHash(projectPath)
  const caseId = computeCaseId(projectHash, String(testCase.title ?? ''))
  const filePath = join(dir, `${caseId}.json`)

  let existing: { version?: number; createdAt?: string; history?: unknown[]; case?: unknown } | null = null
  if (existsSync(filePath)) {
    try { existing = JSON.parse(readFileSync(filePath, 'utf8')) } catch { /* 忽略 */ }
  }

  const now = new Date().toISOString()
  const version = existing?.version ? existing.version + 1 : 1
  const historyEntry = { version, case: { ...testCase, id: caseId }, createdAt: now, reason: existing ? 'save' : 'initial' }
  const stored = {
    caseId,
    projectHash,
    case: { ...testCase, id: caseId },
    version,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deleted: false,
    history: existing?.history ? [...existing.history, historyEntry] : [historyEntry],
  }
  writeFileSync(filePath, JSON.stringify(stored, null, 2), 'utf8')
  refreshCasesIndex(projectPath)
  return true
}

function deleteCaseFromLibrary(projectPath: string, title: string): boolean {
  const projectHash = computeProjectHash(projectPath)
  const caseId = computeCaseId(projectHash, title)
  const dir = casesDirFor(projectPath)
  const filePath = join(dir, `${caseId}.json`)
  if (!existsSync(filePath)) return false
  try {
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: number; history?: unknown[]; case?: unknown; deleted?: boolean }
    if (stored.deleted) return false
    const now = new Date().toISOString()
    const version = (stored.version ?? 0) + 1
    const updated = {
      ...stored,
      version,
      updatedAt: now,
      deleted: true,
      history: [...(stored.history ?? []), { version, case: stored.case, createdAt: now, reason: 'delete' }],
    }
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8')
    refreshCasesIndex(projectPath)
    return true
  } catch { return false }
}

function historyFilePath(): string {
  return join(app.getPath('userData'), 'test-agent-history.json')
}

// ---------------------------------------------------------------------------
// 质量看板文件操作（与 test-agent core/metrics.ts 同格式，GUI 自含实现避免跨包依赖）
// ---------------------------------------------------------------------------

interface WeeklyPoint {
  weekStart: string
  taskCount: number
  dimensions: {
    passRate: number
    failCategoryRatio: { 'real-bug': number; 'test-defect': number; environment: number; flaky: number }
    flakyRate: number
    avgDurationMs: number | null
    tokenCost: number | null
  }
}

function loadWeeklyMetrics(metricsBaseDir: string, projectHash: string, range?: { start: string; end: string }): WeeklyPoint[] {
  const filePath = join(metricsBaseDir, projectHash, 'weekly.jsonl')
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const points: WeeklyPoint[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as WeeklyPoint
        if (parsed.weekStart && parsed.dimensions) points.push(parsed)
      } catch { /* 跳过损坏行 */ }
    }
    points.sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    if (!range) return points
    return points.filter((p) => p.weekStart >= range.start && p.weekStart <= range.end)
  } catch { return [] }
}

/**
 * ai-config.json 路径 — 固定 home 路径，对齐 pi 的 ~/.pi/agent/models.json 约定。
 *
 * 不用 app.getPath('userData')：userData 路径随 productName 漂移，应用改名
 * 会产生多份历史配置（曾出现 Test Agent/ 与 cimdev-test-agent/ 两份不一致）。
 * runner.ts 的 defaultConfigPath() fallback 也是 ~/.test-agent/ai-config.json，
 * 统一这里即应用层与库层天然对齐，不依赖 env 注入也能找到配置。
 */
function aiConfigFilePath(): string {
  return join(os.homedir(), '.test-agent', 'ai-config.json')
}

function readAiConfig(): AiConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(aiConfigFilePath(), 'utf8')) as AiConfig
    if (!parsed.providers || typeof parsed.providers !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeAiConfig(config: AiConfig): void {
  mkdirSync(dirname(aiConfigFilePath()), { recursive: true })
  writeFileSync(aiConfigFilePath(), JSON.stringify(config, null, 2), 'utf8')
}

function readHistory(): HistoryRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(historyFilePath(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as HistoryRecord[]) : []
  } catch {
    return []
  }
}

function writeHistory(records: HistoryRecord[]): void {
  mkdirSync(dirname(historyFilePath()), { recursive: true })
  writeFileSync(historyFilePath(), JSON.stringify(records, null, 2), 'utf8')
}

interface ServerTask {
  id: string
  input: TaskInput
  status: string
  logs: Array<{ id: number; level: 'info' | 'success' | 'warning' | 'error'; message: string; createdAt: string }>
  report: TaskSnapshot['report'] | null
  artifacts: string[] | null
  errorMessage: string | null
}

async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.TEST_AGENT_API_TOKEN
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error(`Java服务请求失败：${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined as T : await response.json() as T
}

function taskSnapshot(task: ServerTask): TaskSnapshot {
  const statusMap: Record<string, TaskSnapshot['status']> = { QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', NEEDS_REVIEW: 'needsReview' }
  const status = statusMap[task.status] ?? 'planning'
  const laneStatus = status === 'completed' ? (task.report?.failed === 0 ? 'passed' : 'failed') : status === 'failed' || status === 'cancelled' || status === 'needsReview' ? 'failed' : status === 'running' ? 'running' : 'pending'
  return {
    taskId: task.id,
    status,
    logs: task.logs.map((log) => ({ id: String(log.id), time: new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false }), level: log.level, message: log.message })),
    lanes: task.input.testTypes.map((type: TestType) => ({ type, status: laneStatus, summary: task.errorMessage ?? (status === 'completed' ? '真实测试执行完成' : status === 'running' ? 'Worker执行中' : '等待Worker') })),
    artifacts: task.artifacts ?? [],
    report: task.report ?? undefined
  }
}

function watchTask(taskId: string): void {
  if (taskWatchers.has(taskId)) return
  const poll = async (): Promise<void> => {
    try {
      const task = await serverRequest<ServerTask>(`/api/tasks/${taskId}`)
      mainWindow?.webContents.send('task:snapshot', taskSnapshot(task))
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
        const timer = taskWatchers.get(taskId)
        if (timer) clearInterval(timer)
        taskWatchers.delete(taskId)
      }
    } catch (error) {
      console.error('Task polling failed', error)
    }
  }
  void poll()
  taskWatchers.set(taskId, setInterval(() => { void poll() }, 1000))
}

function ensureLocalHostClient(): LocalHostClient {
  if (localHostClient) return localHostClient
  const hostCliPath = process.env.TEST_AGENT_HOST_CLI_PATH ?? join(app.getAppPath(), 'out', 'main', 'host-cli.js')
  const aiConfigPath = aiConfigFilePath()
  let executionEngine: string | undefined
  try {
    const raw = readFileSync(aiConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as AiConfig
    if (parsed.executionEngine === 'ai-native' && parsed.providers && Object.keys(parsed.providers).length > 0) {
      executionEngine = 'ai-native'
    }
  } catch { /* ai-config.json 不存在或解析失败，用默认 cimicode */ }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TEST_AGENT_AI_MODE: process.env.TEST_AGENT_AI_MODE ?? 'true',
    TEST_AGENT_ALLOWED_PROJECT_ROOTS: process.env.TEST_AGENT_ALLOWED_PROJECT_ROOTS ?? parse(app.getAppPath()).root,
    ...(executionEngine === 'ai-native' ? {
      TEST_AGENT_PROVIDER: 'ai-native',
      TEST_AGENT_AI_CONFIG: aiConfigPath
    } : {})
  }
  const io = createStdioHostIO(process.execPath, [hostCliPath], { cwd: process.cwd(), env })
  const client = new LocalHostClient(io)
  client.onMessage((message) => mainWindow?.webContents.send('host:message', message))
  localHostClient = client
  return client
}

async function detectVersion(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      windowsHide: true,
      timeout: 3000
    })
    return stdout.trim() || '未识别'
  } catch {
    return '未识别'
  }
}

/** 失败诊断分类 → 中文标签（PRD 第4节）。 */
function categoryLabel(category: string): string {
  switch (category) {
    case 'real-bug': return '真 bug'
    case 'test-defect': return '测试缺陷'
    case 'environment': return '环境问题'
    case 'flaky': return 'flaky'
    default: return category
  }
}

function reportSummaryText(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  const lines = [
    'Test Agent 测试报告',
    `任务：${snapshot.taskId}`,
    `状态：${snapshot.status}`,
    `通过：${report?.passed ?? '--'}`,
    `失败：${report?.failed ?? '--'}`,
    `覆盖率：${report?.coverage === null || report?.coverage === undefined ? 'N/A' : `${report.coverage}%`}`,
    report?.gate ? `质量门禁：${report.gate.passed ? '通过' : '未通过'}` : '质量门禁：--'
  ]
  if (report?.summary) lines.push(`结论：${report.summary}`)
  if (report?.failedCases?.length) {
    lines.push('失败诊断：')
    for (const item of report.failedCases) {
      const tag = categoryLabel(item.category)
      lines.push(`- ${item.name} [${tag}] ${item.error}${item.suggestion ? `；建议：${item.suggestion}` : ''}`)
    }
  }
  if (report?.readOnlyViolation?.changedFiles?.length) {
    lines.push(`⚠️ read-only 违规：诊断修改了 ${report.readOnlyViolation.changedFiles.length} 个文件`)
  }
  return lines.join('\n')
}

function reportMarkdown(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  let md = `# Test Agent 测试报告\n\n- 任务：\`${snapshot.taskId}\`\n- 状态：${snapshot.status}\n`
  if (report) {
    md += `- 通过：${report.passed}\n- 失败：${report.failed}\n- 覆盖率：${report.coverage === null ? 'N/A' : `${report.coverage}%`}\n`
    if (report.gate) md += `- 质量门禁：${report.gate.passed ? '通过' : '未通过'}\n`
    if (report.durationMs !== undefined) md += `- 耗时：${Math.round(report.durationMs / 1000)}s\n`
    if (report.summary) md += `\n## 结论\n\n${report.summary}\n`
    if (report.cases?.length) {
      md += `\n## 测试计划（${report.cases.length} 条）\n\n| 用例 | 层级 | 优先级 | 场景 | 预期 |\n|---|---|---|---|---|\n`
      for (const item of report.cases) md += `| ${item.title} | ${item.layer ?? '-'} | ${item.priority} | ${item.scenario} | ${item.expected} |\n`
    }
    if (report.failedCases?.length) {
      md += `\n## 失败诊断\n\n| 用例 | 层级 | 分类 | 错误 | 证据 | 建议 |\n|---|---|---|---|---|---|\n`
      for (const item of report.failedCases) md += `| ${item.name} | ${item.layer} | ${categoryLabel(item.category)} | ${item.error} | ${item.evidence ?? '-'} | ${item.suggestion ?? '-'} |\n`
    }
    if (report.riskPoints?.length) {
      md += `\n## 风险点\n\n| 级别 | 文件 | 说明 | 建议 |\n|---|---|---|---|\n`
      for (const risk of report.riskPoints) md += `| ${risk.severity} | ${risk.file} | ${risk.message} | ${risk.suggestion ?? '-'} |\n`
    }
    if (report.fixes?.length) {
      md += `\n## 建议修复\n\n`
      for (const item of report.fixes) {
        md += `### ${item.title}\n\n- 文件：${item.file}\n- 级别：${item.severity}\n- 说明：${item.summary}\n\n**修复前**\n\n\`\`\`\n${item.beforeCode ?? '-'}\n\`\`\`\n\n**修复后**\n\n\`\`\`\n${item.afterCode ?? '-'}\n\`\`\`\n\n`
      }
    }
    if (report.readOnlyViolation?.changedFiles?.length) {
      md += `\n## ⚠️ read-only 违规\n\n诊断 Agent 修改了以下文件（违反 read-only 约束）：\n\n`
      for (const file of report.readOnlyViolation.changedFiles) md += `- ${file}\n`
    } else if (report.readOnlyViolation?.unavailable) {
      md += `\n## 变更追踪\n\n诊断变更追踪不可用：${report.readOnlyViolation.unavailable}\n`
    }
    if (report.timeline?.length) {
      md += `\n## 执行时间线\n\n| 阶段 | 状态 | 耗时 | 说明 |\n|---|---|---|---|\n`
      for (const item of report.timeline) md += `| ${item.stage} | ${item.status} | ${item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : '-'} | ${item.message ?? '-'} |\n`
    }
    if (report.uiSteps?.length) {
      md += `\n## UI 执行步骤\n\n| 步骤 | 状态 | 耗时 | 错误 |\n|---|---|---|---|\n`
      for (const item of report.uiSteps) md += `| ${item.name} | ${item.status} | ${item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : '-'} | ${item.error ?? '-'} |\n`
    }
    if (report.screenshots?.length) {
      md += `\n## 截图\n\n导出的 HTML/PDF 报告内嵌了 ${report.screenshots.length} 张截图，以下是文件清单（Markdown 格式不内嵌图片）：\n\n`
      for (const shot of report.screenshots) md += `- ${shot}\n`
    }
    if (report.recording?.video || report.recording?.trace) {
      md += `\n## 执行录像 / Trace\n\n- 录像：${report.recording.video ?? '-'}\n- Trace：${report.recording.trace ?? '-'}\n`
    }
  }
  return md
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

/** 读取项目内截图文件转为 base64 data URI，用于导出报告内嵌图片。文件不存在或不可读时返回空字符串。 */
function screenshotDataUri(projectPath: string | undefined, relPath: string | undefined): string {
  if (!projectPath || !relPath) return ''
  const absolute = join(projectPath, relPath)
  try {
    if (!existsSync(absolute)) return ''
    const buffer = readFileSync(absolute)
    const ext = absolute.toLowerCase().endsWith('.jpg') || absolute.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    return `data:${ext};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  }
}

function reportHtml(snapshot: TaskSnapshot, projectPath?: string): string {
  const report = snapshot.report
  const coverageText = report?.coverage === null || report?.coverage === undefined ? 'N/A' : `${report.coverage}%`
  const caseRows = (report?.cases ?? []).map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.layer ?? '-')}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.expected)}</td></tr>`).join('')
  const failedRows = (report?.failedCases ?? []).map((item) => {
    const dataUri = screenshotDataUri(projectPath, item.screenshot)
    const shotCell = dataUri ? `<img src="${dataUri}" style="max-width:240px;border:1px solid #ccc;border-radius:4px" alt="${escapeHtml(item.screenshot ?? '')}" />` : (item.screenshot ? `<span style="color:#888">${escapeHtml(item.screenshot)}</span>` : '-')
    return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.layer)}</td><td>${escapeHtml(item.error)}</td><td>${escapeHtml(item.suggestion ?? '-')}</td><td>${shotCell}</td></tr>`
  }).join('')
  const timelineRows = (report?.timeline ?? []).map((item) => `<tr><td>${escapeHtml(item.stage)}</td><td>${escapeHtml(item.status)}</td><td>${item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : '-'}</td><td>${escapeHtml(item.message ?? '-')}</td></tr>`).join('')
  const uiStepRows = (report?.uiSteps ?? []).map((item) => {
    const dataUri = screenshotDataUri(projectPath, item.screenshot)
    const shotCell = dataUri ? `<img src="${dataUri}" style="max-width:180px;border:1px solid #ccc;border-radius:4px" alt="${escapeHtml(item.screenshot ?? '')}" />` : (item.screenshot ? `<span style="color:#888">${escapeHtml(item.screenshot)}</span>` : '-')
    return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.status)}</td><td>${item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : '-'}</td><td>${escapeHtml(item.error ?? '-')}</td><td>${shotCell}</td></tr>`
  }).join('')
  const recordingHtml = report?.recording?.video || report?.recording?.trace
    ? `<h2>执行录像 / Trace</h2><ul><li>录像：${escapeHtml(report.recording.video ?? '-')}</li><li>Trace：${escapeHtml(report.recording.trace ?? '-')}</li></ul>`
    : ''
  const fixCards = (report?.fixes ?? []).map((item) => `<div style="margin:8px 0;padding:10px;border:1px solid #ddd;border-radius:8px"><b>${escapeHtml(item.title)}</b><div>${escapeHtml(item.file)} · ${escapeHtml(item.severity)}</div><p>${escapeHtml(item.summary)}</p><div>修复前<pre>${escapeHtml(item.beforeCode ?? '-')}</pre></div><div>修复后<pre>${escapeHtml(item.afterCode ?? '-')}</pre></div></div>`).join('')
  const screenshotGallery = (report?.screenshots ?? []).length > 0
    ? `<h2>截图</h2><div style="display:flex;flex-wrap:wrap;gap:8px">${(report?.screenshots ?? []).map((shot) => {
        const dataUri = screenshotDataUri(projectPath, shot)
        return dataUri ? `<figure style="margin:0"><img src="${dataUri}" style="max-width:320px;border:1px solid #ccc;border-radius:4px" alt="${escapeHtml(shot)}" /><figcaption style="font-size:12px;color:#666">${escapeHtml(shot)}</figcaption></figure>` : `<figure style="margin:0"><div style="width:320px;height:200px;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;color:#888;font-size:12px">${escapeHtml(shot)}<br/>（本机未找到）</div></figure>`
      }).join('')}</div>`
    : ''
  const hasFailedShotCol = (report?.failedCases ?? []).some((item) => Boolean(item.screenshot))
  const hasUiShotCol = (report?.uiSteps ?? []).some((item) => Boolean(item.screenshot))
  return `<!doctype html><meta charset="utf-8"><title>Test Agent 测试报告</title><body style="font-family:system-ui"><h1>Test Agent 测试报告</h1><p>通过 ${report?.passed ?? '--'} · 失败 ${report?.failed ?? '--'} · 覆盖率 ${coverageText}</p>${report?.summary ? `<p>${escapeHtml(report.summary)}</p>` : ''}<h2>测试计划</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>用例</th><th>层级</th><th>优先级</th><th>场景</th><th>预期</th></tr>${caseRows}</table>${(report?.failedCases?.length ?? 0) > 0 ? `<h2>失败用例</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>用例</th><th>层级</th><th>错误</th><th>建议</th>${hasFailedShotCol ? '<th>截图</th>' : ''}</tr>${failedRows}</table>` : ''}${report?.timeline?.length ? `<h2>执行时间线</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>阶段</th><th>状态</th><th>耗时</th><th>说明</th></tr>${timelineRows}</table>` : ''}${report?.uiSteps?.length ? `<h2>UI 执行步骤</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>步骤</th><th>状态</th><th>耗时</th><th>错误</th>${hasUiShotCol ? '<th>截图</th>' : ''}</tr>${uiStepRows}</table>` : ''}${screenshotGallery}${recordingHtml}${report?.fixes?.length ? `<h2>建议修复</h2>${fixCards}` : ''}</body>`
}

function printReportPdf(html: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const timer = setTimeout(() => {
      printWindow.destroy()
      reject(new Error('PDF render timed out'))
    }, 30_000)
    printWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      void printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
        .then((pdf) => {
          printWindow.destroy()
          resolve(pdf)
        })
        .catch((error) => {
          printWindow.destroy()
          reject(error)
        })
    })
    printWindow.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer)
      printWindow.destroy()
      reject(new Error(`PDF render failed (${code}): ${description}`))
    })
    void printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

function createWindow(): void {
  const rendererEntry = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f6fa',
    title: 'Test Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigation(url, rendererEntry)
    if (decision === 'artifact') {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } }
    }
    if (decision === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (classifyNavigation(url, rendererEntry) !== 'internal') event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  void mainWindow.loadURL(rendererEntry)
}

function sendMenuNavigation(target: AppNavTarget): void {
  mainWindow?.webContents.send('menu:navigate', target)
}

function sendMenuCommand(command: AppMenuCommand): void {
  mainWindow?.webContents.send('menu:command', command)
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '任务',
      submenu: [
        { label: '发起真实测试', accelerator: 'CmdOrCtrl+Enter', click: () => sendMenuCommand('start') },
        { label: '取消任务', click: () => sendMenuCommand('cancel') }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '导出 Markdown', click: () => sendMenuCommand('exportMarkdown') },
        { label: '导出 HTML', click: () => sendMenuCommand('exportHtml') },
        { label: '复制摘要', click: () => sendMenuCommand('copySummary') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '工作台', accelerator: 'CmdOrCtrl+1', click: () => sendMenuNavigation('home') },
        { label: '历史任务', accelerator: 'CmdOrCtrl+2', click: () => sendMenuNavigation('history') },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => sendMenuNavigation('settings') },
        { label: 'AI 模型配置', click: () => sendMenuCommand('settingsAi') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { role: 'about', label: '关于 Test Agent' }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  // 注册 local-file:// protocol：让渲染进程能读本地截图/录像文件（file:// 被 Electron 安全策略禁用）
  // URL 格式：local-file:///Q:/sding/projects/xxx/.test-agent/screenshots/01-home.png
  protocol.handle('local-file', (request) => {
    const url = new URL(request.url)
    // URL pathname 以 / 开头，Windows 路径如 /Q:/sding/... 去掉前导 /
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && filePath.startsWith('/')) filePath = filePath.slice(1)
    try {
      if (!existsSync(filePath)) return new Response('Not found', { status: 404 })
      if (!isAllowedLocalArtifact([...authorizedArtifactRoots], filePath, realpathSync)) return new Response('Forbidden', { status: 403 })
      // 透传 request headers（含 Range）——video 元素需要 Range 请求才能 seek，
      // 不透传则 net.fetch(file://) 返回全文件无 Accept-Ranges，video 显示 0:00
      return net.fetch(`file:///${filePath.replace(/\\/g, '/')}`, { headers: request.headers })
    } catch (error) {
      return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  })
  buildMenu()
  ipcMain.handle('config:getKnowledgeRoots', () => knowledgeRoots)
  ipcMain.handle('config:authorizeProjectArtifacts', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return false
    try {
      authorizedArtifactRoots.add(realpathSync(projectPath))
      return true
    } catch { return false }
  })
  ipcMain.handle('config:selectKnowledgeRoots', async () => {
    if (!mainWindow) return knowledgeRoots
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select knowledge base directories'
    })
    if (result.canceled) return knowledgeRoots
    knowledgeRoots = result.filePaths
    mainWindow.webContents.send('config:changed', knowledgeRoots)
    return knowledgeRoots
  })
  ipcMain.handle('config:getAiConfig', () => readAiConfig())
  ipcMain.handle('config:saveAiConfig', (_event, config: AiConfig) => {
    writeAiConfig(config)
    // 执行引擎可能已变更，关闭旧 host client 以便下次任务用新 env 重启
    localHostClient?.close()
    localHostClient = null
    return
  })
  ipcMain.handle('config:loadEnvironmentProfiles', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return []
    const key = normalizedProjectPath(projectPath)
    return readEnvironmentProfiles().filter(profile => normalizedProjectPath(profile.projectPath) === key)
  })
  ipcMain.handle('config:saveEnvironmentProfiles', (_event, projectPath: string, profiles: EnvironmentProfileData[]) => {
    if (!projectPath || !existsSync(projectPath) || !Array.isArray(profiles)) throw new Error('项目目录或环境配置无效')
    const key = normalizedProjectPath(projectPath)
    const sanitized = profiles.map(profile => {
      if (normalizedProjectPath(profile.projectPath) !== key) throw new Error('拒绝保存属于其他项目的环境配置')
      return {
        ...profile,
        projectPath,
        coverageTarget: Number.isFinite(profile.coverageTarget) ? Math.max(0, Math.min(100, profile.coverageTarget)) : 80,
        apiHeaders: profile.apiHeaders.filter(entry => entry.key.trim()).map(entry => ({ key: entry.key.trim(), value: entry.value })),
        env: profile.env.filter(entry => entry.key.trim()).map(entry => ({ key: entry.key.trim(), value: entry.value }))
      }
    })
    const others = readEnvironmentProfiles().filter(profile => normalizedProjectPath(profile.projectPath) !== key)
    writeEnvironmentProfiles([...others, ...sanitized])
  })
  ipcMain.handle('history:get', () => readHistory())
  ipcMain.handle('history:save', (_event, record: HistoryRecord) => {
    const records = readHistory().filter((item) => item.id !== record.id)
    records.unshift(record)
    writeHistory(records.slice(0, 100))
  })
  ipcMain.handle('history:clear', () => {
    writeHistory([])
  })
  // 诊断先行架构：回滚修复动作（git apply -R 逆向应用 pre-fix patch）
  ipcMain.handle('task:rollback', async (_event, projectPath: string, patch: string) => {
    if (!patch) return false
    return await new Promise<boolean>((resolve) => {
      const child = spawn('git', ['apply', '-R', '-'], { cwd: projectPath, windowsHide: true })
      let settled = false
      const finish = (ok: boolean, reason?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok) console.error('rollbackFix failed:', reason)
        resolve(ok)
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } finish(false, 'timeout') }, 15000)
      child.on('error', (err) => finish(false, err))
      child.on('exit', (code) => finish(code === 0, code !== 0 ? `exit ${code}` : undefined))
      child.stdin?.on('error', () => finish(false, 'stdin error'))
      child.stdin?.end(patch)
    })
  })
  ipcMain.handle('project:select', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled) return null
    const path = result.filePaths[0]
    const detectedTestTypes = detectTestTypes(path)
    const support = inspectProjectSupport(path)
    return JSON.parse(JSON.stringify({
      path,
      detectedSystem: basename(path),
      detectedVersion: await detectVersion(path),
      detectedTestTypes,
      requiredCapabilities: detectRequiredCapabilities(path, detectedTestTypes),
      projectKind: support.kind,
      supported: support.supported,
      unsupportedReason: support.reason
    }))
  })

  ipcMain.handle('project:detect', async (_event, path: string) => {
    if (!path || !existsSync(path)) return null
    const detectedTestTypes = detectTestTypes(path)
    const support = inspectProjectSupport(path)
    return JSON.parse(JSON.stringify({
      path,
      detectedSystem: basename(path),
      detectedVersion: await detectVersion(path),
      detectedTestTypes,
      requiredCapabilities: detectRequiredCapabilities(path, detectedTestTypes),
      projectKind: support.kind,
      supported: support.supported,
      unsupportedReason: support.reason
    }))
  })

  ipcMain.handle('report:export', async (_event, format: 'markdown' | 'html' | 'json' | 'pdf', snapshot: TaskSnapshot, projectPath?: string) => {
    if (!mainWindow) return { saved: false, error: 'window unavailable' }
    const extension = format === 'json' ? 'json' : format === 'html' ? 'html' : format === 'pdf' ? 'pdf' : 'md'
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出测试报告',
      defaultPath: `test-report.${extension}`,
      filters: [{ name: format, extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      if (format === 'pdf') {
        const pdf = await printReportPdf(buildReportHtml(snapshot, projectPath))
        writeFileSync(result.filePath, pdf)
      } else {
        const content = format === 'json' ? JSON.stringify(snapshot, null, 2) : format === 'html' ? buildReportHtml(snapshot, projectPath) : buildReportMarkdown(snapshot)
        writeFileSync(result.filePath, content, 'utf8')
      }
      return { saved: true, path: result.filePath }
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('report:copy', async (_event, snapshot: TaskSnapshot) => {
    clipboard.writeText(buildReportSummaryText(snapshot))
    return { copied: true }
  })

  ipcMain.handle('clipboard:write', async (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return { copied: true }
  })

  ipcMain.handle('runtime:status', async () => {
    try {
      await serverRequest('/actuator/health')
      const runtime = await serverRequest<{ workers?: Array<{ status?: string; capabilities?: string[] }> }>('/api/runtime')
      const onlineWorkers = (runtime.workers ?? []).filter((worker) => worker.status === 'ONLINE')
      const providers = [...new Set(onlineWorkers.flatMap((worker) => worker.capabilities ?? []).filter((capability) => capability.endsWith('-cli') || capability === 'cimicode'))]
      return {
        mode: onlineWorkers.length > 0 ? 'real' : 'unavailable',
        provider: providers.join(', ') || null,
        message: onlineWorkers.length > 0
          ? `Java控制服务已连接，在线Worker ${onlineWorkers.length}个`
          : 'Java控制服务已连接，当前没有在线Worker'
      }
    } catch {
      return { mode: 'unavailable', provider: null, message: `Java控制服务不可用：${serverUrl}` }
    }
  })

  ipcMain.handle('task:start', async (_event, input: TaskInput) => {
    const mergedInput = knowledgeRoots.length > 0 ? { ...input, knowledgeRoots } : input
    const task = await serverRequest<ServerTask>('/api/tasks', { method: 'POST', body: JSON.stringify({ input: mergedInput, triggerType: 'desktop' }) })
    watchTask(task.id)
    return { taskId: task.id }
  })
  ipcMain.handle('task:get', async (_event, taskId: string) => taskSnapshot(await serverRequest<ServerTask>(`/api/tasks/${taskId}`)))
  ipcMain.handle('task:cancel', async (_event, taskId: string) => taskSnapshot(await serverRequest<ServerTask>(`/api/tasks/${taskId}/cancel`, { method: 'POST' })))
  ipcMain.handle('task:retry', async (_event, taskId: string) => {
    const task = await serverRequest<ServerTask>(`/api/tasks/${taskId}/retry`, { method: 'POST' })
    watchTask(task.id)
    return { taskId: task.id }
  })
  ipcMain.handle('host:status', async (): Promise<LocalHostStatus> => {
    try {
      const client = ensureLocalHostClient()
      const handshake = await client.handshake()
      if (handshake.kind !== 'handshake') return { running: false, error: 'handshake failed' }
      if (!handshake.ok) return { running: false, error: handshake.error ?? 'handshake rejected' }
      const health = await client.health()
      return {
        running: true,
        protocolVersion: handshake.protocolVersion,
        hostVersion: handshake.hostVersion,
        capabilities: handshake.capabilities,
        activeRuns: health.kind === 'health' ? health.activeRuns : undefined
      }
    } catch (error) {
      return { running: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('host:start', async (_event, input: TaskInput, executionId?: string) => {
    const client = ensureLocalHostClient()
    const id = executionId && executionId.trim() !== '' ? executionId : randomUUID()
    void client.run(input, id).then((message) => {
      if (message.kind === 'error') mainWindow?.webContents.send('host:message', normalizeRunTerminalMessage(message, id))
    }).catch((error) => {
      mainWindow?.webContents.send('host:message', { id: '', kind: 'run-error', executionId: id, error: error instanceof Error ? error.message : String(error), cancelled: false })
    })
    return { taskId: id }
  })
  ipcMain.handle('host:cancel', async (_event, executionId: string) => {
    const client = ensureLocalHostClient()
    const response = await client.cancel(executionId)
    return { cancelled: response.kind === 'cancelled' }
  })

  // ===== 用例库 IPC（GUI 编辑用例时读写 Worker 本地库） =====
  ipcMain.handle('plan:previewImpact', (_event, projectPath: string, cases: Parameters<typeof selectAffectedCases>[0]) => {
    if (!projectPath || !existsSync(projectPath) || !Array.isArray(cases)) throw new Error('无法预估执行范围：项目或计划用例不可用')
    const changedFiles = getChangedFiles(projectPath)
    const selection = selectAffectedCases(cases, changedFiles)
    return { total: cases.length, selected: selection.affected.length, skipped: selection.skipped.length, changedFilesCount: changedFiles.length, fallbackReason: selection.fallbackReason ?? null }
  })
  ipcMain.handle('cases:load', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return []
    return loadCasesFromLibrary(projectPath)
  })
  ipcMain.handle('cases:save', (_event, projectPath: string, testCase: Record<string, unknown>) => {
    if (!projectPath || !existsSync(projectPath)) return false
    return saveCaseToLibrary(projectPath, testCase)
  })
  ipcMain.handle('cases:delete', (_event, projectPath: string, title: string) => {
    if (!projectPath || !existsSync(projectPath)) return false
    return deleteCaseFromLibrary(projectPath, title)
  })
  ipcMain.handle('cases:resetGeneratedPreview', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return { removableFiles: [], protectedFiles: [] }
    return classifyGeneratedTestFiles(projectPath, loadAllStoredCaseIds(projectPath))
  })
  ipcMain.handle('cases:resetGenerated', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return { removedFiles: [], failedFiles: [], protectedFiles: [] }
    const preview = classifyGeneratedTestFiles(projectPath, loadAllStoredCaseIds(projectPath))
    return removeGeneratedTestFiles(projectPath, preview)
  })

  // ===== 反射场景 IPC（P0 项1+2：读/写/列 .test-agent/scenarios/<caseId>.json，控制面零改动，照抄 cases:* 模式） =====
  ipcMain.handle('scenarios:read', (_event, projectPath: string, caseId: string) => {
    if (!projectPath || !caseId || !existsSync(projectPath)) return null
    const file = join(scenariosDirFor(projectPath), `${caseId}.json`)
    if (!existsSync(file)) return null
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  })
  ipcMain.handle('scenarios:save', (_event, projectPath: string, caseId: string, scenario: unknown) => {
    if (!projectPath || !caseId || !existsSync(projectPath)) return false
    const dir = scenariosDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    try { writeFileSync(join(dir, `${caseId}.json`), JSON.stringify(scenario, null, 2), 'utf8'); return true } catch { return false }
  })
  ipcMain.handle('scenarios:list', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return []
    const dir = scenariosDirFor(projectPath)
    if (!existsSync(dir)) return []
    const list: Array<{ caseId: string; title?: string }> = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const s = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { id?: string; title?: string }
        list.push({ caseId: s.id ?? file.replace(/\.json$/, ''), title: s.title })
      } catch { /* 忽略损坏文件 */ }
    }
    return list
  })

  // ===== P3-2 场景文件管理 IPC（删除/导入/导出 .test-agent/scenarios/<caseId>.json，控制面零改动） =====
  ipcMain.handle('scenarios:delete', (_event, projectPath: string, caseId: string) => {
    if (!projectPath || !caseId || !existsSync(projectPath)) return false
    const file = join(scenariosDirFor(projectPath), `${caseId}.json`)
    if (!existsSync(file)) return false
    try { unlinkSync(file); return true } catch { return false }
  })
  ipcMain.handle('scenarios:import', (_event, projectPath: string, scenarios: Array<{ caseId: string; scenario: unknown }>) => {
    if (!projectPath || !Array.isArray(scenarios) || !existsSync(projectPath)) return { imported: 0, skipped: 0 }
    const dir = scenariosDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    let imported = 0, skipped = 0
    for (const item of scenarios) {
      if (!item?.caseId || typeof item.scenario !== 'object') { skipped++; continue }
      try { writeFileSync(join(dir, `${item.caseId}.json`), JSON.stringify(item.scenario, null, 2), 'utf8'); imported++ } catch { skipped++ }
    }
    return { imported, skipped }
  })
  ipcMain.handle('scenarios:export', (_event, projectPath: string, caseIds?: string[]) => {
    if (!projectPath || !existsSync(projectPath)) return []
    const dir = scenariosDirFor(projectPath)
    if (!existsSync(dir)) return []
    const result: Array<{ caseId: string; scenario: unknown }> = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const caseId = file.replace(/\.json$/, '')
      if (caseIds && caseIds.length && !caseIds.includes(caseId)) continue
      try {
        const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        result.push({ caseId, scenario })
      } catch { /* 忽略损坏文件 */ }
    }
    return result
  })

  // ===== P3-1 回归套件 IPC（SuiteLibrary 本地实现，照 cases:* 自含模式，控制面零改动） =====
  // Suite 数据模型 + 存储布局：.test-agent/suites/<id>.json（引用 caseIds，不复制用例数据）
  interface Suite {
    id: string
    name: string
    projectPath: string
    projectHash: string
    caseIds: string[]
    testStrategy: 'reflect' | 'junit'
    createdAt: string
    lastRunAt?: string
    lastRunResult?: { total: number; pass: number; fail: number; skipped: number }
  }

  function suitesDirFor(projectPath: string): string {
    return join(projectPath, '.test-agent', 'suites')
  }

  function computeSuiteId(projectHash: string, name: string): string {
    return createHash('sha256').update(`${projectHash}:${name}`).digest('hex').slice(0, 16)
  }

  function loadSuiteList(projectPath: string): Suite[] {
    const dir = suitesDirFor(projectPath)
    if (!existsSync(dir)) return []
    const suites: Suite[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'index.json') continue
      try {
        const s = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Suite
        if (s && s.id) suites.push(s)
      } catch { /* 忽略损坏文件 */ }
    }
    return suites
  }

  function getSuite(projectPath: string, suiteId: string): Suite | undefined {
    const file = join(suitesDirFor(projectPath), `${suiteId}.json`)
    if (!existsSync(file)) return undefined
    try { return JSON.parse(readFileSync(file, 'utf8')) as Suite } catch { return undefined }
  }

  function saveSuite(suite: Suite): void {
    const dir = suitesDirFor(suite.projectPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${suite.id}.json`), JSON.stringify(suite, null, 2), 'utf8')
  }

  function deleteSuiteFile(projectPath: string, suiteId: string): boolean {
    const file = join(suitesDirFor(projectPath), `${suiteId}.json`)
    if (!existsSync(file)) return false
    try { writeFileSync(file, '', 'utf8'); return true } catch { return false }
    // 软删除：清空文件内容（与 CaseLibrary deleteCase 模式一致，保留文件但不读取）
  }

  ipcMain.handle('suite:save', (_event, projectPath: string, name: string, caseIds: string[], testStrategy: 'reflect' | 'junit') => {
    if (!projectPath || !name || !existsSync(projectPath)) return { error: '参数无效' }
    const projectHash = computeProjectHash(projectPath)
    const id = computeSuiteId(projectHash, name)
    const existing = getSuite(projectPath, id)
    const suite: Suite = {
      id, name, projectPath, projectHash,
      caseIds, testStrategy,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastRunResult ? { lastRunResult: existing.lastRunResult } : {}),
    }
    saveSuite(suite)
    return { ok: true, suiteId: id }
  })

  ipcMain.handle('suite:list', (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return []
    return loadSuiteList(projectPath)
  })

  ipcMain.handle('suite:delete', (_event, projectPath: string, suiteId: string) => {
    if (!projectPath || !suiteId || !existsSync(projectPath)) return { error: '参数无效' }
    deleteSuiteFile(projectPath, suiteId)
    return { ok: true }
  })

  ipcMain.handle('suite:run', async (_event, projectPath: string, suiteId: string) => {
    if (!projectPath || !suiteId || !existsSync(projectPath)) {
      return { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: '参数无效或项目目录不存在' }
    }
    const suite = getSuite(projectPath, suiteId)
    if (!suite) return { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: '套件不存在' }

    // 加载用例（从 CaseLibrary，用 computeCaseId 逐条算 caseId）
    const allCases = loadCasesFromLibrary(projectPath) as Array<Record<string, unknown>>
    const suiteCases = allCases.filter(c => {
      const legacyId = computeCaseId(suite.projectHash, String(c.title ?? ''))
      return suiteContainsCase(suite.caseIds, c, legacyId)
    })
    if (!suiteCases.length) return { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: '套件用例为空或已删除' }

    // P6: 读项目级配置（.test-agent/config.json），多主类项目指定 springMainClass 避免 scan 选错
    const projectConfig = readProjectConfig(projectPath)

    const results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }> = []
    let suiteRunTime: number | undefined

    if (suite.testStrategy === 'reflect') {
      // 反射批量：加载场景文件 → reflectBatchMavenCommandSpec（一次 mvn test 跑多场景）
      try { injectReflectTestRunner(projectPath) } catch (e) {
        for (const c of suiteCases) results.push({ name: String(c.title ?? ''), ok: false, output: '', error: `注入失败：${(e as Error).message}` })
        return { results, summary: { total: results.length, pass: 0, fail: results.length, skipped: 0 } }
      }
      const scenarioFiles: string[] = []
      const matchedCases: Array<{ title: string; caseId: string }> = []
      const scenariosDir = scenariosDirFor(projectPath)
      for (const c of suiteCases) {
        const cid = suiteCaseId(c, computeCaseId(suite.projectHash, String(c.title ?? '')))
        const sf = join(scenariosDir, `${cid}.json`)
        if (existsSync(sf)) {
          scenarioFiles.push(sf)
          matchedCases.push({ title: String(c.title ?? ''), caseId: cid })
        } else {
          results.push({ name: String(c.title ?? ''), ok: false, output: '', error: '场景文件不存在' })
        }
      }
      if (scenarioFiles.length) {
        const spec = reflectBatchMavenCommandSpec(projectPath, scenarioFiles, process.platform, projectConfig.springMainClass)
        const r = await spawnCollect(spec)
        // P6: 逐条解析 surefire XML，无 XML/对齐失败 → 降级整体 ok
        const parsed = applySurefirePerCase(projectPath, matchedCases, r, results)
        if (!parsed.applied) {
          for (const c of matchedCases) {
            results.push({ name: c.title, ok: r.ok, output: r.ok ? '' : r.output.slice(-2000), error: r.error })
          }
        }
        suiteRunTime = parsed.time
      }
    } else {
      // JUnit 批量：junitBatchMavenCommandSpec（有 structuredScenario 的取 testClass，无的标 skipped）
      const reflectCases = suiteCases.filter(c => c.structuredScenario)
      const junitCases = suiteCases.filter(c => !c.structuredScenario)

      if (reflectCases.length) {
        // 有 structuredScenario 的用反射批量重跑
        try { injectReflectTestRunner(projectPath) } catch (e) {
          for (const c of reflectCases) results.push({ name: String(c.title ?? ''), ok: false, output: '', error: `注入失败：${(e as Error).message}` })
        }
        const scenarioFiles: string[] = []
        const matchedCases: Array<{ title: string; caseId: string }> = []
        const scenariosDir = scenariosDirFor(projectPath)
        for (const c of reflectCases) {
          const cid = suiteCaseId(c, computeCaseId(suite.projectHash, String(c.title ?? '')))
          const sf = join(scenariosDir, `${cid}.json`)
          if (existsSync(sf)) {
            scenarioFiles.push(sf)
            matchedCases.push({ title: String(c.title ?? ''), caseId: cid })
          } else {
            results.push({ name: String(c.title ?? ''), ok: false, output: '', error: '场景文件不存在' })
          }
        }
        if (scenarioFiles.length) {
          const spec = reflectBatchMavenCommandSpec(projectPath, scenarioFiles, process.platform, projectConfig.springMainClass)
          const r = await spawnCollect(spec)
          // P6: 逐条解析 surefire XML，无 XML/对齐失败 → 降级整体 ok
          const parsed = applySurefirePerCase(projectPath, matchedCases, r, results)
          if (!parsed.applied) {
            for (const c of matchedCases) {
              results.push({ name: c.title, ok: r.ok, output: r.ok ? '' : r.output.slice(-2000), error: r.error })
            }
          }
          if (parsed.time !== undefined) suiteRunTime = parsed.time
        }
      }

      // 无 structuredScenario 的 JUnit 用例标 skipped（reviewer P1-3）
      for (const c of junitCases) {
        results.push({ name: String(c.title ?? ''), ok: false, output: '', skipped: true, error: '无结构化场景，无法批量重跑' })
      }
    }

    // 更新套件 lastRunAt + lastRunResult
    const pass = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok && !r.skipped).length
    const skipped = results.filter(r => r.skipped).length
    suite.lastRunAt = new Date().toISOString()
    suite.lastRunResult = { total: results.length, pass, fail, skipped }
    saveSuite(suite)

    return { results, summary: { total: results.length, pass, fail, skipped, ...(suiteRunTime !== undefined ? { time: suiteRunTime } : {}) } }
  })

  // ===== P0 项3 + P1-2：本地 spawn mvn 收集输出 helper（抽出供 rerunLocal/rerunFailedBatch 复用） =====
  type SpawnResult = { ok: boolean; output: string; error?: string }
  function spawnCollect(spec: { command: string; args: string[]; cwd: string }, timeoutMs = 5 * 60 * 1000): Promise<SpawnResult> {
    return new Promise((resolveP) => {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, windowsHide: true })
      const outputChunks: Buffer[] = []
      child.stdout?.on('data', (d: Buffer) => { outputChunks.push(Buffer.from(d)) })
      child.stderr?.on('data', (d: Buffer) => { outputChunks.push(Buffer.from(d)) })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolveP({ ok: false, output: decodeProcessOutput(outputChunks) + `\n[超时 ${Math.round(timeoutMs / 60000)}min]`, error: '超时' })
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        const output = decodeProcessOutput(outputChunks)
        resolveP({ ok: code === 0, output, error: code === 0 ? undefined : `exit ${code}` })
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolveP({ ok: false, output: decodeProcessOutput(outputChunks), error: `spawn 失败：${e.message}` })
      })
    })
  }

  // ===== P6: surefire XML 逐条解析 helper（反射批量路径用，正则解析固定结构 XML，不引依赖） =====
  /**
   * 解析 TEST-com.cxmt.testagent.ReflectTestRunner.xml，提取每个 testcase 的 ok/fail + 失败原因。
   * XML 结构固定：<testsuite tests=failures=errors=time=><testcase name= time=>[<failure message= type=>body</failure>|<error ...>]</testcase></testsuite>
   * 返回 cases 按 testcase 出现顺序，与 scenarioFiles 对齐（runScenarios[i] 1-indexed → cases[i-1] 0-indexed）。
   */
  function parseSurefireXml(xml: string): {
    tests: number; failures: number; errors: number; time?: number;
    cases: Array<{ name: string; ok: boolean; failureMessage?: string; time?: number }>;
  } {
    const cases: Array<{ name: string; ok: boolean; failureMessage?: string; time?: number }> = [];
    // testsuite 汇总属性（各自独立匹配，不依赖属性顺序）
    const testsMatch = xml.match(/<testsuite\b[^>]*\btests="(\d+)"/);
    const failuresMatch = xml.match(/<testsuite\b[^>]*\bfailures="(\d+)"/);
    const errorsMatch = xml.match(/<testsuite\b[^>]*\berrors="(\d+)"/);
    const tests = testsMatch ? +testsMatch[1] : 0;
    const failures = failuresMatch ? +failuresMatch[1] : 0;
    const errors = errorsMatch ? +errorsMatch[1] : 0;
    const timeMatch = xml.match(/<testsuite\b[^>]*\btime="([\d.]+)"/);
    const time = timeMatch ? parseFloat(timeMatch[1]) : undefined;
    // 逐 testcase 块（自闭合 /> 或含子元素 </testcase>，非贪婪到任一结束）
    const blockRegex = /<testcase\b([\s\S]*?)(?:\/\s*>|<\/testcase>)/g;
    let m: RegExpExecArray | null;
    while ((m = blockRegex.exec(xml)) !== null) {
      const block = m[1] || '';
      const nameMatch = block.match(/\bname="([^"]*)"/);
      const timeAttrMatch = block.match(/\btime="([\d.]+)"/);
      const name = nameMatch ? nameMatch[1] : '';
      const tcTime = timeAttrMatch ? parseFloat(timeAttrMatch[1]) : undefined;
      // failure 或 error 子元素（block 含开标签后内容）
      const failMatch = block.match(/<failure\b([^>]*)>([\s\S]*?)<\/failure>/)
        || block.match(/<error\b([^>]*)>([\s\S]*?)<\/error>/);
      if (failMatch) {
        const failAttrs = failMatch[1] || '';
        const body = (failMatch[2] || '').trim();
        const msgAttr = failAttrs.match(/\bmessage="([^"]*)"/);
        // message 属性更干净（body 含堆栈）；优先 message，回退 body
        const failureMessage = (msgAttr && msgAttr[1]) ? msgAttr[1] : (body || '失败');
        cases.push({ name, ok: false, failureMessage, time: tcTime });
      } else {
        cases.push({ name, ok: true, time: tcTime });
      }
    }
    return { tests, failures, errors, time, cases };
  }

  /**
   * P6: 反射批量跑完后读 surefire XML → 逐条映射 matchedCases → 填 results。
   * 返回 true 表示已逐条解析；false 表示降级（调用方走整体 ok）。
   */
  function applySurefirePerCase(
    projectPath: string,
    matchedCases: Array<{ title: string; caseId: string }>,
    r: SpawnResult,
    results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }>,
  ): { applied: boolean; time?: number } {
    const xmlPath = join(projectPath, 'target', 'surefire-reports', 'TEST-com.cxmt.testagent.ReflectTestRunner.xml');
    if (!existsSync(xmlPath)) return { applied: false };
    let xml: string;
    try { xml = readFileSync(xmlPath, 'utf-8'); } catch { return { applied: false }; }
    const parsed = parseSurefireXml(xml);
    if (!parsed.cases.length) return { applied: false };
    // 对齐：surefire testcase 数应等于 matchedCases 数（runScenarios[i] → matchedCases[i-1]）
    if (parsed.cases.length !== matchedCases.length) {
      for (const c of matchedCases) {
        results.push({ name: c.title, ok: r.ok, output: r.ok ? '' : r.output.slice(-2000),
          error: r.ok ? undefined : `surefire testcase 数(${parsed.cases.length})与场景数(${matchedCases.length})不一致，整体 ${r.ok ? '通过' : '失败'}\n${r.output.slice(-1500)}` });
      }
      return { applied: true, time: parsed.time };
    }
    for (let i = 0; i < matchedCases.length; i++) {
      const tc = parsed.cases[i];
      const c = matchedCases[i];
      results.push({
        name: c.title,
        ok: tc.ok,
        output: tc.ok ? '' : (tc.failureMessage ?? ''),
        error: tc.ok ? undefined : (tc.failureMessage ?? '失败'),
      });
    }
    return { applied: true, time: parsed.time };
  }

  ipcMain.handle('task:runAllLocal', async (_event, projectPath: string) => {
    if (!projectPath || !existsSync(projectPath)) return { ok: false, output: '', error: '项目目录不存在' }
    const spec = process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'mvn.cmd test'], cwd: projectPath }
      : { command: 'mvn', args: ['test'], cwd: projectPath }
    const result = await spawnCollect(spec)
    return result.ok ? result : { ...result, error: summarizeMavenFailure(result.output, result.error) }
  })

  ipcMain.handle('task:runSelectedReflect', async (_event, projectPath: string, caseIds: string[]) => {
    const empty = (error: string) => ({ results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error })
    if (!projectPath || !existsSync(projectPath)) return empty('项目目录不存在')
    const selectedIds = [...new Set(caseIds.filter(Boolean))]
    if (!selectedIds.length) return empty('请至少选择一个反射场景')
    const projectHash = computeProjectHash(projectPath)
    const allCases = loadCasesFromLibrary(projectPath) as Array<Record<string, unknown>>
    const byId = new Map(allCases.map(c => [String(c.id ?? computeCaseId(projectHash, String(c.title ?? ''))), c]))
    const selected = selectedIds.map(id => ({ id, item: byId.get(id) }))
    const missingCases = selected.filter(entry => !entry.item).map(entry => entry.id)
    if (missingCases.length) return empty(`用例库中找不到 ${missingCases.length} 条所选用例，已停止执行`)
    const scenarioFiles = selected.map(entry => join(scenariosDirFor(projectPath), `${entry.id}.json`))
    const missingFiles = scenarioFiles.filter(file => !existsSync(file))
    if (missingFiles.length) return empty(`${missingFiles.length} 条所选用例没有反射场景文件，已停止执行`)
    try { injectReflectTestRunner(projectPath) } catch (error) {
      return empty(`反射执行器注入失败：${(error as Error).message}`)
    }
    const projectConfig = readProjectConfig(projectPath)
    const spec = reflectBatchMavenCommandSpec(projectPath, scenarioFiles, process.platform, projectConfig.springMainClass)
    const run = await spawnCollect(spec)
    const results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }> = []
    const matchedCases = selected.map(entry => ({ title: String(entry.item?.title ?? entry.id), caseId: entry.id }))
    const parsed = applySurefirePerCase(projectPath, matchedCases, run, results)
    if (!parsed.applied || results.length !== selectedIds.length) {
      return { results, summary: { total: selectedIds.length, pass: 0, fail: selectedIds.length, skipped: 0 }, error: `实际结果无法与 ${selectedIds.length} 条所选场景逐条核对，未认定执行成功` }
    }
    const pass = results.filter(item => item.ok).length
    const fail = results.length - pass
    return { results, summary: { total: results.length, pass, fail, skipped: 0, ...(parsed.time !== undefined ? { time: parsed.time } : {}) }, ...(run.error ? { error: run.error } : {}) }
  })

  // ===== P0 项3：单场景重跑 IPC（task:rerunLocal，main 本地 spawn mvn，不进 control-server） =====
  // 照 cases:save 模式：main 是可信层，直接本地 spawn。参数 (projectPath, caseId) →
  // 注入 ReflectTestRunner.java（幂等）→ reflectMavenCommandSpec 构造命令 → spawnCollect 收集输出。
  ipcMain.handle('task:rerunLocal', async (_event, projectPath: string, caseId: string) => {
    if (!projectPath || !caseId || !existsSync(projectPath)) {
      return { ok: false, output: '', error: '参数无效或项目目录不存在' }
    }
    const scenarioFile = join(scenariosDirFor(projectPath), `${caseId}.json`)
    if (!existsSync(scenarioFile)) {
      return { ok: false, output: '', error: `场景文件不存在：${scenarioFile}` }
    }
    try {
      injectReflectTestRunner(projectPath)
    } catch (e) {
      return { ok: false, output: '', error: `注入 ReflectTestRunner.java 失败：${(e as Error).message}` }
    }
    const spec = reflectMavenCommandSpec(projectPath, scenarioFile)
    return spawnCollect(spec)
  })

  // ===== P1-2：批量只跑失败重跑 IPC（task:rerunFailedBatch，main 本地 spawn mvn，不进 control-server） =====
  // 分流：反射用例（有 caseId）逐条 inject + reflectMavenCommandSpec；JUnit 用例（有 testClass）一次 junitBatchMavenCommandSpec；无两者跳过。
  ipcMain.handle('task:rerunFailedBatch', async (_event, projectPath: string, failedCases: Array<{ name: string; layer: string; caseId?: string; testClass?: string }>) => {
    if (!projectPath || !existsSync(projectPath)) {
      return { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: '参数无效或项目目录不存在' }
    }
    const results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }> = []
    const reflectCases = failedCases.filter(c => c.caseId)
    const junitCases = failedCases.filter(c => !c.caseId && c.testClass)
    const skippedCases = failedCases.filter(c => !c.caseId && !c.testClass)

    // 反射批量：逐条跑（复用 P0 项3 逻辑）
    if (reflectCases.length) {
      try {
        injectReflectTestRunner(projectPath)
      } catch (e) {
        // 注入失败，给 reflectCases 全部标 fail 后跳过循环（reviewer 澄清2）
        for (const c of reflectCases) results.push({ name: c.name, ok: false, output: '', error: `注入失败：${(e as Error).message}` })
        reflectCases.length = 0
      }
      for (const c of reflectCases) {
        const scenarioFile = join(scenariosDirFor(projectPath), `${c.caseId}.json`)
        if (!existsSync(scenarioFile)) { results.push({ name: c.name, ok: false, output: '', error: '场景文件不存在' }); continue }
        const spec = reflectMavenCommandSpec(projectPath, scenarioFile)
        const r = await spawnCollect(spec)
        results.push({ name: c.name, ok: r.ok, output: r.output, error: r.error })
      }
    }

    // JUnit 批量：一次跑 -Dtest=Class1,Class2（reviewer 必处理：junitBatchMavenCommandSpec 单字符串拼法）
    if (junitCases.length) {
      const testClasses = [...new Set(junitCases.map(c => c.testClass!))]
      const spec = junitBatchMavenCommandSpec(projectPath, testClasses)
      const r = await spawnCollect(spec)
      // JUnit 批量输出整体，逐条 ok 难拆 → 整体 ok 全 pass，失败标见输出
      for (const c of junitCases) {
        results.push({ name: c.name, ok: r.ok, output: r.ok ? '' : r.output.slice(-2000), error: r.error })
      }
    }

    // 跳过
    for (const c of skippedCases) results.push({ name: c.name, ok: false, output: '', skipped: true, error: '无 caseId/testClass 无法重跑' })

    const pass = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok && !r.skipped).length
    const skipped = results.filter(r => r.skipped).length
    return { results, summary: { total: results.length, pass, fail, skipped } }
  })

  // ===== 质量看板 IPC（PRD 功能二片3：读 Worker 本地 weekly.jsonl） =====
  ipcMain.handle('metrics:get', (_event, projectPath: string, range?: { start: string; end: string }) => {
    if (!projectPath || !existsSync(projectPath)) return []
    const projectHash = computeProjectHash(projectPath)
    const metricsBaseDir = join(projectPath, '.test-agent', 'metrics')
    return loadWeeklyMetrics(metricsBaseDir, projectHash, range)
  })

  // ===== 缺陷联动 IPC（PRD 功能三：一键建单） =====
  // [需人工复核-控制面改动] 控制面无对应端点，使用 test-agent 本地 createDefectTracker。
  // Jira 配齐环境变量时用 Jira，否则回退 Mock（确定性 ok=true）。
  ipcMain.handle('defect:create', async (_event, input: DefectCreateInput): Promise<DefectCreateResult> => {
    try {
      const tracker = createDefectTracker()
      return await tracker.createDefect(input)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ===== Escalation 答复 IPC（片B：renderer → main → host-cli → handler.reply） =====
  ipcMain.handle('escalation:reply', async (_event, executionId: string, escalationId: string, answer: string): Promise<boolean> => {
    if (!localHostClient) return false
    try {
      localHostClient.sendEscalationReply(executionId, escalationId, answer)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('escalation:dismiss', async (_event, executionId: string, escalationId: string): Promise<boolean> => {
    if (!localHostClient) return false
    try {
      return await localHostClient.dismissEscalation(executionId, escalationId)
    } catch {
      return false
    }
  })

  // ===== Escalation 历史审计 IPC（读 .test-agent/escalations/<hash>/audit.jsonl）=====
  ipcMain.handle('escalation:audit', (_event, projectPath: string): EscalationRecord[] => {
    if (!projectPath || !existsSync(projectPath)) return []
    try {
      const projectHash = computeProjectHash(projectPath)
      const filePath = join(projectPath, '.test-agent', 'escalations', projectHash, 'audit.jsonl')
      if (!existsSync(filePath)) return []
      const raw = readFileSync(filePath, 'utf8')
      const result: EscalationRecord[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          result.push(JSON.parse(line) as EscalationRecord)
        } catch {
          // 跳过损坏行（进程崩溃/磁盘满/断电致末行截断），保留完好行
        }
      }
      return result
    } catch (error) {
      console.error('[main] loadEscalationAudit failed:', error)
      return []
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const timer of taskWatchers.values()) clearInterval(timer)
  taskWatchers.clear()
  localHostClient?.close()
  localHostClient = null
})
