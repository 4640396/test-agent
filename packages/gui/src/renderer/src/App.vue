<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { AiConfig, TaskInput, TestType, HostMessage, RunResultMessage } from '@cxmt/protocol'
import type { FailedCaseRecord, HistoryRecord, LocalHostStatus, RoutingRecord, RuntimeStatus, TaskSnapshot, TestCaseRecord, DefectCreateResult, DashboardWeeklyPoint, DashboardAnomalyAlert, EscalationRecord, Suite, SuiteRunResult, TimelineRecord, EnvironmentProfile } from '../../types.js'
import { emptyLanes, laneLabels } from './task-state'
import WorkspaceNav from './components/WorkspaceNav.vue'
import TaskJourney from './components/TaskJourney.vue'
import { taskJourney } from './task-journey'
import { retryStageAction } from './retry-stage'
import { evidenceByCaseId } from './case-evidence'
import { mapCoreQualityGate } from './quality-gate-view'
import { startReservedLocalRun } from './local-run'
import SuitesPanel from './components/SuitesPanel.vue'
import ScenariosPanel from './components/ScenariosPanel.vue'
import QuickReflectRun from './components/QuickReflectRun.vue'

type View = 'home' | 'plan' | 'run' | 'diagnosis' | 'fix' | 'report' | 'history' | 'settings' | 'dashboard' | 'suites' | 'scenarios'

const form = reactive<TaskInput>({ projectPath: '', systemName: '', version: '', testTypes: ['unit'], coverageTarget: 80, uiEntryUrl: '', apiBaseUrl: '', openApiUrl: '', testStrategy: 'junit' })
function setTestStrategy(mode: 'reflect' | 'junit'): void { form.testStrategy = mode }
const isJavaProject = computed(() => (form.requiredCapabilities ?? []).some(capability => capability === 'java' || capability === 'maven'))
const executionBackendLabel = computed(() => {
  const labels: string[] = []
  if (form.testTypes.some(type => type === 'unit' || type === 'regression')) {
    labels.push(isJavaProject.value ? (form.testStrategy === 'reflect' ? '反射测试' : 'JUnit') : 'Node Test')
  }
  if (form.testTypes.includes('ui')) labels.push('Playwright')
  if (form.testTypes.includes('api')) labels.push('HTTP API')
  return labels.join(' / ')
})
const snapshot = ref<TaskSnapshot | null>(null)
const error = ref('')
const projectSupportError = ref('')
const starting = ref(false)
const runtime = ref<RuntimeStatus>({ mode: 'unavailable', provider: null, message: '本机 Host 未就绪；请在桌面应用中启动服务后继续。' })
const knowledgeRoots = ref<string[]>([])
const localStatus = ref<LocalHostStatus>({ running: false })
const localLogs = ref<TaskSnapshot['logs']>([])
const localTaskId = ref('')

/**
 * Reserve the execution id before IPC starts the Host run. The Host can emit
 * run-accepted/events before ipcRenderer.invoke resolves; assigning the id
 * afterwards makes those early messages look like they belong to an old task.
 */
async function startLocalRun(input: TaskInput): Promise<{ taskId: string }> {
  return startReservedLocalRun(input, window.testAgentLocal.start, id => { localTaskId.value = id })
}
interface GenerationTargetProgress {
  target: string
  outputPath: string
  status: 'queued' | 'running' | 'retrying' | 'completed' | 'reused' | 'failed'
  message?: string
}
const generationTargets = ref<GenerationTargetProgress[]>([])
const generationCompletedCount = computed(() => generationTargets.value.filter(item => item.status === 'completed' || item.status === 'reused').length)
const generationActiveCount = computed(() => generationTargets.value.filter(item => item.status === 'running' || item.status === 'retrying').length)

// Agent 结构化事件（union type 事件）
interface AgentToolCall {
  toolCallId: string
  toolName: string
  status: 'running' | 'done' | 'error'
  argsText: string
  resultSummary?: string
  startedAt?: number
  testDetails?: { ok: boolean; pass: number; fail: number; tests: number; coverage: number | null }
}
interface AgentTurn {
  turn: number
  status: 'running' | 'done' | 'error'
  thinkingText: string
  toolCalls: AgentToolCall[]
  role?: string
}
interface AgentWorkRecord {
  role?: string
  status: 'running' | 'done' | 'error'
  thinkingText: string
  toolCalls: AgentToolCall[]
  readCount: number
}
const agentTurns = ref<AgentTurn[]>([])

// P4-6：精简日志流——一行一事件，默认展示（agentTurns 供折叠详情）
interface AgentLogLine {
  id: string
  time: string
  role?: string
  turn: number
  toolName: string
  summary: string
  status: 'running' | 'done' | 'error'
  resultSummary?: string
  toolCallId: string
  eventAt: number
}
const agentLogLines = ref<AgentLogLine[]>([])

// P4-6 合并：统一日志行（展示用，不持久化）
interface UnifiedLogLine {
  id: string
  time: string
  level: 'info' | 'success' | 'warning' | 'error'
  text: string
  role?: string
  eventAt: number
}

// ===== 角色可视化（切片 2-4）=====
/** 5 角色中文名映射，集中定义复用。 */
const roleNames: Record<string, string> = {
  scout: '项目分析',
  'case-designer': '用例设计',
  'test-generator': '测试生成',
  tester: '测试执行',
  'result-reviewer': '诊断分析',
  fixer: '修复执行',
  planner: '调度器',
}
const roleWorkingStatuses: Record<string, string> = {
  scout: '正在分析项目',
  'case-designer': '正在设计用例',
  'test-generator': '正在生成测试代码',
  tester: '正在执行测试',
  'result-reviewer': '正在分析失败',
  fixer: '正在修复问题',
  planner: '正在调度任务',
}
function displayRoleName(role?: string): string {
  if (!role) return 'Agent'
  if (role.startsWith('test-generator:')) {
    const [, slot, target] = role.split(':')
    return `测试生成 ${slot}${target ? ` · ${target}` : ''}`
  }
  return roleNames[role] ?? role
}
function roleWorkingStatus(role: string): string {
  return role.startsWith('test-generator:') ? `${displayRoleName(role)} 正在生成` : roleWorkingStatuses[role] ?? `正在执行 ${role}`
}
/** 角色执行顺序（流转图按此排列）。 */
const roleOrder = ['scout', 'case-designer', 'tester', 'result-reviewer', 'fixer'] as const

interface RoleState {
  name: string
  status: 'idle' | 'running' | 'done' | 'escalating'
  turnCount: number
  lastTool?: string
  escalationCount: number
}

function initRoleStates(): Record<string, RoleState> {
  const states: Record<string, RoleState> = {}
  for (const role of roleOrder) {
    states[role] = { name: role, status: 'idle', turnCount: 0, escalationCount: 0 }
  }
  return states
}

const roleStates = ref<Record<string, RoleState>>(initRoleStates())
/** null=显示全部角色轮次（向后兼容）；选中角色则仅过滤该角色事件。 */
const selectedRole = ref<string | null>(null)
const agentRunning = ref(false)
/** Coordinator 调度状态文本，从 AgentEvent 推导（派 X 中 / X 完成 / 规划中 …）。 */
const coordinatorStatus = ref<string>('')

// ===== 切片 3C：调度消息流（dispatch/ask/report 从 AgentEvent 推导） =====
/** 调度消息条目——照 pi-intercom 消息日志模式，from→to + 类型 + 内容 + 时间戳。 */
interface DispatchMessage {
  id: string
  type: 'dispatch' | 'ask' | 'report' | 'reply'
  from: string
  to: string
  content: string
  timestamp: number
}
/** Coordinator 活跃标记：收到 coordinator-message 事件时设 true，run-accepted 时重置 false。非 Coordinator 场景不显示 dispatch-flow（诚实）。 */
const coordinatorActive = ref(false)
const dispatchMessages = ref<DispatchMessage[]>([])
const planPending = ref(false)
const plannedCases = ref<TestCaseRecord[]>([])
// 已确认/已进入执行阶段的计划也必须保留给重启恢复和只读查看。
const completedPlannedCases = ref<TestCaseRecord[]>([])
const planCaseQuery = ref('')
const planCaseLayer = ref('all')
const planCasePriority = ref('all')
const planCasePage = ref(1)
const planCasePageSize = 10
const expandedPlanCaseId = ref<string | null>(null)
const selectedPlanCaseIds = ref<string[]>([])
const bulkCasePriority = ref('')
const bulkCaseLayer = ref('')
const visiblePlanCases = computed(() => {
  if (planPending.value) return plannedCases.value
  if (plannedCases.value.length) return plannedCases.value
  if (completedPlannedCases.value.length) return completedPlannedCases.value
  return snapshot.value?.report?.cases ?? []
})
const planCaseRows = computed(() => visiblePlanCases.value.map((item, index) => ({ item, index })))
const filteredPlanCaseRows = computed(() => {
  const query = planCaseQuery.value.trim().toLocaleLowerCase()
  return planCaseRows.value.filter(({ item }) =>
    (planCaseLayer.value === 'all' || (item.layer ?? '') === planCaseLayer.value) &&
    (planCasePriority.value === 'all' || item.priority === planCasePriority.value) &&
    (!query || [item.title, item.scenario, item.expected, item.target].some(value => String(value ?? '').toLocaleLowerCase().includes(query)))
  )
})
const planCasePageCount = computed(() => Math.max(1, Math.ceil(filteredPlanCaseRows.value.length / planCasePageSize)))
const visiblePlanCaseRows = computed(() => filteredPlanCaseRows.value.slice((Math.min(planCasePage.value, planCasePageCount.value) - 1) * planCasePageSize, Math.min(planCasePage.value, planCasePageCount.value) * planCasePageSize))
const currentPageFullySelected = computed(() => visiblePlanCaseRows.value.length > 0 && visiblePlanCaseRows.value.every(({ item }) => selectedPlanCaseIds.value.includes(item.id)))
function invalidCases(cases: TestCaseRecord[]): TestCaseRecord[] {
  const seen = new Set<string>()
  return cases.filter(item => {
    const id = item.id.trim()
    const invalidApiContract = item.layer === 'api' && (
      !item.method ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(item.method.toUpperCase()) ||
      !item.path?.startsWith('/') ||
      !Number.isInteger(item.expectedStatus) ||
      (item.expectedStatus ?? 0) < 100 ||
      (item.expectedStatus ?? 0) > 599 ||
      (!(item.expectedBodyContains?.some(value => value.trim())) && !item.expectedJsonSubset)
    )
    const invalid = !id || seen.has(id) || !item.title.trim() || !item.scenario.trim() || !item.expected.trim() || !item.steps?.some(step => step.trim()) || invalidApiContract
    seen.add(id)
    return invalid
  })
}
const selectedPlanCases = computed(() => {
  const ids = new Set(selectedPlanCaseIds.value)
  return plannedCases.value.filter(item => ids.has(item.id))
})
const executionPlanCases = computed(() => executionScope.value === 'selected' ? selectedPlanCases.value : plannedCases.value)
const invalidPlanCases = computed(() => invalidCases(executionPlanCases.value))
watch([planCaseQuery, planCaseLayer, planCasePriority], () => { planCasePage.value = 1 })
watch(planCasePageCount, count => { if (planCasePage.value > count) planCasePage.value = count })
function toggleCurrentPageCases(): void {
  const ids = visiblePlanCaseRows.value.map(({ item }) => item.id)
  selectedPlanCaseIds.value = currentPageFullySelected.value
    ? selectedPlanCaseIds.value.filter(id => !ids.includes(id))
    : Array.from(new Set([...selectedPlanCaseIds.value, ...ids]))
}
function bulkUpdateCases(field: 'priority' | 'layer', value: string): void {
  if (!value) return
  const ids = new Set(selectedPlanCaseIds.value)
  plannedCases.value.forEach((item, index) => { if (ids.has(item.id)) updateCase(index, field, value) })
  if (field === 'priority') bulkCasePriority.value = ''
  else bulkCaseLayer.value = ''
}
function bulkDeleteCases(): void {
  const ids = new Set(selectedPlanCaseIds.value)
  if (!ids.size || !window.confirm(`确定删除选中的 ${ids.size} 条用例吗？此操作会同步到用例库。`)) return
  for (let index = plannedCases.value.length - 1; index >= 0; index--) {
    if (ids.has(plannedCases.value[index].id)) deleteCase(index)
  }
  selectedPlanCaseIds.value = []
}
const testExecutionSummary = ref<{ passed: number; failed: number } | null>(null)
const executionScope = ref<'full' | 'incremental' | 'selected'>('full')
const planImpactPreview = ref<{ total: number; selected: number; skipped: number; changedFilesCount: number; fallbackReason: string | null } | null>(null)
const planImpactLoading = ref(false)
const planImpactError = ref('')
let planImpactTimer: ReturnType<typeof setTimeout> | undefined
let planImpactRevision = 0
watch([plannedCases, selectedPlanCaseIds, executionScope, () => form.projectPath, planPending], () => {
  const revision = ++planImpactRevision
  if (planImpactTimer) clearTimeout(planImpactTimer)
  planImpactPreview.value = null
  planImpactError.value = ''
  planImpactLoading.value = false
  if (!planPending.value || !form.projectPath || !plannedCases.value.length) return
  if (executionScope.value !== 'incremental') {
    const selected = executionPlanCases.value.length
    planImpactPreview.value = { total: plannedCases.value.length, selected, skipped: plannedCases.value.length - selected, changedFilesCount: 0, fallbackReason: null }
    return
  }
  planImpactLoading.value = true
  planImpactTimer = setTimeout(() => {
    void window.testAgent.previewPlanImpact(form.projectPath, JSON.parse(JSON.stringify(plannedCases.value)) as TestCaseRecord[])
      .then(result => { if (revision === planImpactRevision) planImpactPreview.value = result })
      .catch(reason => { if (revision === planImpactRevision) planImpactError.value = reason instanceof Error ? reason.message : '增量范围预估失败' })
      .finally(() => { if (revision === planImpactRevision) planImpactLoading.value = false })
  }, 250)
}, { deep: true })
const lastActivityAt = ref<number | null>(null)
const clockNow = ref(Date.now())
let activityClock: ReturnType<typeof setInterval> | undefined
const secondsSinceActivity = computed(() => lastActivityAt.value === null ? 0 : Math.max(0, Math.floor((clockNow.value - lastActivityAt.value) / 1000)))
// ===== 断点恢复：持久化已完成阶段产物 + 当前阶段（防刷新/重跑） =====
const completedScoutReport = ref<string>('')
const currentPhase = ref<'scout' | 'design' | 'generate' | 'execute' | 'fix' | ''>('')
const planningActive = ref(false)
const executionConfirmed = ref(false)
const planTaskId = ref<string | null>(null)
const history = ref<HistoryRecord[]>([])
const envEntries = ref<Array<{ key: string; value: string }>>([])
const apiHeaderEntries = ref<Array<{ key: string; value: string }>>([])
const environments = ref<EnvironmentProfile[]>([])
/** P3-5：用户标记跳过的用例 ID 集合（执行中标记，重跑时传入 runner 过滤）。 */
const skippedCaseIds = ref<Set<string>>(new Set())
const activeEnvironmentId = ref('')
const aiConfig = ref<AiConfig | null>(null)
const aiEditing = ref<AiConfig>({ providers: {} })
const aiNewProviderId = ref('')
const aiNewModelId = ref('')
const aiSaved = ref(false)
const aiError = ref('')
const settingsSection = ref<'environment' | 'api' | 'ui' | 'coverage' | 'knowledge' | 'ai' | 'data'>('environment')
const view = ref<View>('home')
const showQuickReflect = ref(false)  // P4-1-a：写场景直跑面板展开/折叠
const showAiForm = ref(false)        // P4-1-a：AI 测试表单展开/折叠（有项目时默认 false）
const regeneratePlanIntent = ref(false)

// ===== 质量看板状态（PRD 功能二片3） =====
const dashboardPoints = ref<DashboardWeeklyPoint[]>([])
const dashboardLoading = ref(false)
const dashboardRange = ref<'week' | 'month'>('week')
const dashboardDrillLevel = ref<'system' | 'module' | 'case'>('system')
const dashboardDrillDim = ref<string>('passRate')
const dashboardDrillLayer = ref<string>('')
const dashboardAnomalies = ref<DashboardAnomalyAlert[]>([])

let detectTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeRoots: (() => void) | undefined
let unsubscribeLocal: (() => void) | undefined
let unsubscribeMenuNav: (() => void) | undefined
let unsubscribeMenuCommand: (() => void) | undefined

/** 右栏完整模式：执行 view 展开角色列表 + escalation 答复；非执行 view 仅显示精简版（调度器 + escalation 徽标）。 */
const showRoleSidebarFull = computed(() => view.value === 'run' || view.value === 'fix' || view.value === 'diagnosis')
/** 最近 20 条调度消息（防过长，最新在底部）。 */
const recentDispatchMessages = computed(() => dispatchMessages.value.slice(-20))

/** 推调度消息 + 限长（防无限增长，同 bug #11 history 上限模式） */
function pushDispatch(msg: DispatchMessage): void {
  dispatchMessages.value.push(msg)
  if (dispatchMessages.value.length > 100) dispatchMessages.value.shift()
}
/** 当前同时 running 的角色集合（多 worker 并行可视化，切片 2 并行才真正多 running）。 */
const runningWorkers = computed(() => Object.values(roleStates.value).filter((r) => r.status === 'running'))
/** selectedRole=null 显示全部（同今），选中角色则按 role 过滤轮次。 */
const filteredAgentTurns = computed(() => selectedRole.value ? agentTurns.value.filter((t) => t.role === selectedRole.value) : agentTurns.value)
/** 同一 worker 的多轮模型交互合并为一条目标工作记录，避免把内部 turn 误解为重复执行。 */
const agentWorkRecords = computed<AgentWorkRecord[]>(() => {
  const groups = new Map<string, AgentTurn[]>()
  for (const turn of filteredAgentTurns.value) {
    const key = turn.role ?? 'agent'
    const turns = groups.get(key) ?? []
    turns.push(turn)
    groups.set(key, turns)
  }
  return [...groups.values()].map((turns) => {
    const role = turns[0]?.role
    const allToolCalls = turns.flatMap((turn) => turn.toolCalls)
    return {
    role,
    status: turns.some((turn) => turn.status === 'running')
      ? 'running'
      : turns.some((turn) => turn.status === 'error') ? 'error' : 'done',
    thinkingText: turns.map((turn) => turn.thinkingText.trim()).filter(Boolean).join('\n\n'),
    toolCalls: role === 'result-reviewer' ? allToolCalls.filter(call => call.toolName !== 'read') : allToolCalls,
    readCount: allToolCalls.filter(call => call.toolName === 'read').length,
  }})
})
const filteredAgentLogLines = computed(() => selectedRole.value ? agentLogLines.value.filter((l) => l.role === selectedRole.value) : agentLogLines.value)
/** P4-6 合并：业务事件 + 工具调用按时间序合并展示。业务事件不按角色过滤（任务级），工具行按 selectedRole 过滤。 */
const unifiedLogLines = computed(() => {
  const business: UnifiedLogLine[] = localLogs.value.map((l) => ({
    id: l.id,
    time: l.time,
    level: l.level,
    text: l.message,
    eventAt: new Date(`1970-01-01T${l.time}`).getTime(),
  }))
  const tools: UnifiedLogLine[] = filteredAgentLogLines.value.map((l) => {
    const level: UnifiedLogLine['level'] = l.status === 'error' ? 'error' : l.status === 'running' ? 'info' : 'success'
    const role = l.role ? displayRoleName(l.role) : ''
    const result = l.resultSummary ? `（${l.resultSummary}）` : ''
    return {
      id: l.id,
      time: l.time,
      level,
      text: `${role ? role + ' ' : ''}${l.summary}${result}`,
      role: l.role,
      eventAt: l.eventAt,
    }
  })
  return [...business, ...tools].sort((a, b) => a.eventAt - b.eventAt || a.id.localeCompare(b.id))
})
const lanes = computed(() => snapshot.value?.lanes ?? emptyLanes(form.testTypes))
const taskActive = computed(() => snapshot.value?.status === 'queued' || snapshot.value?.status === 'planning' || snapshot.value?.status === 'running')
const taskStatusSummary = computed(() => {
  if (snapshot.value?.status === 'cancelled') return '任务已中断'
  if (snapshot.value?.status === 'failed') return '任务执行失败'
  if (testExecutionSummary.value) return testExecutionSummary.value.failed > 0 ? '测试命令已结束，正在处理失败结果' : '测试命令已结束，正在生成报告'
  return coordinatorStatus.value || (taskActive.value ? '正在准备任务' : '等待开始')
})
function summarizeFailureReason(raw: string): string {
  const text = raw.replace(/^任务失败：\s*/, '').trim()
  const lifecycle = text.match(/Unknown lifecycle phase ["']([^"']+)["']/i)
  if (lifecycle) return `Maven 编译命令配置错误：不存在生命周期阶段“${lifecycle[1]}”。请修正为有效的 Maven goal 后重试；完整输出保留在技术日志中。`
  if (text.startsWith('本轮生成成功，但项目已有测试编译失败')) return text
  if (text.startsWith('项目已有测试代码编译失败')) return text.replace(/^项目已有测试代码编译失败/, '本轮生成成功，但项目已有测试编译失败')
  const compilationLines = text.split(/\r?\n/).map(line => line.trim()).filter(line => /\[ERROR\].*(?:\.java|symbol:|location:)/i.test(line))
  if (compilationLines.length) return `生成的测试代码编译失败：${compilationLines.slice(0, 3).join('；')}。完整输出保留在技术日志中。`
  if (text.length > 700) return `${text.slice(0, 700)}…（完整输出见技术日志）`
  return text
}
const terminalFailureReason = computed(() => {
  if (snapshot.value?.status !== 'failed' && snapshot.value?.status !== 'cancelled') return ''
  if (error.value.trim()) return summarizeFailureReason(error.value)
  const latest = [...localLogs.value].reverse().find(item => item.level === 'error')
  return latest?.message ? summarizeFailureReason(latest.message) : (snapshot.value.status === 'cancelled' ? '任务已被中断。' : '任务未返回可识别的失败原因。')
})
const taskStatusDetail = computed(() => {
  if (snapshot.value?.status === 'cancelled' || snapshot.value?.status === 'failed') return terminalFailureReason.value || '本次运行未完成；可从当前阶段重新开始。'
  if (testExecutionSummary.value) return `已完成测试命令：${testExecutionSummary.value.passed} 通过、${testExecutionSummary.value.failed} 失败。${taskActive.value ? '后台仍在处理诊断或报告。' : '任务处理已结束。'}`
  if (taskActive.value) return agentRunning.value ? '正在调用模型或工具；具体过程可在下方技术日志中查看。' : '正在等待下一阶段事件。'
  return '任务尚未开始。'
})
function isHttpUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol) } catch { return false }
}
const targetConfigurationError = computed(() => {
  if (form.testTypes.includes('api')) {
    if (!form.apiBaseUrl?.trim()) return '接口测试需要填写 API 基础地址。'
    if (!isHttpUrl(form.apiBaseUrl)) return 'API 基础地址必须是有效的 HTTP 或 HTTPS URL。'
  }
  if (form.testTypes.includes('ui') && form.uiEntryUrl?.trim() && !isHttpUrl(form.uiEntryUrl)) return 'UI 入口地址必须是有效的 HTTP 或 HTTPS URL。'
  if (form.openApiUrl?.trim() && !isHttpUrl(form.openApiUrl) && !/^[a-zA-Z]:[\\/]/.test(form.openApiUrl.trim())) return 'OpenAPI 地址必须是 HTTP(S) URL 或绝对文件路径。'
  return ''
})
const canStart = computed(() => Boolean(localStatus.value.running && form.projectPath && form.systemName && form.testTypes.length && !projectSupportError.value && !targetConfigurationError.value && !starting.value && !taskActive.value && !planPending.value))
const startBlockReason = computed(() => {
  if (!localStatus.value.running) return '本机 Host 未就绪，暂时不能生成计划。'
  if (!form.projectPath) return '请先选择项目目录。'
  if (!form.systemName) return '请填写或识别系统名称。'
  if (!form.testTypes.length) return '请至少选择一种测试类型。'
  if (projectSupportError.value) return projectSupportError.value
  if (targetConfigurationError.value) return targetConfigurationError.value
  return ''
})
const hasEnvironmentDraft = computed(() => Boolean(
  form.apiBaseUrl?.trim() || form.openApiUrl?.trim() || form.uiEntryUrl?.trim() ||
  apiHeaderEntries.value.some(entry => entry.key.trim() || entry.value.trim()) ||
  envEntries.value.some(entry => entry.key.trim() || entry.value.trim())
))
const report = computed(() => snapshot.value?.report)
const hasTestResults = computed(() => Boolean(report.value && report.value.passed + report.value.failed > 0))
const reportCaseEvidence = computed(() => evidenceByCaseId(report.value?.caseResults ?? []))
const verifiedPlanCaseCount = computed(() => (report.value?.cases ?? []).filter(item => reportCaseEvidence.value.has(item.id)).length)
const plannedReportCaseCount = computed(() => report.value?.cases?.length ?? 0)
const executedToolTestCount = computed(() => (report.value?.passed ?? 0) + (report.value?.failed ?? 0))
const reportCasePage = ref(1)
const reportCasePageSize = 10
const reportCasePageCount = computed(() => Math.max(1, Math.ceil((report.value?.cases?.length ?? 0) / reportCasePageSize)))
const visibleReportCases = computed(() => (report.value?.cases ?? []).slice((reportCasePage.value - 1) * reportCasePageSize, reportCasePage.value * reportCasePageSize))
watch(reportCasePageCount, count => { if (reportCasePage.value > count) reportCasePage.value = count })
watch(() => report.value?.cases, () => { reportCasePage.value = 1 })
const journeySteps = computed(() => taskJourney({
  hasTask: Boolean(localTaskId.value || snapshot.value?.taskId),
  phase: currentPhase.value,
  taskActive: taskActive.value,
  planPending: planPending.value,
  executionConfirmed: executionConfirmed.value,
  requiresGeneration: form.testStrategy !== 'reflect' && form.testTypes.every(type => type === 'unit' || type === 'regression'),
  hasScoutReport: Boolean(completedScoutReport.value),
  plannedCaseCount: plannedCases.value.length || completedPlannedCases.value.length,
  executionResult: testExecutionSummary.value && testExecutionSummary.value.passed + testExecutionSummary.value.failed > 0
    ? testExecutionSummary.value
    : report.value && report.value.passed + report.value.failed > 0
      ? { passed: report.value.passed, failed: report.value.failed }
      : null,
  hasReport: Boolean(report.value),
  terminalStatus: snapshot.value?.status === 'failed' || snapshot.value?.status === 'cancelled' ? snapshot.value.status : null,
}))
const durationText = computed(() => report.value?.durationMs !== undefined ? `${Math.round(report.value.durationMs / 1000)}s` : '--')
const effectivePercent = computed(() => report.value?.metrics?.effectiveRate == null
  ? null
  : Math.round(report.value.metrics.effectiveRate * 100))
const qualityScore = computed(() => {
  const coverage = report.value?.coverage
  if (coverage === null || coverage === undefined || effectivePercent.value === null) return null
  return Math.round((coverage + effectivePercent.value) / 2)
})
const compactReportTimeline = computed(() => {
  const groups: Array<TimelineRecord & { count: number }> = []
  const indexes = new Map<string, number>()
  for (const item of report.value?.timeline ?? []) {
    // escalation 已在上方“汇总”展示完整问题和处理结果，时间线不重复。
    if (item.stage === 'escalate' || item.stage === '人工确认') continue
    const normalized = { ...item, stage: timelineStageLabel(item.stage), message: timelineMessage(item.message) }
    const key = `${normalized.stage}\u0000${normalized.status}`
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, groups.length)
      groups.push({ ...normalized, count: 1 })
      continue
    }
    const existing = groups[existingIndex]
    existing.count += 1
    existing.durationMs = (existing.durationMs ?? 0) + (normalized.durationMs ?? 0)
    if (!existing.message && normalized.message) existing.message = normalized.message
  }
  return groups
})
function timelineStageLabel(stage: string): string {
  if (stage === '分析源码' || stage === '读源码' || stage === 'read') return '读取源码'
  if (stage === '写测试代码' || stage === 'write') return '生成测试代码'
  if (stage === '修复测试' || stage === 'edit') return '调整测试代码'
  if (stage === '执行测试') return '执行测试'
  return stage
}
function timelineStatusLabel(status: TimelineRecord['status']): string {
  return status === 'passed' ? '已完成' : status === 'running' ? '进行中' : status === 'pending' ? '等待中' : '失败'
}
function timelineMessage(message?: string): string {
  if (!message || /undefined\/undefined/.test(message)) return ''
  return message
}
function timelineStageDescription(stage: string): string {
  if (stage === '读取源码') return '识别项目结构、依赖与待测代码'
  if (stage === '生成测试代码') return '生成或更新本次测试所需代码'
  if (stage === '调整测试代码') return '根据编译或执行反馈修正测试'
  if (stage === '执行测试') return '运行测试命令并收集可核验证据'
  return '完成该阶段的自动化处理'
}
const hasReportMetrics = computed(() => report.value?.coverage != null || report.value?.branchCoverage != null || effectivePercent.value !== null)
const meaningfulLanes = computed(() => lanes.value.filter(lane => {
  const count = lane.summary.match(/(\d+)\s*\/\s*(\d+)/)
  if (count) return Number(count[2]) > 0
  return lane.status === 'passed' && Boolean(lane.summary.trim())
}))
const reportDataUnavailable = computed(() => !hasReportMetrics.value && meaningfulLanes.value.length === 0)
function laneStatusLabel(status: string): string {
  return status === 'passed' ? '已通过' : status === 'failed' ? '失败' : status === 'running' ? '执行中' : status === 'skipped' ? '已跳过' : '等待中'
}
function timelineDurationText(durationMs?: number): string {
  if (!durationMs) return ''
  return durationMs < 1000 ? '<1s' : `${Math.round(durationMs / 1000)}s`
}
const overview = computed(() => report.value ?? history.value[0]?.snapshot.report)
const overviewQuality = computed(() => {
  const item = overview.value
  if (!item) return '--'
  const coverage = item.coverage === null || item.coverage === undefined ? 0 : item.coverage
  const effective = Math.round((item.metrics?.effectiveRate ?? 0) * 100)
  return Math.round((coverage + effective) / 2)
})
const coverageTrend = computed(() => [...history.value]
  .reverse()
  .filter((item) => item.snapshot.report?.coverage !== null && item.snapshot.report?.coverage !== undefined)
  .slice(-10)
  .map((item) => ({
    label: new Date(item.savedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
    coverage: item.snapshot.report?.coverage as number
  }))
)

// ===== 质量看板 computed（PRD 功能二片3） =====
const dashboardPassRateTrend = computed(() =>
  dashboardPoints.value.map((p) => ({ label: p.weekStart.slice(5, 10), value: Math.round(p.dimensions.passRate * 100) }))
)
const dashboardFlakyRateTrend = computed(() =>
  dashboardPoints.value.map((p) => ({ label: p.weekStart.slice(5, 10), value: Math.round(p.dimensions.flakyRate * 100) }))
)
const dashboardDurationTrend = computed(() =>
  dashboardPoints.value.map((p) => ({ label: p.weekStart.slice(5, 10), value: p.dimensions.avgDurationMs !== null ? Math.round(p.dimensions.avgDurationMs / 1000) : null }))
)
const dashboardTokenTrend = computed(() =>
  dashboardPoints.value.map((p) => ({ label: p.weekStart.slice(5, 10), value: p.dimensions.tokenCost }))
)
const dashboardFailCategoryTrend = computed(() =>
  dashboardPoints.value.map((p) => ({
    label: p.weekStart.slice(5, 10),
    'real-bug': Math.round((p.dimensions.failCategoryRatio['real-bug'] ?? 0) * 100),
    'test-defect': Math.round((p.dimensions.failCategoryRatio['test-defect'] ?? 0) * 100),
    environment: Math.round((p.dimensions.failCategoryRatio.environment ?? 0) * 100),
    flaky: Math.round((p.dimensions.failCategoryRatio.flaky ?? 0) * 100),
  }))
)
// 下钻：模块级数据（按 layer 分组，从 history 按任务分组，用例 title 跨任务去重）
const dashboardModuleBreakdown = computed(() => {
  if (dashboardDrillLevel.value !== 'module') return []
  const layerData: Record<string, {
    titles: Set<string>
    failed: number
    flaky: number
  }> = {}
  for (const item of history.value) {
    const r = item.snapshot.report
    if (!r) continue
    const cases = r.cases ?? []
    for (const c of cases) {
      const tc = c as TestCaseRecord
      const layer = tc.layer ?? 'unknown'
      if (!layerData[layer]) layerData[layer] = { titles: new Set(), failed: 0, flaky: 0 }
      layerData[layer].titles.add(tc.title)
    }
    if (r.failedCases) {
      for (const fc of r.failedCases) {
        const layer = fc.layer ?? 'unknown'
        if (!layerData[layer]) layerData[layer] = { titles: new Set(), failed: 0, flaky: 0 }
        layerData[layer].failed++
        if (fc.category === 'flaky') layerData[layer].flaky++
      }
    }
    if (cases.length === 0 && r.routing) {
      for (const route of r.routing) {
        if (!layerData[route.layer]) layerData[route.layer] = { titles: new Set(), failed: 0, flaky: 0 }
        layerData[route.layer].titles.add(`route:${route.layer}:${route.caseId}`)
      }
    }
  }
  return Object.entries(layerData).map(([layer, d]) => {
    const total = d.titles.size
    const passRate = total > 0 ? Math.round(((total - d.failed) / total) * 100) : 0
    const flakyRate = total > 0 ? Math.round((d.flaky / total) * 100) : 0
    return { layer, passRate, flakyRate, total }
  })
})
// 模块级维度标签
const dashboardDimLabel = computed(() => {
  switch (dashboardDrillDim.value) {
    case 'passRate': return '通过率'
    case 'flakyRate': return 'Flaky 率'
    case 'failCategory': return '失败分类占比'
    case 'avgDuration': return '平均执行时长'
    case 'tokenCost': return 'Token 成本'
    default: return dashboardDrillDim.value
  }
})
/** 模块级卡片展示值（根据 dashboardDrillDim 切换维度，不可算维度降级为通过率）。 */
function moduleDisplayValue(m: { passRate: number; flakyRate: number }): string {
  switch (dashboardDrillDim.value) {
    case 'flakyRate': return `${m.flakyRate}%`
    default: return `${m.passRate}%`
  }
}
/** 模块级卡片颜色类。 */
function moduleNumClass(m: { passRate: number; flakyRate: number }): string {
  switch (dashboardDrillDim.value) {
    case 'flakyRate': return m.flakyRate > 10 ? 'red' : m.flakyRate > 0 ? '' : 'green'
    default: return m.passRate >= 80 ? 'green' : m.passRate < 60 ? 'red' : ''
  }
}
// 下钻：用例级数据（按 layer 筛选后的用例列表）
const dashboardCaseBreakdown = computed(() => {
  if (dashboardDrillLevel.value !== 'case') return []
  const cases: Array<{ title: string; layer: string; target?: string }> = []
  for (const item of history.value) {
    const r = item.snapshot.report
    if (!r?.cases) continue
    for (const c of r.cases) {
      const tc = c as TestCaseRecord
      const layer = tc.layer ?? 'unknown'
      if (dashboardDrillLayer.value && layer !== dashboardDrillLayer.value) continue
      cases.push({ title: tc.title, layer, ...(tc.target ? { target: tc.target } : {}) })
    }
  }
  // 去重
  const seen = new Set<string>()
  return cases.filter((c) => {
    if (seen.has(c.title)) return false
    seen.add(c.title)
    return true
  })
})
const artifactItems = computed(() => (snapshot.value?.artifacts ?? []).map((artifact) => {
  const normalized = artifact.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return { name: parts[parts.length - 1] ?? artifact, path: normalized }
}))
const prComment = computed(() => {
  const r = report.value
  if (!r) return ''
  const coverage = r.coverage === null || r.coverage === undefined ? 'N/A' : `${r.coverage}%`
  const branch = r.branchCoverage === null || r.branchCoverage === undefined ? '' : `，分支覆盖率 ${r.branchCoverage}%`
  const lines = [
    '## CIMDEV 测试结果',
    `- 通过 ${r.passed} / 失败 ${r.failed}，覆盖率 ${coverage}${branch}`,
    `- 质量门禁：${r.gate?.passed ? '通过' : '未通过'}`,
    r.summary ? `- 结论：${r.summary}` : ''
  ].filter(Boolean)
  if (r.riskPoints?.length) {
    lines.push('- 风险点：')
    for (const risk of r.riskPoints) {
      lines.push(`  - [${risk.severity}] ${risk.file}：${risk.message}${risk.suggestion ? ` 建议：${risk.suggestion}` : ''}`)
    }
  } else {
    lines.push('- 风险点：无')
  }
  return lines.join('\n')
})

function displayError(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? '')
  if (/could not be cloned|could not clone/i.test(message)) {
    return '页面数据无法传递到本机进程。请重试；如果仍然出现，请重新打开当前页面。'
  }
  return message || fallback
}

/** 切换项目时清除上一个项目的运行态，避免计划、报告和勾选范围串项目。 */
function clearProjectTransientState(): void {
  snapshot.value = null
  localLogs.value = []
  localTaskId.value = ''
  plannedCases.value = []
  completedPlannedCases.value = []
  completedScoutReport.value = ''
  selectedPlanCaseIds.value = []
  skippedCaseIds.value = new Set()
  planPending.value = false
  executionConfirmed.value = false
  currentPhase.value = ''
  testExecutionSummary.value = null
  planImpactPreview.value = null
  planImpactError.value = ''
  error.value = ''
}

async function selectProject(): Promise<void> {
  error.value = ''
  try {
    const selection = await window.testAgent.selectProject()
    if (!selection) return
    clearProjectTransientState()
    form.projectPath = selection.path
    form.systemName = selection.detectedSystem
    form.version = selection.detectedVersion
    if (selection.detectedTestTypes?.length) form.testTypes = [...selection.detectedTestTypes]
    form.requiredCapabilities = selection.requiredCapabilities ? [...selection.requiredCapabilities] : undefined
    projectSupportError.value = selection.supported === false ? (selection.unsupportedReason ?? '当前项目类型暂不支持。') : ''
    if (projectSupportError.value) error.value = projectSupportError.value
    // 与 selectProjectFromNav 一致：切项目后加载套件树/套件列表/场景文件
    await loadSuiteTree()
    void loadSuites()
    void loadScenarioFiles()
  } catch (reason) {
    error.value = displayError(reason, '目录选择失败')
  }
}

async function detectProject(path: string): Promise<void> {
  if (!path.trim()) return
  error.value = ''
  try {
    const selection = await window.testAgent.detectProject(path)
    if (!selection) return
    form.systemName = selection.detectedSystem
    form.version = selection.detectedVersion
    if (selection.detectedTestTypes?.length) form.testTypes = [...selection.detectedTestTypes]
    form.requiredCapabilities = selection.requiredCapabilities ? [...selection.requiredCapabilities] : undefined
    projectSupportError.value = selection.supported === false ? (selection.unsupportedReason ?? '当前项目类型暂不支持。') : ''
    if (projectSupportError.value) error.value = projectSupportError.value
  } catch (reason) {
    error.value = displayError(reason, '目录识别失败')
  }
}

function toggleTestType(type: TestType): void {
  if (form.testTypes.includes(type)) form.testTypes = form.testTypes.filter((item) => item !== type)
  else form.testTypes = [...form.testTypes, type]
}

watch(() => form.projectPath, (path, previousPath) => {
  if (path.trim() && !previousPath?.trim()) showAiForm.value = true
  if (path.trim()) {
    try { localStorage.setItem('test-agent-last-project-path', path.trim()) } catch { /* storage unavailable */ }
    void window.testAgent.authorizeProjectArtifacts(path.trim())
  }
  if (detectTimer) clearTimeout(detectTimer)
  detectTimer = setTimeout(() => { void detectProject(path) }, 350)
  activeEnvironmentId.value = ''
  void loadEnvironments()
})

function go(next: View): void {
  if (next === 'plan' && !planAvailable.value) {
    view.value = 'home'
    return
  }
  view.value = next
  if (next === 'scenarios') void loadScenarioFiles()
}

function openSettingsSection(section: 'environment' | 'api' | 'ui' | 'coverage' | 'knowledge' | 'ai' | 'data'): void {
  settingsSection.value = section
  go('settings')
}

// ===== 质量看板函数（PRD 功能二片3） =====

/** 突变检测纯函数（前端版，不依赖 metrics.ts，从周点数据直接算）。 */
function computeAnomalies(points: DashboardWeeklyPoint[]): DashboardAnomalyAlert[] {
  const flakyPP = Number(import.meta.env?.VITE_ANOMALY_FLAKY_PP ?? 10)
  const passPP = Number(import.meta.env?.VITE_ANOMALY_PASSRATE_PP ?? 10)
  const alerts: DashboardAnomalyAlert[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const flakyDelta = (curr.dimensions.flakyRate - prev.dimensions.flakyRate) * 100
    if (flakyDelta > flakyPP) {
      alerts.push({
        dimension: 'flakyRate',
        from: prev.dimensions.flakyRate,
        to: curr.dimensions.flakyRate,
        weekStart: curr.weekStart,
        message: `Flaky 率从 ${Math.round(prev.dimensions.flakyRate * 100)}% 升至 ${Math.round(curr.dimensions.flakyRate * 100)}%（+${Math.round(flakyDelta)}pp）`,
      })
    }
    const passDelta = (prev.dimensions.passRate - curr.dimensions.passRate) * 100
    if (passDelta > passPP) {
      alerts.push({
        dimension: 'passRate',
        from: prev.dimensions.passRate,
        to: curr.dimensions.passRate,
        weekStart: curr.weekStart,
        message: `通过率从 ${Math.round(prev.dimensions.passRate * 100)}% 降至 ${Math.round(curr.dimensions.passRate * 100)}%（-${Math.round(passDelta)}pp）`,
      })
    }
  }
  return alerts
}

async function loadDashboard(): Promise<void> {
  if (!form.projectPath) return
  dashboardLoading.value = true
  try {
    const range = dashboardRange.value === 'month'
      ? { start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), end: new Date().toISOString() }
      : { start: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), end: new Date().toISOString() }
    const points = await window.testAgent.getMetrics(form.projectPath, range) as DashboardWeeklyPoint[]
    dashboardPoints.value = points ?? []
    dashboardAnomalies.value = computeAnomalies(dashboardPoints.value)
  } catch {
    dashboardPoints.value = []
    dashboardAnomalies.value = []
  } finally {
    dashboardLoading.value = false
  }
}

function openDashboard(): void {
  go('dashboard')
  void loadDashboard()
}

function drillToModule(dim: string): void {
  dashboardDrillDim.value = dim
  dashboardDrillLevel.value = 'module'
}

function drillToCase(layer: string): void {
  dashboardDrillLayer.value = layer
  dashboardDrillLevel.value = 'case'
}

function drillReset(): void {
  dashboardDrillLevel.value = 'system'
  dashboardDrillLayer.value = ''
}

function switchDashboardRange(r: 'week' | 'month'): void {
  dashboardRange.value = r
  void loadDashboard()
}

function pushLocalLog(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  lastActivityAt.value = Date.now()
  localLogs.value.push({ id: `${Date.now()}-${localLogs.value.length}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message })
  if (localLogs.value.length > 300) localLogs.value.splice(0, localLogs.value.length - 300)
}

interface LocalRunOutcome {
  // AgentRunResult 字段（runner 返回）：artifacts/cases 在顶层
  artifacts?: string[]
  cases?: unknown[]
  report?: {
    provenance?: NonNullable<TaskSnapshot['report']>['provenance']
    passed?: number
    failed?: number
    coverage?: number | null
    branchCoverage?: number | null
    coverageEvidence?: NonNullable<TaskSnapshot['report']>['coverageEvidence']
    caseResults?: NonNullable<TaskSnapshot['report']>['caseResults']
    escalations?: NonNullable<TaskSnapshot['report']>['escalations']
    failedCases?: NonNullable<TaskSnapshot['report']>['failedCases']
    riskPoints?: NonNullable<TaskSnapshot['report']>['riskPoints']
    fixes?: NonNullable<TaskSnapshot['report']>['fixes']
    fixActions?: NonNullable<TaskSnapshot['report']>['fixActions']
    readOnlyViolation?: NonNullable<TaskSnapshot['report']>['readOnlyViolation']
    qualityGate?: { status: 'passed' | 'failed'; passed: number; failed: number; flakyIsolated: number; flakyFailed: number; summary: string; coverageTarget?: number; coverage?: number | null; blockingReasons?: string[] }
    flakyCases?: unknown
    incrementalCoverage?: unknown
    fitness?: {
      iterations: number
      k: number
      converged: boolean
      stoppedReason: 'converged' | 'no-improvement' | 'max-iterations' | 'no-failures'
      message: string
      curve: Array<{ iter: number; passed: number; failed: number; coverage: number | null; passRate: number; passRateDelta: number; coverageDelta: number; improvement: boolean }>
      tokenCost?: { input: number; output: number; total: number } | null
    }
  }
  lanes?: Array<{ type: TestType; status: 'passed' | 'failed'; summary: string }>
  // 外部 CLI adapter 返回的额外字段（cimicode 等，阶段2整理后会统一）
  adapterResult?: { artifacts?: string[]; cases?: unknown[] }
  // 旧 report 字段（外部 CLI adapter 路径可能填充，保留兼容）
  fullReport?: {
    provenance?: NonNullable<TaskSnapshot['report']>['provenance']
    passed?: number
    failed?: number
    coverage?: number | null
    branchCoverage?: number | null
    coverageEvidence?: NonNullable<TaskSnapshot['report']>['coverageEvidence']
    durationMs?: number
    summary?: string
    cases?: { count: number; byLayer: Record<string, number>; byPriority: Record<string, number> }
    routing?: RoutingRecord[]
    failedCases?: FailedCaseRecord[]
    uiSteps?: NonNullable<TaskSnapshot['report']>['uiSteps']
    timeline?: NonNullable<TaskSnapshot['report']>['timeline']
    recording?: NonNullable<TaskSnapshot['report']>['recording']
    riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
    fixes?: NonNullable<TaskSnapshot['report']>['fixes']
    screenshots?: string[]
    metrics?: NonNullable<TaskSnapshot['report']>['metrics']
    gate?: { passed?: boolean; coverageTarget?: number; coverage?: number | null; effectiveRate?: number; reason?: string; blockingReasons?: string[] }
    api?: NonNullable<TaskSnapshot['report']>['api']
    knowledge?: NonNullable<TaskSnapshot['report']>['knowledge']
    fixActions?: NonNullable<TaskSnapshot['report']>['fixActions']
    readOnlyViolation?: NonNullable<TaskSnapshot['report']>['readOnlyViolation']
    escalations?: NonNullable<TaskSnapshot['report']>['escalations']
  }
}

function mapCases(value: unknown[]): TestCaseRecord[] {
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const priority = (item.priority === 'low' || item.priority === 'medium' || item.priority === 'high' ? item.priority : 'medium') as 'low' | 'medium' | 'high'
      const layer = (item.layer === 'api' || item.layer === 'ui' || item.layer === 'unit' ? item.layer : undefined) as 'api' | 'ui' | 'unit' | undefined
      return {
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        scenario: String(item.scenario ?? ''),
        steps: Array.isArray(item.steps) ? item.steps.map((step) => String(step)) : [],
        expected: String(item.expected ?? ''),
        priority,
        ...(layer ? { layer } : {}),
        ...(typeof item.source === 'string' ? { source: item.source } : {}),
        ...(typeof item.target === 'string' ? { target: item.target } : {}),
        ...(typeof item.assertions === 'number' ? { assertions: item.assertions } : {}),
        ...(typeof item.coverageDelta === 'string' ? { coverageDelta: item.coverageDelta } : {}),
        ...(item.structuredScenario && typeof item.structuredScenario === 'object' ? { structuredScenario: item.structuredScenario } : {})
      }
    })
}

/** 从 cases 数组计算元数据摘要（count/byLayer/byPriority），供 GUI 展示。 */
function computeCasesMeta(cases: unknown[] | undefined): { count: number; byLayer: Record<string, number>; byPriority: Record<string, number> } | undefined {
  if (!cases || !Array.isArray(cases) || cases.length === 0) return undefined
  const byLayer: Record<string, number> = {}
  const byPriority: Record<string, number> = {}
  for (const item of cases) {
    if (typeof item !== 'object' || item === null) continue
    const layer = (item as Record<string, unknown>).layer
    const priority = (item as Record<string, unknown>).priority
    if (typeof layer === 'string') byLayer[layer] = (byLayer[layer] ?? 0) + 1
    if (typeof priority === 'string') byPriority[priority] = (byPriority[priority] ?? 0) + 1
  }
  return { count: cases.length, byLayer, byPriority }
}

function applyRunResult(message: RunResultMessage): void {
  const outcome = message.outcome as LocalRunOutcome
  // runner 路径：report = { passed, failed, coverage }，artifacts/cases 在顶层
  // 外部 CLI 路径：fullReport 有完整字段，artifacts/cases 在 adapterResult
  const runReport = outcome.report ?? outcome.fullReport
  const metrics = outcome.fullReport?.metrics
  const qualityGate = outcome.report?.qualityGate
  const gate = qualityGate
    ? mapCoreQualityGate(qualityGate, outcome.report?.coverage ?? null, form.coverageTarget ?? 0, metrics?.effectiveRate ?? 0)
    : outcome.fullReport?.gate
  const report: TaskSnapshot['report'] | undefined = runReport
    ? {
        provenance: outcome.report?.provenance ?? outcome.fullReport?.provenance,
        passed: runReport.passed ?? 0,
        failed: runReport.failed ?? 0,
        coverage: runReport.coverage ?? null,
        branchCoverage: outcome.report?.branchCoverage ?? outcome.fullReport?.branchCoverage,
        coverageEvidence: outcome.report?.coverageEvidence ?? outcome.fullReport?.coverageEvidence,
        durationMs: outcome.fullReport?.durationMs ?? ((outcome.fullReport?.timeline ?? []).reduce((sum, t) => sum + (t.durationMs ?? 0), 0) || undefined),
        summary: outcome.fullReport?.summary,
        cases: mapCases(outcome.cases ?? outcome.adapterResult?.cases ?? []),
        caseResults: outcome.report?.caseResults ?? [],
        casesMeta: outcome.fullReport?.cases ?? computeCasesMeta(outcome.cases ?? outcome.adapterResult?.cases ?? []),
        routing: outcome.fullReport?.routing,
        failedCases: outcome.report?.failedCases ?? outcome.fullReport?.failedCases ?? [],
        uiSteps: outcome.fullReport?.uiSteps ?? [],
        timeline: outcome.fullReport?.timeline ?? [],
        recording: outcome.fullReport?.recording,
        riskPoints: outcome.report?.riskPoints ?? outcome.fullReport?.riskPoints ?? [],
        fixes: outcome.report?.fixes ?? outcome.fullReport?.fixes ?? [],
        screenshots: outcome.fullReport?.screenshots ?? [],
        fixActions: outcome.report?.fixActions ?? outcome.fullReport?.fixActions ?? [],
        readOnlyViolation: outcome.report?.readOnlyViolation ?? outcome.fullReport?.readOnlyViolation,
        metrics,
        gate: gate ? { coverageTarget: gate.coverageTarget ?? 0, coverage: gate.coverage ?? null, effectiveRate: gate.effectiveRate ?? 0, passed: gate.passed ?? false, reason: gate.reason ?? '', ...(gate.blockingReasons?.length ? { blockingReasons: gate.blockingReasons } : {}) } : undefined,
        api: outcome.fullReport?.api,
        knowledge: outcome.fullReport?.knowledge,
        fitness: outcome.report?.fitness,
        ...(outcome.report?.escalations || outcome.fullReport?.escalations ? { escalations: outcome.report?.escalations ?? outcome.fullReport?.escalations ?? [] } : {})
      }
    : undefined
  snapshot.value = {
    taskId: message.executionId,
    status: gate?.passed === false ? 'needsReview' : 'completed',
    logs: [...localLogs.value],
    lanes: (outcome.lanes ?? []).map((lane) => ({ type: lane.type, status: lane.status, summary: lane.summary })),
    artifacts: outcome.artifacts ?? outcome.adapterResult?.artifacts ?? [],
    report
  }
}

/**
 * 处理 Agent 结构化事件（union type）。
 *
 * 两条渲染路径：
 * - log 事件（外部 CLI adapter）：pushLocalLog，和以前一样
 * - 结构化事件（runner）：填充 agentTurns，在 run view 渲染为工作记录；轮次仅作为内部关联字段
 */
function handleAgentEvent(event: import('@cxmt/protocol').LocalHostAgentEvent): void {
  lastActivityAt.value = Date.now()
  switch (event.type) {
    case 'log':
      pushLocalLog(event.level, event.message)
      break
    case 'agent_start':
      agentRunning.value = true
      // P4-6：不清空 agentTurns/agentLogLines——跨角色保留，展示全程日志流
      // 当前角色启动——只重置当前角色状态（前序角色 done 保留，分阶段流程可视化）
      if (event.role) {
        roleStates.value[event.role] = { name: event.role, status: 'running', turnCount: 0, lastTool: undefined, escalationCount: 0 }
        coordinatorStatus.value = roleWorkingStatus(event.role)
      }
      pushLocalLog('info', 'Agent 启动')
      break
    case 'planning_start':
      planningActive.value = true
      coordinatorStatus.value = '规划中'
      pushLocalLog('info', '正在分析项目，生成测试计划…')
      break
    case 'planning_end':
      planningActive.value = false
      plannedCases.value = mapCases(event.cases ?? [])
      selectedPlanCaseIds.value = []
      planCasePage.value = 1
      // 断点恢复：存 plannedCases + 标记进入 execute 阶段
      completedPlannedCases.value = mapCases(event.cases ?? [])
      currentPhase.value = 'execute'
      coordinatorStatus.value = '规划完成'
      pushLocalLog('success', `测试计划已生成：${event.caseCount} 条用例`)
      // P0 项1：批量拉取持久化 JSON 场景填 structuredScenario（反射用例）
      void hydrateStructuredScenarios(plannedCases.value)
      // P1-1 澄清3：planning_end 后刷新套件树（用例已入库，startTask 返回时太早）
      void loadSuiteTree()
      void loadSuites()
      break
    case 'generation_progress': {
      const next = {
        target: event.target,
        outputPath: event.outputPath,
        status: event.status,
        message: event.message,
      }
      const existingIndex = generationTargets.value.findIndex(item => item.outputPath === event.outputPath)
      if (existingIndex >= 0) generationTargets.value.splice(existingIndex, 1, next)
      else generationTargets.value.push(next)
      coordinatorStatus.value = event.status === 'failed'
        ? `${displayRoleName(event.role)} 生成失败`
        : `正在生成测试代码：${event.completed}/${event.total}`
      break
    }
    case 'test_execution_complete':
      testExecutionSummary.value = { passed: event.passed, failed: event.failed }
      coordinatorStatus.value = event.failed > 0 ? '测试已结束，正在分析失败' : '测试已结束，正在生成报告'
      break
    case 'agent_end':
      agentRunning.value = false
      const endingTurn = [...agentTurns.value].reverse().find(turn => turn.role === event.role && turn.status === 'running')
      if (endingTurn) endingTurn.status = 'done'
      if (event.role) {
        roleStates.value[event.role].status = 'done'
        coordinatorStatus.value = `${displayRoleName(event.role)}完成`
      }
      // 角色完成只保留一条结构化日志，避免与通用“Agent 结束”重复。
      if (event.role) {
        agentLogLines.value.push({
          id: `end-${event.role}-${Date.now()}`,
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          role: event.role,
          turn: 0,
          toolName: '',
          summary: `${displayRoleName(event.role)}完成`,
          status: 'done',
          toolCallId: '',
          eventAt: Date.now(),
        })
      }
      break
    case 'turn_start': {
      agentTurns.value.push({ turn: event.turn, status: 'running', thinkingText: '', toolCalls: [], role: event.role })
      if (event.role) roleStates.value[event.role].turnCount++
      break
    }
    case 'turn_end': {
      const current = [...agentTurns.value].reverse().find(turn => turn.role === event.role && turn.status === 'running')
      if (current) current.status = 'done'
      break
    }
    case 'message_update': {
      // 流式文本增量——追加到当前轮次的 thinkingText
      const current = [...agentTurns.value].reverse().find(turn => turn.role === event.role && turn.status === 'running')
      if (current && event.text) current.thinkingText += event.text
      break
    }
    case 'tool_execution_start': {
      const current = [...agentTurns.value].reverse().find(turn => turn.role === event.role && turn.status === 'running')
      if (current) {
        current.toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'running',
          argsText: formatToolArgs(event.args),
          startedAt: Date.now(),
        })
      }
      // P4-6：push 精简日志行
      agentLogLines.value.push({
        id: event.toolCallId,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        role: event.role,
        turn: current?.turn ?? 0,
        toolName: event.toolName,
        summary: summarizeToolCall(event.toolName, event.args),
        status: 'running',
        toolCallId: event.toolCallId,
        eventAt: Date.now(),
      })
      if (event.role) roleStates.value[event.role].lastTool = event.toolName
      break
    }
    case 'tool_execution_end': {
      const call = agentTurns.value.flatMap(turn => turn.toolCalls).find((c) => c.toolCallId === event.toolCallId)
      if (!call) break
      call.status = event.isError ? 'error' : 'done'
      const result = event.result as { details?: { ok?: boolean; pass?: number; fail?: number; tests?: number; coverage?: number | null } }
      const details = result?.details
      const hasTestDetails = isTestToolDetails(event.toolName, details)
      if (hasTestDetails) {
        call.testDetails = {
          ok: details.ok ?? false,
          pass: details.pass ?? 0,
          fail: details.fail ?? 0,
          tests: details.tests ?? 0,
          coverage: details.coverage ?? null,
        }
        call.resultSummary = `${details.pass ?? 0}/${details.tests ?? 0} 通过${details.fail ? `，${details.fail} 失败` : ''}${details.coverage !== null && details.coverage !== undefined ? `，覆盖率 ${details.coverage}%` : ''}`
      } else if (event.isError) {
        call.resultSummary = toolFailureSummary(event.toolName)
      } else {
        call.resultSummary = '完成'
      }
      const durationMs = call.startedAt ? Math.max(0, Date.now() - call.startedAt) : null
      // P4-6：更新精简日志行
      const logLine = agentLogLines.value.find((l) => l.toolCallId === event.toolCallId)
      if (logLine) {
        logLine.status = event.isError ? 'error' : 'done'
        if (hasTestDetails) {
          logLine.resultSummary = `${details.pass ?? 0}/${details.tests ?? 0} 通过${details.fail ? `，${details.fail} 失败` : ''}`
        } else if (event.isError) {
          logLine.resultSummary = toolFailureSummary(event.toolName)
        } else {
          logLine.resultSummary = `完成${durationMs === null ? '' : `，${durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}`}`
        }
        logLine.eventAt = Date.now()
      }
      break
    }
    case 'escalation': {
      if (event.escalationId) {
        escalationPendings.value.push({
          escalationId: event.escalationId,
          role: event.role ?? '未知角色',
          question: event.question ?? '',
          fallback: event.fallback,
          context: event.context,
          executionId: localTaskId.value,
        })
        pushLocalLog('warning', `${event.role ?? '角色'} 发起 escalation：${event.question ?? ''}`)
      }
      if (event.role) {
        roleStates.value[event.role].status = 'escalating'
        roleStates.value[event.role].escalationCount++
      }
      break
    }
    case 'coordinator-message': {
      coordinatorActive.value = true
      pushDispatch({
        id: `cm-${Date.now()}-${dispatchMessages.value.length}`,
        type: event.messageType,
        from: event.from,
        to: event.to,
        content: event.content,
        timestamp: Date.now(),
      })
      break
    }
    default: {
      break
    }
  }
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  try {
    const obj = args as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => !k.startsWith('_'))
    if (!keys.length) return ''
    return keys.map((k) => {
      const val = typeof obj[k] === 'string' ? (obj[k] as string) : JSON.stringify(obj[k])
      return `${k}: ${truncate(val, 80)}`
    }).join(', ')
  } catch {
    return ''
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function isTestToolDetails(toolName: string, details: { tests?: number } | undefined): details is { ok?: boolean; pass?: number; fail?: number; tests: number; coverage?: number | null } {
  return ['maven_test', 'node_test', 'playwright_test', 'api_test', 'reflect_test'].includes(toolName) && typeof details?.tests === 'number'
}

function toolFailureSummary(toolName: string): string {
  if (toolName === 'read') return '读取失败'
  if (toolName === 'write') return '写入失败'
  if (toolName === 'edit') return '编辑失败'
  return '执行失败'
}

/** P4-6：工具调用的人类可读摘要（用于精简日志流）。 */
function summarizeToolCall(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return toolName
  const obj = args as Record<string, unknown>
  switch (toolName) {
    case 'read':
      return `读取 ${truncate(String(obj.path ?? ''), 60)}`
    case 'bash':
      return `运行 ${truncate(String(obj.command ?? ''), 60)}`
    case 'write':
      return `写入 ${truncate(String(obj.path ?? ''), 60)}`
    case 'edit':
      return `编辑 ${truncate(String(obj.path ?? ''), 60)}`
    case 'maven_test':
      return '运行 maven test'
    case 'node_test':
      return '运行 node test'
    case 'playwright_test':
      return '运行 playwright test'
    case 'api_test':
      return '运行 api test'
    case 'reflect_test': {
      if (obj.scenarioFile) return `反射测试 ${truncate(String(obj.scenarioFile), 60)}`
      if (obj.scenarioDir) return `反射测试 ${truncate(String(obj.scenarioDir), 60)}`
      if (obj.scenarioFiles) return `反射测试 ${String(obj.scenarioFiles).slice(0, 60)}`
      if (obj.scenarios) return `反射测试 ${Array.isArray(obj.scenarios) ? obj.scenarios.length + ' 个场景' : ''}`
      return '反射测试'
    }
    case 'escalate':
      return `escalate: ${truncate(String(obj.question ?? ''), 60)}`
    default:
      return toolName
  }
}

/** thinking 文本里的 JSON 路径反转义（\\ → \）——LLM thinking 时 dump 的 JSON 字符串路径含双反斜杠 */
function unescapeJson(text: string): string {
  return text.replace(/\\\\/g, '\\')
}

function handleLocalMessage(raw: unknown): void {
  const message = raw as HostMessage
  switch (message.kind) {
    case 'handshake':
      localStatus.value = { running: message.ok, protocolVersion: message.protocolVersion, hostVersion: message.hostVersion, capabilities: message.capabilities, error: message.error }
      runtime.value = message.ok
        ? { mode: 'real', provider: 'local-host', message: `本机 Host 在线 v${message.hostVersion ?? '?'}` }
        : { mode: 'unavailable', provider: null, message: `本机 Host 握手失败：${message.error ?? ''}` }
      break
    case 'health':
      break
    case 'run-accepted':
      localTaskId.value = message.executionId
      agentTurns.value = []
      agentLogLines.value = []
      agentRunning.value = false
      coordinatorStatus.value = ''
      coordinatorActive.value = false
      roleStates.value = initRoleStates()
      dispatchMessages.value = []
      snapshot.value = { taskId: message.executionId, status: 'running', logs: [], lanes: emptyLanes(form.testTypes), artifacts: [] }
      pushLocalLog('info', `任务已接受：${message.executionId}`)
      go('run')
      break
    case 'event':
      if (message.executionId !== localTaskId.value) break
      handleAgentEvent(message.event)
      break
    case 'run-result': {
      if (message.executionId !== localTaskId.value) break
      const phase = message.phase
      if (phase === 'scout') {
        // 角色分工架构：scout 侦察完成，存报告，自动继续 case-designer（不停下问）
        const scoutOutcome = message.outcome as { report?: string } | undefined
        const scoutReport = scoutOutcome?.report ?? ''
        if (!scoutReport) {
          // 侦察报告为空——不重派空 scoutReport 任务（host-mode !input.scoutReport 会又跑 scout 死循环），停下报错
          pushLocalLog('error', '侦察报告为空，scout 未产出报告。请检查项目路径/模型配置后重试，或重跑 scout 阶段')
          error.value = '侦察报告为空，scout 未产出报告（可能 LLM 轮次耗尽未输出文本）。请重试'
          agentRunning.value = false
          starting.value = false
          return
        }
        pushLocalLog('success', '项目分析完成，启动用例设计…')
        // 断点恢复：存 scoutReport + 标记进入 design 阶段
        completedScoutReport.value = scoutReport
        currentPhase.value = 'design'
        // 自动发 plan 消息（input 带 scoutReport，触发 case-designer）
        const planInput = { ...form, testTypes: [...form.testTypes], scoutReport }
        starting.value = true
        agentRunning.value = true
        startLocalRun(planInput).then((result) => {
          localTaskId.value = result.taskId
        }).catch((reason) => {
          error.value = reason instanceof Error ? reason.message : '用例设计启动失败'
          agentRunning.value = false
        }).finally(() => {
          starting.value = false
        })
      } else if (phase === 'plan') {
        // 计划阶段完成——显示确认界面，不跳报告
        pushLocalLog('success', '测试计划已生成，等待确认')
        planPending.value = true
        planTaskId.value = message.executionId
        persistCheckpoint()
        go('plan')
      } else if (phase === 'generate') {
        const outcome = message.outcome as { cases?: TestCaseRecord[]; generatedFiles?: string[] } | undefined
        const generatedCases = outcome?.cases?.length ? outcome.cases : executionPlanCases.value
        pushLocalLog('success', `测试代码生成并通过编译门禁，共 ${outcome?.generatedFiles?.length ?? 0} 个文件；开始执行测试…`)
        currentPhase.value = 'execute'
        persistCheckpoint()
        const execInput = {
          ...form,
          testTypes: [...form.testTypes],
          knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
          environment: environmentFromEntries(),
          apiHeaders: apiHeadersFromEntries(),
          uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined,
          cases: JSON.parse(JSON.stringify(generatedCases)),
          fullRun: executionScope.value !== 'incremental',
          testCodeGenerated: true,
        }
        starting.value = true
        agentRunning.value = true
        startLocalRun(execInput).then((result) => {
          localTaskId.value = result.taskId
        }).catch((reason) => {
          error.value = reason instanceof Error ? reason.message : '测试执行启动失败'
          agentRunning.value = false
        }).finally(() => {
          starting.value = false
        })
      } else if (phase === 'diagnosis') {
        // 诊断先行架构：诊断完成，需用户确认是否修复（分层自动的 needs-confirm 路径）
        pushLocalLog('success', `诊断分析完成，等待确认：${message.executionId}`)
        const outcome = message.outcome as { report?: { failedCases?: NonNullable<TaskSnapshot['report']>['failedCases'] }; fixDecision?: { action: string; reason: string } } | undefined
        diagnosisPending.value = {
          failedCases: outcome?.report?.failedCases ?? [],
          fixDecision: outcome?.fixDecision,
        }
        applyRunResult(message)
        planPending.value = false
        go('diagnosis')
      } else if (phase === 'fix') {
        // 修复阶段完成——展示最终报告（含 fixActions）
        pushLocalLog('success', `修复完成：${message.executionId}`)
        planPending.value = false
        planTaskId.value = null
        diagnosisPending.value = null
        escalationPendings.value = []
        applyRunResult(message)
        clearCheckpoint()
        go('report')
        void persistCurrentRun()
        if (libraryRunKind.value === 'agent') libraryRunBusy.value = false
      } else {
        // 执行阶段完成（含 no-fix 情况，或旧 adapter 一次性完成）
        pushLocalLog('success', `任务完成：${message.executionId}`)
        planPending.value = false
        planTaskId.value = null
        diagnosisPending.value = null
        escalationPendings.value = []
        applyRunResult(message)
        clearCheckpoint()
        go('report')
        void persistCurrentRun()
        if (libraryRunKind.value === 'agent') libraryRunBusy.value = false
      }
      break
    }
    case 'run-error':
      if (message.executionId !== localTaskId.value) break
      pushLocalLog('error', `任务失败：${message.error}`)
      error.value = message.error
      agentRunning.value = false
      planningActive.value = false
      starting.value = false
      escalationPendings.value = []
      agentTurns.value.forEach(turn => { if (turn.status === 'running') turn.status = 'error' })
      agentLogLines.value.forEach(line => { if (line.status === 'running') line.status = 'error' })
      snapshot.value = { taskId: message.executionId, status: message.cancelled ? 'cancelled' : 'failed', logs: [...localLogs.value], lanes: snapshot.value?.lanes ?? emptyLanes(form.testTypes), artifacts: snapshot.value?.artifacts ?? [] }
      if (libraryRunKind.value === 'agent') libraryRunBusy.value = false
      if (message.error.includes('增量筛选零命中') && plannedCases.value.length > 0) {
        planPending.value = true
        executionConfirmed.value = false
        error.value = message.error
        persistCheckpoint()
        go('plan')
      }
      break
    case 'cancelled':
      if (message.executionId !== localTaskId.value) break
      pushLocalLog('warning', `任务已取消：${message.executionId}`)
      agentRunning.value = false
      planningActive.value = false
      starting.value = false
      escalationPendings.value = []
      error.value = '任务已由用户中断。'
      agentTurns.value.forEach(turn => { if (turn.status === 'running') turn.status = 'error' })
      agentLogLines.value.forEach(line => { if (line.status === 'running') line.status = 'error' })
      if (snapshot.value) snapshot.value = { ...snapshot.value, status: 'cancelled', logs: [...localLogs.value] }
      if (libraryRunKind.value === 'agent') libraryRunBusy.value = false
      break
    case 'error':
      pushLocalLog('error', message.message)
      break
  }
}

async function refreshRuntime(): Promise<void> {
  try {
    const status = await window.testAgentLocal.getStatus()
    localStatus.value = status
    runtime.value = status.running
      ? { mode: 'real', provider: 'local-host', message: `本机 Host 在线${status.hostVersion ? ` v${status.hostVersion}` : ''}（能力：${(status.capabilities ?? []).join(', ') || '未报告'}）` }
      : { mode: 'unavailable', provider: null, message: `本机 Host 未就绪${status.error ? '：' + status.error : ''}` }
  } catch (reason) {
    localStatus.value = { running: false, error: reason instanceof Error ? reason.message : '本机 Host 检查失败' }
    runtime.value = { mode: 'unavailable', provider: null, message: localStatus.value.error ?? '' }
  }
}

async function startTask(): Promise<void> {
  error.value = ''
  if (!canStart.value) return
  starting.value = true
  localLogs.value = []
  plannedCases.value = []
  selectedPlanCaseIds.value = []
  planCaseQuery.value = ''
  planCaseLayer.value = 'all'
  planCasePriority.value = 'all'
  planCasePage.value = 1
  testExecutionSummary.value = null
  planPending.value = false
  executionConfirmed.value = false
  planTaskId.value = null
  // 断点恢复：新任务从头开始，清 checkpoint
  clearCheckpoint()
  currentPhase.value = 'scout'
  try {
    const result = await startLocalRun({
      ...form,
      testTypes: [...form.testTypes],
      requiredCapabilities: [...new Set([...(form.requiredCapabilities ?? []), ...(form.testTypes.includes('ui') ? ['playwright'] : [])])],
      knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
      environment: environmentFromEntries(),
      apiHeaders: apiHeadersFromEntries(),
      uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined
    })
    localTaskId.value = result.taskId
    go('run')  // P1-0 必处理点6：发起后即时跳执行页（不等 task_started 事件）
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '任务启动失败'
  } finally {
    starting.value = false
  }
}

function requestRegeneratePlan(): void {
  if (!hasRestorablePlan.value || starting.value || taskActive.value) return
  regeneratePlanIntent.value = true
}

async function confirmRegeneratePlan(): Promise<void> {
  regeneratePlanIntent.value = false
  await startTask()
}

async function cancelTask(): Promise<void> {
  if (!localTaskId.value || !taskActive.value) return
  await window.testAgentLocal.cancel(localTaskId.value)
}

/** 中断当前阶段；阶段产物保留，后续从阶段起点重跑。 */
async function pauseTask(): Promise<void> {
  if (!localTaskId.value || !taskActive.value) return
  await window.testAgentLocal.cancel(localTaskId.value)
}

/** P3-5：切换用例跳过状态。 */
function toggleSkipCase(caseId: string): void {
  if (skippedCaseIds.value.has(caseId)) {
    skippedCaseIds.value.delete(caseId)
  } else {
    skippedCaseIds.value.add(caseId)
  }
  // 触发 reactivity（Set 删除不自动触发）
  skippedCaseIds.value = new Set(skippedCaseIds.value)
}

/** P3-5：判断用例是否被跳过。 */
function isCaseSkipped(caseId: string): boolean {
  return skippedCaseIds.value.has(caseId)
}

/** 确认计划，启动执行阶段。 */
async function confirmExecution(): Promise<void> {
  if (!planPending.value || plannedCases.value.length === 0) return
  if (starting.value) return
  if (executionScope.value === 'selected' && executionPlanCases.value.length === 0) {
    error.value = '尚未选择要交给 Agent 的计划用例。请先勾选至少一条用例。'
    return
  }
  if (invalidPlanCases.value.length) {
    error.value = `还有 ${invalidPlanCases.value.length} 条用例缺少编号、名称、场景或预期，或编号重复；请展开用例补齐后再执行。`
    return
  }
  if (executionScope.value === 'incremental' && (planImpactLoading.value || !planImpactPreview.value || planImpactPreview.value.selected === 0)) {
    error.value = '增量范围没有可执行用例，或预估尚未完成。请选择全量执行，或调整用例目标后再试。'
    return
  }
  error.value = ''
  testExecutionSummary.value = null
  // 构造执行阶段的 input：携带 cases（必须转纯对象，Vue reactive proxy 无法跨 IPC 序列化）
  const execInput = {
    ...form,
    testTypes: [...form.testTypes],
    knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
    environment: environmentFromEntries(),
    apiHeaders: apiHeadersFromEntries(),
    uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined,
    cases: JSON.parse(JSON.stringify(executionPlanCases.value)),
    // selected 已在 GUI 收窄为子集；设为 true 防止 Runner 对该子集再次做增量筛选。
    fullRun: executionScope.value !== 'incremental',
  }
  planPending.value = false
  executionConfirmed.value = true
  currentPhase.value = form.testStrategy !== 'reflect' && form.testTypes.every(type => type === 'unit' || type === 'regression') ? 'generate' : 'execute'
  if (currentPhase.value === 'generate') generationTargets.value = []
  completedPlannedCases.value = JSON.parse(JSON.stringify(plannedCases.value)) as TestCaseRecord[]
  persistCheckpoint()
  starting.value = true
  agentTurns.value = []
  agentLogLines.value = []
  agentRunning.value = true
  try {
    const result = await startLocalRun(execInput)
    localTaskId.value = result.taskId
    // start() 已确认 Host 接收任务；立即进入执行页，避免 run-accepted 延迟或快速失败时
    // 用户仍停留在计划页而看不到任务状态与失败原因。
    go('run')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '执行阶段启动失败'
    agentRunning.value = false
    executionConfirmed.value = false
    planPending.value = true
    persistCheckpoint()
    go('plan')
  } finally {
    starting.value = false
  }
}

/** 取消计划，回到首页。 */
function cancelPlan(): void {
  planPending.value = false
  executionConfirmed.value = false
  planTaskId.value = null
  plannedCases.value = []
  selectedPlanCaseIds.value = []
  agentTurns.value = []
  agentLogLines.value = []
  agentRunning.value = false
  clearCheckpoint()
  go('home')
}

/** 诊断确认：按诊断修复（发 phase:'fix' 任务，input 带 diagnosis + fixDecision）。 */
async function confirmFixByDiagnosis(): Promise<void> {
  if (!diagnosisPending.value) return
  const pending = diagnosisPending.value
  const fixInput = {
    ...form,
    testTypes: [...form.testTypes],
    knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
    environment: environmentFromEntries(),
    apiHeaders: apiHeadersFromEntries(),
    uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined,
    diagnosis: { failedCases: JSON.parse(JSON.stringify(pending.failedCases)) },
    fixDecision: pending.fixDecision ? JSON.parse(JSON.stringify(pending.fixDecision)) : undefined,
  }
  diagnosisPending.value = null
  starting.value = true
  agentTurns.value = []
  agentLogLines.value = []
  agentRunning.value = true
  go('run')
  try {
    const result = await startLocalRun(fixInput)
    localTaskId.value = result.taskId
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '修复阶段启动失败'
    agentRunning.value = false
    diagnosisPending.value = pending
    go('diagnosis')
  } finally {
    starting.value = false
  }
}

/** 诊断确认：跳过修复，直接看报告。 */
function skipFix(): void {
  diagnosisPending.value = null
  clearCheckpoint()
  void persistCurrentRun()
  go('report')
}

/** 回滚指定修复动作（git apply -R 逆向应用 patch）。 */
async function rollbackFix(fixActionIndex: number): Promise<void> {
  if (!report.value?.fixActions?.[fixActionIndex]) return
  const action = report.value.fixActions[fixActionIndex]
  try {
    const ok = await window.testAgent.rollbackFix(form.projectPath, action.patch)
    if (ok) {
      pushLocalLog('success', `已回滚修复动作 ${fixActionIndex + 1}（${action.diagnosisName}）`)
    } else {
      error.value = '回滚失败（patch 冲突），请手动 git checkout'
      pushLocalLog('error', `回滚失败：${action.diagnosisName}`)
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '回滚异常'
  }
}

/** 删除计划用例（同步删除用例库中的记录）。 */
function deleteCase(index: number): void {
  const item = plannedCases.value[index]
  if (!item) return
  // 持久化到用例库（软删除，历史可回滚）
  if (form.projectPath) {
    void window.testAgent.deleteCaseFromLibrary(form.projectPath, item.title).catch(() => { /* 用例库写入失败不阻断 UI */ })
  }
  plannedCases.value.splice(index, 1)
  if (planPending.value) persistCheckpoint()
}

// ===== P0 项3：单场景重跑（task:rerunLocal，main 本地 spawn mvn） =====
const rerunTargetCaseId = ref('')
const rerunRunning = ref(false)
const rerunOutput = ref('')
const rerunError = ref('')
/** 可重跑的用例：仅带 structuredScenario 的（反射用例）。 */
const rerunnableCases = computed(() =>
  (plannedCases.value.length ? plannedCases.value : completedPlannedCases.value)
    .filter(c => hasStructuredScenario(c))
)

async function rerunScenario(): Promise<void> {
  if (!rerunTargetCaseId.value || !form.projectPath) return
  rerunRunning.value = true
  rerunOutput.value = ''
  rerunError.value = ''
  try {
    const result = await window.testAgent.rerunLocal(form.projectPath, rerunTargetCaseId.value)
    rerunOutput.value = result.output
    if (result.error) rerunError.value = result.error
  } catch (e) {
    rerunError.value = (e as Error).message
  } finally {
    rerunRunning.value = false
  }
}

/** P0 项4：从失败用例解析重跑 caseId——优先 item.caseId，否则按 name 匹配 plannedCases。 */
function resolveRerunCaseId(item: FailedCaseRecord): string {
  if (item.caseId) return item.caseId
  const allCases = plannedCases.value.length ? plannedCases.value : completedPlannedCases.value
  const matched = allCases.find(c => c.title === item.name || c.id === item.name)
  return matched?.id ?? ''
}

/** P0 项4：从失败用例重跑（复用项3 rerunLocal，输出填到 exec-controls 区）。 */
async function rerunFailedCase(item: FailedCaseRecord): Promise<void> {
  const caseId = resolveRerunCaseId(item)
  if (!caseId || !form.projectPath) return
  rerunTargetCaseId.value = caseId
  await rerunScenario()
  go('run')
}

// ===== P1-2：批量只跑失败重跑（task:rerunFailedBatch） =====
const batchRerunRunning = ref(false)
const batchRerunResult = ref<{ results: Array<{ name: string; ok: boolean; output: string; skipped?: boolean; error?: string }>; summary: { total: number; pass: number; fail: number; skipped: number }; error?: string } | null>(null)
const batchExpanded = ref<Set<number>>(new Set())

async function rerunFailedBatch(): Promise<void> {
  if (!report.value?.failedCases?.length || !form.projectPath) return
  batchRerunRunning.value = true
  batchRerunResult.value = null
  try {
    const cases = report.value.failedCases.map(c => ({ name: c.name, layer: c.layer, caseId: c.caseId, testClass: c.testClass }))
    batchRerunResult.value = await window.testAgent.rerunFailedBatch(form.projectPath, cases)
  } catch (e) {
    batchRerunResult.value = { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: (e as Error).message }
  } finally {
    batchRerunRunning.value = false
  }
}

function toggleBatchExpand(i: number): void {
  if (batchExpanded.value.has(i)) batchExpanded.value.delete(i)
  else batchExpanded.value.add(i)
}

/** 展开的用例 id 集合（点击展开/收起）。 */
const expandedScenarioIds = ref<Set<string>>(new Set())
/** 编辑态：caseId → { raw: string; errors: string[] }。 */
const scenarioEditState = reactive<Record<string, { raw: string; errors: string[] }>>({})

function toggleScenarioExpand(itemId: string): void {
  if (expandedScenarioIds.value.has(itemId)) expandedScenarioIds.value.delete(itemId)
  else expandedScenarioIds.value.add(itemId)
}

function hasStructuredScenario(item: TestCaseRecord): boolean {
  return item.structuredScenario != null && typeof item.structuredScenario === 'object'
}

function startEditScenario(item: TestCaseRecord): void {
  scenarioEditState[item.id] = { raw: JSON.stringify(item.structuredScenario, null, 2), errors: [] }
}
function copyScenarioJson(item: TestCaseRecord): void {
  void window.testAgent.copyText(JSON.stringify(item.structuredScenario, null, 2)).catch(() => { /* 复制失败不阻断 */ })
}
function cancelEditScenario(itemId: string): void {
  delete scenarioEditState[itemId]
}

/** 轻量 schema 校验（不引 ajv）：JSON 可解析 + target.className/method 必填 + assertion.type 合法 + 断言字段配套。 */
function validateScenarioJson(raw: string): { parsed: unknown | null; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown = null
  try { parsed = JSON.parse(raw) }
  catch (e) { return { parsed: null, errors: [`JSON 解析失败：${(e as Error).message}`] } }
  const s = parsed as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return { parsed: null, errors: ['场景必须是 JSON 对象'] }
  const target = s.target as Record<string, unknown> | undefined
  if (!target || typeof target.className !== 'string' || !target.className.trim()) errors.push('target.className 必填且为非空字符串')
  if (!target || typeof target.method !== 'string' || !target.method.trim()) errors.push('target.method 必填且为非空字符串')
  const assertion = s.assertion as Record<string, unknown> | undefined
  if (!assertion || (assertion.type !== 'return' && assertion.type !== 'exception')) {
    errors.push('assertion.type 必须是 return 或 exception')
  } else if (assertion.type === 'return' && !('expected' in assertion)) {
    errors.push('return 断言需提供 assertion.expected')
  } else if (assertion.type === 'exception' && (typeof assertion.expectedException !== 'string' || !assertion.expectedException.trim())) {
    errors.push('exception 断言需提供 assertion.expectedException（非空字符串）')
  }
  return { parsed: errors.length ? null : parsed, errors }
}

/** 保存编辑后的场景：仅本次运行（只改内存 structuredScenario）或持久化到 .test-agent/scenarios/<caseId>.json。 */
async function saveScenarioEdit(item: TestCaseRecord, persist: boolean): Promise<void> {
  const state = scenarioEditState[item.id]
  if (!state) return
  const { parsed, errors } = validateScenarioJson(state.raw)
  if (errors.length) { state.errors = errors; return }
  state.errors = []
  item.structuredScenario = parsed
  if (persist && form.projectPath) {
    try {
      const ok = await window.testAgent.saveScenario(form.projectPath, item.id, parsed)
      if (!ok) state.errors.push('持久化失败（main 写文件返回 false）')
    } catch (e) { state.errors.push(`持久化失败：${(e as Error).message}`) }
  }
  if (!state.errors.length) delete scenarioEditState[item.id]
}

/** planning_end 后批量拉取持久化场景填 structuredScenario（reviewer 裁决2：走 scenarios:read 兜底，不新增事件）。 */
async function hydrateStructuredScenarios(cases: TestCaseRecord[]): Promise<void> {
  if (!form.projectPath || cases.length === 0) return
  // 按 layer=unit 尝试 readScenario：unit 层用例可能带反射场景文件，失败静默（传统 JUnit 无场景文件）
  // 不绑死 testStrategy：发起时配置可能变更，按 layer 尝试更稳健（reviewer nit）
  const targets = cases.filter(c => c.layer === 'unit')
  if (targets.length === 0) return
  await Promise.all(targets.map(async (c) => {
    if (hasStructuredScenario(c)) return
    try {
      const s = await window.testAgent.readScenario(form.projectPath, c.id)
      if (s && typeof s === 'object') c.structuredScenario = s
    } catch { /* 传统 JUnit 用例无场景文件，静默 */ }
  }))
}

/** 添加一条空用例（同步写入用例库）。 */
function addCase(): void {
  const usedIds = new Set(plannedCases.value.map(item => item.id))
  let nextId = 1
  while (usedIds.has(`TC${String(nextId).padStart(3, '0')}`)) nextId++
  const id = `TC${String(nextId).padStart(3, '0')}`
  const newCase: TestCaseRecord = {
    id,
    title: '新用例',
    scenario: '',
    steps: [],
    expected: '',
    priority: 'medium',
  }
  plannedCases.value.push(newCase)
  if (planPending.value) persistCheckpoint()
  // 持久化到用例库
  if (form.projectPath) {
    void window.testAgent.saveCase(form.projectPath, { ...newCase }).catch(() => { /* 用例库写入失败不阻断 UI */ })
  }
}

/** 更新用例字段（同步更新用例库，保留版本历史）。 */
function updateCase(index: number, field: 'id' | 'title' | 'expected' | 'scenario' | 'priority' | 'layer' | 'method' | 'path' | 'expectedStatus' | 'expectedBodyContains', value: string): void {
  const item = plannedCases.value[index]
  if (!item) return
  if (field === 'priority') {
    item.priority = value as 'low' | 'medium' | 'high'
  } else if (field === 'layer') {
    if (value === '') delete item.layer
    else item.layer = value as 'unit' | 'api' | 'ui'
  } else if (field === 'expectedStatus') {
    item.expectedStatus = value.trim() === '' ? undefined : Number(value)
  } else if (field === 'expectedBodyContains') {
    item.expectedBodyContains = value.split(/\r?\n/).map(part => part.trim()).filter(Boolean)
  } else {
    ;(item as Record<string, unknown>)[field] = value
  }
  if (planPending.value) persistCheckpoint()
  // 持久化到用例库（每次更新追加版本历史）
  if (form.projectPath) {
    void window.testAgent.saveCase(form.projectPath, { ...item }).catch(() => { /* 用例库写入失败不阻断 UI */ })
  }
}

function updateApiJsonField(index: number, field: 'body' | 'expectedJsonSubset', value: string): void {
  const item = plannedCases.value[index]
  if (!item) return
  try {
    if (!value.trim()) delete item[field]
    else {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象')
      item[field] = parsed as Record<string, unknown>
    }
    error.value = ''
    if (planPending.value) persistCheckpoint()
    if (form.projectPath) void window.testAgent.saveCase(form.projectPath, { ...item }).catch(() => {})
  } catch (reason) {
    error.value = `${field === 'body' ? '请求体' : 'JSON 响应断言'}格式错误：${reason instanceof Error ? reason.message : String(reason)}`
  }
}
async function exportReport(format: 'markdown' | 'html' | 'json' | 'pdf'): Promise<void> {
  if (!snapshot.value?.report) return
  const result = await window.testAgent.exportReport(format, snapshot.value, form.projectPath)
  if (!result.saved) error.value = result.error ?? '导出失败'
}

async function copySummary(): Promise<void> {
  if (!snapshot.value?.report) return
  await window.testAgent.copyReportSummary(snapshot.value)
}

async function copyPrComment(): Promise<void> {
  if (!prComment.value) return
  await window.testAgent.copyText(prComment.value)
}

async function loadHistory(): Promise<void> {
  try {
    history.value = await window.testAgent.getHistory()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取运行历史失败'
  }
}

async function selectKnowledgeRoots(): Promise<void> {
  try {
    knowledgeRoots.value = await window.testAgent.selectKnowledgeRoots()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '选择知识库目录失败'
  }
}

async function loadAiConfig(): Promise<void> {
  try {
    const config = await window.testAgent.getAiConfig()
    aiConfig.value = config
    aiEditing.value = config ? structuredClone(config) : { providers: {} }
  } catch {
    aiConfig.value = null
    aiEditing.value = { providers: {} }
  }
}

async function saveAiConfig(): Promise<void> {
  try {
    aiError.value = ''
    // 保存前校验：选中的 provider 必须有 baseUrl 和 apiKey
    const dp = aiEditing.value.defaultProvider
    if (dp && aiEditing.value.providers[dp]) {
      const p = aiEditing.value.providers[dp]
      if (!p.baseUrl || !p.baseUrl.trim()) {
        aiError.value = '保存失败：baseUrl 不能为空，请在 provider 配置里填写 API 地址（如 http://agi-gateway.cxmt.com/cloud/v1）'
        return
      }
      if (!p.apiKey || !p.apiKey.trim()) {
        aiError.value = '保存失败：apiKey 不能为空，请填写 API Key'
        return
      }
    }
    await window.testAgent.saveAiConfig(JSON.parse(JSON.stringify(aiEditing.value)))
    aiConfig.value = JSON.parse(JSON.stringify(aiEditing.value))
    aiSaved.value = true
    setTimeout(() => { aiSaved.value = false }, 3000)
  } catch (reason) {
    aiError.value = reason instanceof Error ? reason.message : '保存 AI 配置失败'
    aiSaved.value = false
  }
}

function addAiProvider(): void {
  const pid = aiNewProviderId.value.trim()
  if (!pid || aiEditing.value.providers[pid]) return
  aiEditing.value.providers[pid] = { baseUrl: '', api: 'openai-completions', apiKey: '', models: [] }
  aiNewProviderId.value = ''
}

function removeAiProvider(pid: string): void {
  delete aiEditing.value.providers[pid]
  if (aiEditing.value.defaultProvider === pid) aiEditing.value.defaultProvider = undefined
}

function addAiModel(pid: string): void {
  const mid = aiNewModelId.value.trim()
  if (!mid) return
  const provider = aiEditing.value.providers[pid]
  if (!provider) return
  if (provider.models.some((m) => m.id === mid)) return
  provider.models.push({ id: mid, reasoning: false })
  aiNewModelId.value = ''
}

function removeAiModel(pid: string, mid: string): void {
  const provider = aiEditing.value.providers[pid]
  if (!provider) return
  provider.models = provider.models.filter((m) => m.id !== mid)
  if (aiEditing.value.defaultModel === mid) aiEditing.value.defaultModel = undefined
}

function aiProviderIds(): string[] {
  return Object.keys(aiEditing.value.providers)
}

function aiAllModelIds(): Array<{ provider: string; model: string }> {
  const result: Array<{ provider: string; model: string }> = []
  for (const [pid, prov] of Object.entries(aiEditing.value.providers)) {
    for (const m of prov.models) result.push({ provider: pid, model: m.id })
  }
  return result
}

function addEnvEntry(): void {
  envEntries.value.push({ key: '', value: '' })
}

function removeEnvEntry(index: number): void {
  envEntries.value.splice(index, 1)
}

function environmentFromEntries(): Record<string, string> | undefined {
  const entries = envEntries.value.filter((entry) => entry.key.trim() !== '')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map((entry) => [entry.key.trim(), entry.value]))
}

function addApiHeaderEntry(): void {
  apiHeaderEntries.value.push({ key: '', value: '' })
}

function removeApiHeaderEntry(index: number): void {
  apiHeaderEntries.value.splice(index, 1)
}

function apiHeadersFromEntries(): Record<string, string> | undefined {
  const entries = apiHeaderEntries.value.filter((entry) => entry.key.trim() !== '')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map((entry) => [entry.key.trim(), entry.value]))
}

async function loadEnvironments(): Promise<void> {
  if (!form.projectPath.trim()) { environments.value = []; return }
  try {
    const secured = await window.testAgent.loadEnvironmentProfiles(form.projectPath)
    const raw = localStorage.getItem('test-agent-environments')
    if (raw) {
      const legacy = (JSON.parse(raw) as Array<Omit<EnvironmentProfile, 'projectPath' | 'coverageTarget'>>).map(profile => ({
        ...profile,
        projectPath: form.projectPath,
        coverageTarget: form.coverageTarget ?? 80
      }))
      const merged = [...secured]
      for (const profile of legacy) if (!merged.some(item => item.id === profile.id)) merged.push(profile)
      await window.testAgent.saveEnvironmentProfiles(form.projectPath, merged)
      localStorage.removeItem('test-agent-environments')
      environments.value = merged
    } else environments.value = secured
  } catch {
    environments.value = []
  }
}

async function persistEnvironments(): Promise<void> {
  if (!form.projectPath.trim()) throw new Error('请先选择项目，再保存环境配置')
  await window.testAgent.saveEnvironmentProfiles(form.projectPath, environments.value)
  localStorage.removeItem('test-agent-environments')
}

function captureEnvironment(): EnvironmentProfile {
  return {
    id: `env-${Date.now()}`,
    projectPath: form.projectPath,
    name: `环境 ${environments.value.length + 1}`,
    apiBaseUrl: form.apiBaseUrl ?? '',
    openApiUrl: form.openApiUrl ?? '',
    uiEntryUrl: form.uiEntryUrl ?? '',
    coverageTarget: form.coverageTarget ?? 80,
    apiHeaders: [...apiHeaderEntries.value],
    env: [...envEntries.value]
  }
}

async function saveCurrentEnvironment(): Promise<void> {
  if (!form.projectPath.trim()) { error.value = '请先选择项目，再保存环境配置'; return }
  const profile = captureEnvironment()
  environments.value.push(profile)
  activeEnvironmentId.value = profile.id
  try { await persistEnvironments() }
  catch (reason) {
    environments.value = environments.value.filter(item => item.id !== profile.id)
    activeEnvironmentId.value = ''
    error.value = reason instanceof Error ? reason.message : '环境配置保存失败'
  }
}

function applyEnvironment(id: string): void {
  const profile = environments.value.find((item) => item.id === id)
  if (!profile) return
  form.apiBaseUrl = profile.apiBaseUrl
  form.openApiUrl = profile.openApiUrl
  form.uiEntryUrl = profile.uiEntryUrl
  form.coverageTarget = profile.coverageTarget
  apiHeaderEntries.value = profile.apiHeaders.map((entry) => ({ ...entry }))
  envEntries.value = profile.env.map((entry) => ({ ...entry }))
  activeEnvironmentId.value = id
}

async function deleteEnvironment(id: string): Promise<void> {
  const previous = [...environments.value]
  environments.value = environments.value.filter((item) => item.id !== id)
  if (activeEnvironmentId.value === id) activeEnvironmentId.value = ''
  try { await persistEnvironments() }
  catch (reason) {
    environments.value = previous
    error.value = reason instanceof Error ? reason.message : '环境配置删除失败'
  }
}

async function persistCurrentRun(): Promise<void> {
  if (!snapshot.value?.report) return
  try {
    await window.testAgent.saveHistory({
      id: snapshot.value.taskId,
      projectName: form.systemName,
      projectPath: form.projectPath,
      version: form.version,
      savedAt: new Date().toISOString(),
      snapshot: snapshot.value
    })
    await loadHistory()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存运行历史失败'
  }
}

// ===== 断点恢复：localStorage checkpoint 持久化（防刷新丢失阶段产物） =====
/** checkpoint key 加 projectPath（sanitize 非字母数字为 _，防多项目冲突）。 */
const checkpointKey = computed(() => `test-agent-checkpoint-${form.projectPath ? form.projectPath.replace(/[^a-zA-Z0-9]/g, '_') : 'default'}`)

/** 写入 checkpoint 到 localStorage（超限 fallback 只存 phase + truncated 标记）。 */
function persistCheckpoint(): void {
  const checkpoint = {
    projectPath: form.projectPath,
    systemName: form.systemName,
    version: form.version,
    testTypes: [...form.testTypes],
    testStrategy: form.testStrategy,
    taskId: localTaskId.value,
    scoutReport: completedScoutReport.value,
    plannedCases: planPending.value ? plannedCases.value : completedPlannedCases.value,
    planPending: planPending.value,
    executionScope: executionScope.value,
    selectedPlanCaseIds: [...selectedPlanCaseIds.value],
    phase: currentPhase.value,
  }
  try {
    localStorage.setItem(checkpointKey.value, JSON.stringify(checkpoint))
  } catch {
    // 大型 scout 报告占满 localStorage 时优先保住人工确认过的计划草稿。
    try {
      localStorage.setItem(checkpointKey.value, JSON.stringify({ ...checkpoint, scoutReport: '', scoutReportTruncated: true }))
    } catch { /* localStorage 不可用，忽略 */ }
  }
}

/** 从 localStorage 恢复 checkpoint（onMounted 调用）。 */
function restoreCheckpoint(): void {
  try {
    const raw = localStorage.getItem(checkpointKey.value)
    if (!raw) return
    const cp = JSON.parse(raw) as { projectPath?: string; systemName?: string; version?: string; testTypes?: TestType[]; testStrategy?: TaskInput['testStrategy']; taskId?: string; scoutReport?: string; plannedCases?: TestCaseRecord[]; planPending?: boolean; executionScope?: 'full' | 'incremental' | 'selected'; selectedPlanCaseIds?: string[]; phase?: string; scoutReportTruncated?: boolean }
    if (cp.projectPath && cp.projectPath !== form.projectPath) return
    if (cp.systemName) form.systemName = cp.systemName
    if (cp.version) form.version = cp.version
    if (cp.testTypes?.length) form.testTypes = cp.testTypes
    if (cp.testStrategy) form.testStrategy = cp.testStrategy
    if (cp.scoutReport && !cp.scoutReportTruncated) completedScoutReport.value = cp.scoutReport
    if (cp.plannedCases) {
      completedPlannedCases.value = mapCases(cp.plannedCases)
      if (cp.planPending) plannedCases.value = mapCases(cp.plannedCases)
    }
    if (cp.phase) currentPhase.value = cp.phase as 'scout' | 'design' | 'generate' | 'execute' | 'fix' | ''
    if (cp.planPending && plannedCases.value.length) {
      planPending.value = true
      executionScope.value = cp.executionScope === 'incremental' || cp.executionScope === 'selected' ? cp.executionScope : 'full'
      selectedPlanCaseIds.value = cp.selectedPlanCaseIds?.filter(id => plannedCases.value.some(item => item.id === id)) ?? []
      localTaskId.value = cp.taskId ?? ''
      go('plan')
    }
  } catch { /* 忽略损坏的 checkpoint */ }
}

/** 清除 checkpoint（任务成功完成或新任务启动时调用）。 */
function clearCheckpoint(): void {
  try {
    localStorage.removeItem(checkpointKey.value)
  } catch { /* 忽略 */ }
  completedScoutReport.value = ''
  completedPlannedCases.value = []
  currentPhase.value = ''
  executionConfirmed.value = false
  skippedCaseIds.value = new Set()
}

/** 重跑当前阶段：scout 无阶段产物，只能重新分析；后续阶段使用已保存产物。 */
async function rerunFromCheckpoint(): Promise<void> {
  if (starting.value || agentRunning.value) return
  if (currentPhase.value === 'scout') {
    await startTask()
  } else if (currentPhase.value === 'design' && completedScoutReport.value) {
    // 重跑 case-designer：input 带 scoutReport，跳 scout
    const planInput = { ...form, testTypes: [...form.testTypes], scoutReport: completedScoutReport.value, ...(skippedCaseIds.value.size > 0 ? { skipCaseIds: [...skippedCaseIds.value] } : {}) }
    starting.value = true
    agentRunning.value = true
    error.value = ''
    localLogs.value = []
    agentTurns.value = []
    agentLogLines.value = []
    try {
      const result = await startLocalRun(planInput)
      localTaskId.value = result.taskId
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '用例设计重跑失败'
      agentRunning.value = false
    } finally {
      starting.value = false
    }
  } else if ((currentPhase.value === 'generate' || currentPhase.value === 'execute') && completedPlannedCases.value.length) {
    // 重跑 tester：input 带 cases，跳 design
    const execInput = {
      ...form,
      testTypes: [...form.testTypes],
      knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
      environment: environmentFromEntries(),
      apiHeaders: apiHeadersFromEntries(),
      uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined,
      cases: JSON.parse(JSON.stringify(completedPlannedCases.value)),
      // checkpoint 只证明计划存在，不证明磁盘上的生成文件仍与该计划 ID 对应。
      // 让 Worker 校验产物后决定复用；禁止仅凭阶段名跳过测试准备。
      ...(skippedCaseIds.value.size > 0 ? { skipCaseIds: [...skippedCaseIds.value] } : {}),
    }
    starting.value = true
    executionConfirmed.value = true
    agentRunning.value = true
    error.value = ''
    localLogs.value = []
    agentTurns.value = []
    agentLogLines.value = []
    try {
      const result = await startLocalRun(execInput)
      localTaskId.value = result.taskId
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '测试执行重跑失败'
      agentRunning.value = false
      executionConfirmed.value = false
    } finally {
      starting.value = false
    }
  }
}

/** 只在可安全重跑的阶段显示入口；scout 没有产物，但可从头重新分析。 */
const canRerunCheckpoint = computed(() => retryStageAction({
  status: snapshot.value?.status,
  phase: currentPhase.value,
  projectReady: Boolean(form.projectPath && form.systemName && form.testTypes.length),
  hostReady: localStatus.value.running,
  hasScoutReport: completedScoutReport.value !== '',
  plannedCaseCount: completedPlannedCases.value.length,
}) !== null)
const hasRestorablePlan = computed(() => completedPlannedCases.value.length > 0 && (currentPhase.value === 'generate' || currentPhase.value === 'execute'))
const retryStageLabel = computed(() => currentPhase.value === 'scout'
  ? '重新分析项目'
  : hasRestorablePlan.value
    ? `继续执行 ${completedPlannedCases.value.length} 条计划`
    : '重跑当前阶段')

// checkpoint 变化时持久化到 localStorage
watch([completedScoutReport, completedPlannedCases, currentPhase], () => {
  if (currentPhase.value === '') {
    // 已清空（任务完成），不写
    return
  }
  persistCheckpoint()
})
watch(executionScope, () => { if (planPending.value) persistCheckpoint() })
watch(selectedPlanCaseIds, () => { if (planPending.value) persistCheckpoint() }, { deep: true })

function openHistory(record: HistoryRecord): void {
  snapshot.value = record.snapshot
  form.projectPath = record.projectPath
  form.systemName = record.projectName
  form.version = record.version
  localLogs.value = [...record.snapshot.logs]
  localTaskId.value = record.snapshot.taskId
  go('report')
}

async function clearHistory(): Promise<void> {
  await window.testAgent.clearHistory()
  history.value = []
  suiteTree.value = []  // P1-1 澄清2：task reset 同步清套件树
}

// ===== P1-1：左导航真工作台导航（项目列表 + 套件树） =====
/** history 去重 by projectPath 取最近 savedAt，项目卡片数据源（与首页 P1-0 共用）。 */
const recentProjects = computed(() => {
  const map = new Map<string, HistoryRecord>()
  for (const h of history.value) {
    const existing = map.get(h.projectPath)
    if (!existing || h.savedAt > existing.savedAt) map.set(h.projectPath, h)
  }
  return [...map.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 10)
})

interface SuiteNode { layer: string; cases: TestCaseRecord[] }
const suiteTree = ref<SuiteNode[]>([])
const suiteLoading = ref(false)
const expandedLayers = ref<Set<string>>(new Set(['unit']))
const librarySelectedCaseIds = ref<string[]>([])
const libraryRunBusy = ref(false)
const libraryRunMessage = ref('')
const libraryRunError = ref('')
const libraryRunOutput = ref('')
const libraryReflectResults = ref<SuiteRunResult['results']>([])
const libraryRunKind = ref<'all' | 'reflect' | 'agent' | null>(null)
const planCollectionTab = ref<'current' | 'saved'>('current')
const libraryRunActive = computed(() => libraryRunBusy.value || libraryRunKind.value !== null)
const libraryCases = computed(() => suiteTree.value.flatMap(node => node.cases))
const planAvailable = computed(() => Boolean(
  planPending.value || plannedCases.value.length || completedPlannedCases.value.length || report.value?.cases?.length || report.value?.casesMeta?.count || libraryCases.value.length
))
const currentPlanCaseCount = computed(() => visiblePlanCases.value.length || report.value?.casesMeta?.count || 0)
function openPlanTab(tab: 'current' | 'saved'): void {
  planCollectionTab.value = tab
  go('plan')
}
const selectedReflectLibraryCases = computed(() => {
  const selected = new Set(librarySelectedCaseIds.value)
  return libraryCases.value.filter(item => selected.has(item.id) && hasScenarioFlag(item))
})
const selectedLibraryCases = computed(() => {
  const selected = new Set(librarySelectedCaseIds.value)
  return libraryCases.value.filter(item => selected.has(item.id))
})

async function runSelectedLibraryCases(): Promise<void> {
  if (!form.projectPath || libraryRunBusy.value || !selectedLibraryCases.value.length) return
  const cases = JSON.parse(JSON.stringify(selectedLibraryCases.value)) as TestCaseRecord[]
  const invalid = invalidCases(cases)
  if (invalid.length) {
    libraryRunError.value = `已选用例中有 ${invalid.length} 条缺少执行字段；请在本次计划中补齐后重新保存。`
    return
  }
  const selectedTypes = Array.from(new Set(cases.map(item => item.layer).filter((layer): layer is 'unit' | 'api' | 'ui' => layer === 'unit' || layer === 'api' || layer === 'ui')))
  if (selectedTypes.includes('api') && !form.apiBaseUrl?.trim()) {
    libraryRunError.value = '已选用例包含 API 测试，请先在工作台填写 API 基础地址。'
    return
  }
  libraryRunBusy.value = true
  libraryRunKind.value = 'agent'
  libraryRunMessage.value = ''
  libraryRunError.value = ''
  libraryRunOutput.value = ''
  libraryReflectResults.value = []
  testExecutionSummary.value = null
  completedPlannedCases.value = cases
  form.testTypes = selectedTypes.length ? selectedTypes : ['unit']
  currentPhase.value = form.testStrategy !== 'reflect' && form.testTypes.every(type => type === 'unit' || type === 'regression') ? 'generate' : 'execute'
  agentTurns.value = []
  agentLogLines.value = []
  agentRunning.value = true
  go('run')
  try {
    const result = await startLocalRun({
      ...form,
      testTypes: selectedTypes.length ? selectedTypes : ['unit'],
      knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined,
      environment: environmentFromEntries(),
      apiHeaders: apiHeadersFromEntries(),
      uiEntryUrl: form.uiEntryUrl?.trim() ? form.uiEntryUrl : undefined,
      cases,
      fullRun: true,
    })
    localTaskId.value = result.taskId
    libraryRunMessage.value = `已提交 ${cases.length} 条保存用例，正在生成或复用测试代码并执行。`
  } catch (reason) {
    libraryRunError.value = reason instanceof Error ? reason.message : '保存用例回归启动失败'
    agentRunning.value = false
    libraryRunBusy.value = false
  }
}

async function runAllLibraryTests(): Promise<void> {
  if (!form.projectPath || libraryRunBusy.value) return
  if (typeof window.testAgent.runAllLocal !== 'function') {
    libraryRunError.value = '应用功能已更新，请重启开发版后再运行全部项目测试。'
    return
  }
  libraryRunBusy.value = true
  libraryRunKind.value = 'all'
  libraryRunMessage.value = ''
  libraryRunError.value = ''
  libraryRunOutput.value = ''
  libraryReflectResults.value = []
  go('run')
  try {
    const result = await window.testAgent.runAllLocal(form.projectPath)
    libraryRunOutput.value = result.output
    if (!result.ok) libraryRunError.value = result.error || '全量项目测试失败'
    else libraryRunMessage.value = '全量项目测试执行完成。详细结果请查看命令输出或测试报告。'
  } catch (reason) {
    libraryRunError.value = reason instanceof Error ? reason.message : '全量项目测试启动失败'
  } finally {
    libraryRunBusy.value = false
  }
}

async function runSelectedLibraryReflect(): Promise<void> {
  if (!form.projectPath || libraryRunBusy.value || !selectedReflectLibraryCases.value.length) return
  if (typeof window.testAgent.runSelectedReflect !== 'function') {
    libraryRunError.value = '应用功能已更新，请重启开发版后再运行所选反射场景。'
    return
  }
  libraryRunBusy.value = true
  libraryRunKind.value = 'reflect'
  libraryRunMessage.value = ''
  libraryRunError.value = ''
  libraryRunOutput.value = ''
  libraryReflectResults.value = []
  go('run')
  try {
    const expectedIds = selectedReflectLibraryCases.value.map(item => item.id)
    const result = await window.testAgent.runSelectedReflect(form.projectPath, expectedIds)
    libraryReflectResults.value = result.results
    if (result.error) libraryRunError.value = result.error
    else if (result.summary.total !== expectedIds.length) libraryRunError.value = `期望执行 ${expectedIds.length} 条，实际返回 ${result.summary.total} 条，结果未认定`
    else libraryRunMessage.value = `所选反射场景执行完成：${result.summary.pass} 通过、${result.summary.fail} 失败。`
  } catch (reason) {
    libraryRunError.value = reason instanceof Error ? reason.message : '反射场景执行失败'
  } finally {
    libraryRunBusy.value = false
  }
}

type LibraryDeleteIntent = { kind: 'one'; item: TestCaseRecord } | { kind: 'all'; count: number; removableFiles: string[]; protectedFiles: string[] }
const libraryDeleteIntent = ref<LibraryDeleteIntent | null>(null)
const libraryDeleteBusy = ref(false)

function deleteLibraryCase(item: TestCaseRecord): void {
  if (!form.projectPath) return
  libraryDeleteIntent.value = { kind: 'one', item }
}

async function resetLibraryForNewAnalysis(): Promise<void> {
  if (!form.projectPath) return
  const preview = await window.testAgent.previewGeneratedTestReset(form.projectPath).catch(() => ({ removableFiles: [], protectedFiles: [] }))
  libraryDeleteIntent.value = { kind: 'all', count: libraryCases.value.length, ...preview }
}

async function confirmLibraryDeletion(): Promise<void> {
  if (!form.projectPath || !libraryDeleteIntent.value || libraryDeleteBusy.value) return
  const intent = libraryDeleteIntent.value
  libraryDeleteBusy.value = true
  if (intent.kind === 'one') {
    const item = intent.item
  const deleted = await window.testAgent.deleteCaseFromLibrary(form.projectPath, item.title).catch(() => false)
  if (!deleted) {
    libraryRunError.value = `删除“${item.title}”失败，请稍后重试。`
      libraryDeleteBusy.value = false
      libraryDeleteIntent.value = null
    return
  }
  if (hasScenarioFlag(item)) await window.testAgent.deleteScenario(form.projectPath, item.id).catch(() => false)
  suiteTree.value = suiteTree.value
    .map(node => ({ ...node, cases: node.cases.filter(entry => entry.id !== item.id) }))
    .filter(node => node.cases.length > 0)
  librarySelectedCaseIds.value = librarySelectedCaseIds.value.filter(id => id !== item.id)
    libraryDeleteBusy.value = false
    libraryDeleteIntent.value = null
    return
  }
  const cases = [...libraryCases.value]
  const outcomes = await Promise.all(cases.map(async item => {
    const deleted = await window.testAgent.deleteCaseFromLibrary(form.projectPath, item.title).catch(() => false)
    if (deleted && hasScenarioFlag(item)) await window.testAgent.deleteScenario(form.projectPath, item.id).catch(() => false)
    return deleted
  }))
  const failed = outcomes.filter(ok => !ok).length
  if (failed) {
    libraryRunError.value = `${failed} 条用例删除失败，已重新加载用例库。`
    await loadSuiteTree()
    libraryDeleteBusy.value = false
    libraryDeleteIntent.value = null
    return
  }
  libraryRunKind.value = null
  libraryRunMessage.value = ''
  libraryRunError.value = ''
  libraryRunOutput.value = ''
  libraryReflectResults.value = []
  const reset = await window.testAgent.resetGeneratedTests(form.projectPath).catch(() => ({ removedFiles: [], failedFiles: ['无法执行安全清理'], protectedFiles: [] }))
  if (reset.failedFiles.length) {
    libraryRunError.value = `用例库已清空，但 ${reset.failedFiles.length} 个生成测试文件清理失败。`
  } else if (reset.removedFiles.length) {
    libraryRunMessage.value = `已清空用例库并清理 ${reset.removedFiles.length} 个 Test Agent 生成的未跟踪测试文件。`
  }
  suiteTree.value = []
  librarySelectedCaseIds.value = []
  showAiForm.value = true
  libraryDeleteBusy.value = false
  libraryDeleteIntent.value = null
  go('home')
}

// ===== P3-1 回归套件状态 =====
const suites = ref<Suite[]>([])
const suiteSaveMode = ref(false)
const suiteSaveName = ref('')
const planSaveBusy = ref(false)
const planSaveMessage = ref('')
const planSaveError = ref('')
const suiteRunning = ref<string | null>(null)
const suiteRunResults = ref<Record<string, SuiteRunResult | undefined>>({})
const expandedSuiteResults = ref<Set<string>>(new Set())

/** 加载当前项目套件树（loadCases + listScenarios，按 layer 分组，反射用例标 hasScenario）。 */
async function loadSuiteTree(): Promise<void> {
  if (!form.projectPath) { suiteTree.value = []; return }
  suiteLoading.value = true
  try {
    const [cases, scenarios] = await Promise.all([
      window.testAgent.loadCases(form.projectPath).catch(() => []),
      window.testAgent.listScenarios(form.projectPath).catch(() => []),
    ])
    const scenarioIds = new Set((scenarios as Array<{ caseId: string }>).map(s => s.caseId))
    const marked = (cases as TestCaseRecord[]).map(c => ({
      ...c,
      hasScenario: scenarioIds.has(c.id),
    }))
    const byLayer = new Map<string, TestCaseRecord[]>()
    for (const c of marked) {
      const layer = c.layer ?? 'unknown'
      if (!byLayer.has(layer)) byLayer.set(layer, [])
      byLayer.get(layer)!.push(c)
    }
    suiteTree.value = [...byLayer.entries()].map(([layer, cs]) => ({ layer, cases: cs }))
  } finally {
    suiteLoading.value = false
  }
}

// ===== P3-1 回归套件功能 =====

/** 加载当前项目的套件列表。 */
async function loadSuites(): Promise<void> {
  if (!form.projectPath) { suites.value = []; return }
  try {
    suites.value = await window.testAgent.listSuites(form.projectPath)
  } catch { suites.value = [] }
}

/** 当前可保存的用例 ID 列表（plannedCases 或 report.cases）。 */
function currentCaseIds(): string[] {
  return visiblePlanCases.value.map(c => c.id).filter(Boolean)
}

/** 将当前计划显式保存为长期用例资产，不启动测试。 */
async function saveCurrentPlanToLibrary(): Promise<boolean> {
  if (!form.projectPath || !visiblePlanCases.value.length || planSaveBusy.value) return false
  planSaveBusy.value = true
  planSaveMessage.value = ''
  planSaveError.value = ''
  const cases = JSON.parse(JSON.stringify(visiblePlanCases.value)) as TestCaseRecord[]
  try {
    const outcomes = await Promise.allSettled(cases.map(item => window.testAgent.saveCase(form.projectPath, { ...item })))
    const failed = outcomes.filter(item => item.status === 'rejected').length
    await loadSuiteTree()
    if (failed) {
      planSaveError.value = `${failed} 条用例保存失败；其余 ${cases.length - failed} 条已保存。`
      return false
    }
    planSaveMessage.value = `已保存 ${cases.length} 条用例，暂未执行测试。`
    return true
  } catch (reason) {
    planSaveError.value = reason instanceof Error ? reason.message : '保存用例失败'
    return false
  } finally {
    planSaveBusy.value = false
  }
}

/** 保存当前用例集为回归套件。 */
async function saveSuiteFromCurrent(): Promise<void> {
  if (!form.projectPath || !suiteSaveName.value.trim()) return
  const ids = currentCaseIds()
  if (!ids.length) return
  if (visiblePlanCases.value.length && libraryCases.value.length === 0) {
    const saved = await saveCurrentPlanToLibrary()
    if (!saved) return
  }
  const strategy = form.testStrategy ?? 'junit'
  try {
    const result = await window.testAgent.saveSuite(form.projectPath, suiteSaveName.value.trim(), ids, strategy)
    if (result.ok) {
      suiteSaveMode.value = false
      suiteSaveName.value = ''
      await loadSuites()
    }
  } catch { /* 忽略 */ }
}

/** 一键回归——运行指定套件。 */
async function runSuiteNow(suite: Suite): Promise<void> {
  if (!form.projectPath) return
  suiteRunning.value = suite.id
  try {
    const result = await window.testAgent.runSuite(form.projectPath, suite.id)
    suiteRunResults.value[suite.id] = result
    await loadSuites() // 刷新 lastRunResult
  } catch {
    suiteRunResults.value[suite.id] = { results: [], summary: { total: 0, pass: 0, fail: 0, skipped: 0 }, error: '执行失败' }
  } finally {
    suiteRunning.value = null
  }
}

/** 删除套件。 */
async function deleteSuiteById(suite: Suite): Promise<void> {
  if (!form.projectPath) return
  try {
    await window.testAgent.deleteSuite(form.projectPath, suite.id)
    await loadSuites()
  } catch { /* 忽略 */ }
}

/** 展开/收起套件运行结果。 */
function toggleSuiteResult(suiteId: string): void {
  if (expandedSuiteResults.value.has(suiteId)) expandedSuiteResults.value.delete(suiteId)
  else expandedSuiteResults.value.add(suiteId)
}

/** 套件用例数显示。 */
function suiteCaseCount(suite: Suite): number {
  return suite.caseIds.length
}

/** 套件上次运行摘要文本。 */
function suiteLastRunText(suite: Suite): string {
  if (!suite.lastRunAt) return '从未运行'
  const r = suite.lastRunResult
  if (!r) return `上次运行 ${relativeTime(suite.lastRunAt)}`
  return `上次运行 ${relativeTime(suite.lastRunAt)} · ✅${r.pass} ❌${r.fail}${r.skipped ? ` ⏭${r.skipped}` : ''}`
}

/** 项目套件数（首页项目卡片用）。 */
function projectSuiteCount(p: HistoryRecord): number {
  return suites.value.filter(s => s.projectPath === p.projectPath).length
}

// ===== P3-2 场景文件管理 =====
const scenarioFiles = ref<Array<{ caseId: string; title?: string }>>([])

/** 加载场景文件列表。 */
async function loadScenarioFiles(): Promise<void> {
  if (!form.projectPath) { scenarioFiles.value = []; return }
  try {
    scenarioFiles.value = await window.testAgent.listScenarios(form.projectPath)
  } catch { scenarioFiles.value = [] }
}

/** 删除场景文件。 */
async function deleteScenarioFile(caseId: string): Promise<void> {
  if (!form.projectPath) return
  try {
    await window.testAgent.deleteScenario(form.projectPath, caseId)
    await loadScenarioFiles()
  } catch { /* 忽略 */ }
}

/** 导出场景（全部或指定 caseIds）。 */
async function exportScenarios(caseIds?: string[]): Promise<void> {
  if (!form.projectPath) return
  try {
    const data = await window.testAgent.exportScenarios(form.projectPath, caseIds)
    const json = JSON.stringify(data, null, 2)
    await navigator.clipboard.writeText(json)
  } catch { /* 忽略 */ }
}

// P3-3 组件适配函数（ScenariosPanel emit → IPC 调用）
async function loadScenarioJson(caseId: string): Promise<string> {
  if (!form.projectPath) return '{}'
  try {
    const s = await window.testAgent.readScenario(form.projectPath, caseId)
    return s ? JSON.stringify(s, null, 2) : '{}'
  } catch { return '{}' }
}

async function saveScenarioFromPanel(caseId: string, json: string): Promise<void> {
  if (!form.projectPath) return
  try {
    const parsed = JSON.parse(json)
    await window.testAgent.saveScenario(form.projectPath, caseId, parsed)
    await loadScenarioFiles()
  } catch { /* JSON parse error */ }
}

async function importScenariosFromPanel(jsonText: string): Promise<void> {
  if (!form.projectPath || !jsonText.trim()) return
  try {
    const parsed = JSON.parse(jsonText)
    if (!Array.isArray(parsed)) return
    await window.testAgent.importScenarios(form.projectPath, parsed)
    await loadScenarioFiles()
  } catch { /* JSON parse error */ }
}

/** 项目切换（reviewer 冲突解法 A：只设 projectPath，systemName/version/testTypes 交 detectProject）。 */
async function selectProjectFromNav(p: HistoryRecord): Promise<void> {
  if (form.projectPath !== p.projectPath) clearProjectTransientState()
  form.projectPath = p.projectPath
  await detectProject(p.projectPath)
  showQuickReflect.value = false
  await loadSuiteTree()
  void loadSuites()
  void loadScenarioFiles()
  go('home')  // 澄清1：切项目后回项目概览，避免停留在旧 plannedCases 的 plan view
}

function toggleLayer(layer: string): void {
  if (expandedLayers.value.has(layer)) expandedLayers.value.delete(layer)
  else expandedLayers.value.add(layer)
}

/** 套件树用例是否有反射场景（loadSuiteTree 标记的 hasScenario 字段，template 不能 as 断言）。 */
function hasScenarioFlag(c: TestCaseRecord): boolean {
  return (c as TestCaseRecord & { hasScenario?: boolean }).hasScenario === true
}

/** 路径取末尾段作项目短名（无 projectName 时免现全路径）。 */
function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/$/, '')
  const seg = norm.split('/').filter(Boolean).pop()
  return seg ?? p
}

/** ISO 时间转相对时间（“2h ago”/“3d ago”），用于项目卡片副标题。 */
function relativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

// ===== P1-0：首页重设（工作台首页） =====
/** 最近运行：history 按时间倒序（跨项目时间流，与项目卡片去重列表互补）。 */
const recentRuns = computed(() =>
  [...history.value].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 8)
)

/** 项目卡片用例数：从 snapshot.report.casesMeta?.count 取（省一次 loadCases IPC）。 */
function projectCaseCount(h: HistoryRecord): number | string {
  return h.snapshot.report?.casesMeta?.count ?? '--'
}

/** 历史运行终态文案（snapshot.status，无 currentPhase）。 */
function runStatusText(h: HistoryRecord): string {
  const s = h.snapshot.status
  if (s === 'completed') return '已完成'
  if (s === 'failed') return '失败'
  if (s === 'cancelled') return '已取消'
  return s
}

/** 运行产物 chips：报告/用例/修复，按字段存在性条件渲染。 */
function runArtifacts(h: HistoryRecord): Array<{ key: string; label: string; icon: string }> {
  const r = h.snapshot.report
  const chips: Array<{ key: string; label: string; icon: string }> = []
  if (r) chips.push({ key: 'report', label: '报告', icon: '📊' })
  if (r?.casesMeta?.count) chips.push({ key: 'cases', label: `${r.casesMeta.count}用例`, icon: '📋' })
  if (r?.fixes?.length) chips.push({ key: 'fixes', label: `${r.fixes.length}修复`, icon: '🔧' })
  return chips
}

/** 进行中任务阶段文案（currentPhase ref，仅内存可得）。 */
function phaseText(): string {
  if (planPending.value) return '等待确认计划'
  const p = currentPhase.value
  if (p === 'scout') return '正在分析项目'
  if (p === 'design') return '正在设计用例'
  if (p === 'generate') return '正在生成测试代码'
  if (p === 'execute') return '正在执行测试'
  if (p === 'fix') return '正在修复问题'
  return '正在准备任务'
}

/** P1-0 reviewer 问题1：运行卡片产物 chip 直达——report/fixes 进报告，cases 进用例集。 */
function onChipClick(h: HistoryRecord, key: string): void {
  if (key === 'cases') {
    form.projectPath = h.projectPath
    void loadSuiteTree()
    go('plan')
  } else {
    openHistory(h)  // report / fixes → 报告 view（openHistory set snapshot + go('report')）
  }
}


function shotUrl(shot: string): string {
  const base = form.projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = shot.replace(/\\/g, '/').replace(/^\//, '')
  // 用 local-file:// 自定义 protocol（Electron 注册），file:// 被安全策略禁用
  return `local-file:///${base}/${rel}`
}

/** P3-4：在新窗口打开截图全图。 */
function openScreenshot(shot: string): void {
  window.open(shotUrl(shot), '_blank')
}

/** P3-4：滚动到录像回放区域。 */
function scrollToVideo(): void {
  const el = document.querySelector('.recording-row')
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

onMounted(() => {
  try {
    const lastProjectPath = localStorage.getItem('test-agent-last-project-path')
    if (lastProjectPath && !form.projectPath) form.projectPath = lastProjectPath
  } catch { /* storage unavailable */ }
  activityClock = setInterval(() => { clockNow.value = Date.now() }, 10_000)
  void window.testAgent.getKnowledgeRoots().then((roots) => (knowledgeRoots.value = roots))
  unsubscribeRoots = window.testAgent.onKnowledgeRootsChanged((roots) => (knowledgeRoots.value = roots))
  unsubscribeLocal = window.testAgentLocal.subscribe(handleLocalMessage)
  unsubscribeMenuNav = window.testAgent.onNavigate((target) => {
    if (target === 'home' || target === 'history' || target === 'settings') go(target)
  })
  unsubscribeMenuCommand = window.testAgent.onCommand((command) => {
    switch (command) {
      case 'start':
        void startTask()
        break
      case 'cancel':
        void cancelTask()
        break
      case 'exportMarkdown':
        void exportReport('markdown')
        break
      case 'exportHtml':
        void exportReport('html')
        break
      case 'copySummary':
        void copySummary()
        break
      case 'selectKnowledgeRoots':
        void selectKnowledgeRoots()
        break
      case 'settingsEnvironment':
        openSettingsSection('environment')
        break
      case 'settingsApi':
        openSettingsSection('api')
        break
      case 'settingsUi':
        openSettingsSection('ui')
        break
      case 'settingsCoverage':
        openSettingsSection('coverage')
        break
      case 'settingsKnowledge':
        openSettingsSection('knowledge')
        break
      case 'settingsAi':
        openSettingsSection('ai')
        break
    }
  })
  void refreshRuntime()
  void loadHistory().then(() => { if (form.projectPath) { void loadSuiteTree(); void loadSuites() } })
  void loadAiConfig()
  void loadEnvironments()
  // 断点恢复：从 localStorage 恢复 checkpoint
  restoreCheckpoint()
})
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

/** 置信度 → 中文标签（诊断先行架构，驱动分层自动决策）。 */
function confidenceLabel(confidence: string | undefined): string {
  return confidence === 'high' ? '高置信' : confidence === 'low' ? '低置信' : '未评估'
}

/** 诊断确认阶段暂存数据（host 发 phase:'diagnosis' 时存，用户确认后发 phase:'fix'）。 */
const diagnosisPending = ref<{ failedCases: NonNullable<TaskSnapshot['report']>['failedCases']; fixDecision?: { action: string; reason: string } } | null>(null)

// ===========================================================================
// Escalation 通道（片B：角色 escalation → GUI 弹窗 → 人答 → handler.reply）
// ===========================================================================

/** 待答 escalation 弹窗数据。 */
interface EscalationPending {
  escalationId: string
  role: string
  question: string
  fallback?: string
  context?: string
  executionId: string
}
const escalationPendings = ref<EscalationPending[]>([])
const escalationAnswers = ref<Record<string, string>>({})

/** 判定是否显示 escalation 弹窗（有 pending 即显示）。 */
function hasEscalationPending(): boolean {
  return escalationPendings.value.length > 0
}

/** 答复 escalation：发 IPC → main → host-cli → handler.reply。 */
async function replyEscalation(item: EscalationPending): Promise<void> {
  const answer = escalationAnswers.value[item.escalationId]?.trim() ?? ''
  if (!answer) return
  try {
    const ok = await window.testAgent.replyEscalation(item.executionId, item.escalationId, answer)
    if (ok) {
      // 移除已答弹窗
      escalationPendings.value = escalationPendings.value.filter((p) => p.escalationId !== item.escalationId)
      delete escalationAnswers.value[item.escalationId]
      pushLocalLog('success', `已答复 ${item.role} 的 escalation`)
    } else {
      // escalation 已超时/不存在，答复未送达
      pushLocalLog('warning', `escalation 已超时，答复未送达（${item.role} 已降级）`)
    }
  } catch (reason) {
    pushLocalLog('error', `答复 escalation 失败：${reason instanceof Error ? reason.message : '未知错误'}`)
  }
}

/** 按 escalation 降级（不答，接受 fallback）。 */
async function dismissEscalation(item: EscalationPending): Promise<void> {
  try {
    const ok = await window.testAgent.dismissEscalation(item.executionId, item.escalationId)
    if (!ok) {
      pushLocalLog('warning', `跳过未送达：${item.role} 的追问可能已超时或结束`)
      return
    }
    escalationPendings.value = escalationPendings.value.filter((p) => p.escalationId !== item.escalationId)
    delete escalationAnswers.value[item.escalationId]
    pushLocalLog('warning', `已跳过 ${item.role} 的追问，后台立即按保守方案继续`)
  } catch (reason) {
    pushLocalLog('error', `跳过追问失败：${reason instanceof Error ? reason.message : '未知错误'}`)
  }
}

// ===========================================================================
// Escalation 历史审计（懒加载 .test-agent/escalations/<hash>/audit.jsonl）
// ===========================================================================

/** 历史审计记录（跨任务，懒加载）。 */
const escalationAudit = ref<EscalationRecord[]>([])

/** 加载历史审计（按钮触发，不默认拉）。 */
async function loadEscalationAuditHistory(): Promise<void> {
  if (!form.projectPath) return
  try {
    escalationAudit.value = await window.testAgent.getEscalationAudit(form.projectPath)
  } catch (error) {
    pushLocalLog('error', `加载 escalation 审计失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

// ===========================================================================
// 缺陷联动（PRD 功能三：一键建单）
// ===========================================================================

/** 建单状态：defectKey → 状态。 */
interface DefectCreationState {
  status: 'idle' | 'creating' | 'success' | 'failed'
  defectId?: string
  defectUrl?: string
  error?: string
}
const defectStates = ref<Record<string, DefectCreationState>>({})

/** 生成唯一建单状态 key（用例名 + 索引，避免同名用例状态冲突）。 */
function defectKey(name: string, index: number): string {
  return `${name}#${index}`
}

/** 判定是否显示建单按钮（仅 real-bug）。PRD 7.5 场景C。 */
function shouldShowCreateDefectButton(category: string): boolean {
  return category === 'real-bug'
}

/** 组装 FailedCaseRecord → DefectCreateInput，发送到后端建单。PRD 7.5 场景A：截图作为附件上传。 */
async function createDefect(item: FailedCaseRecord, index: number): Promise<void> {
  const key = defectKey(item.name, index)
  if (defectStates.value[key]?.status === 'creating') return
  defectStates.value = {
    ...defectStates.value,
    [key]: { status: 'creating' },
  }
  try {
    const result = await window.testAgent.createDefect({
      title: item.name,
      description: item.error,
      evidence: item.evidence,
      suggestion: item.suggestion,
      caseName: item.name,
      category: item.category,
      ...(item.screenshot ? { screenshots: [item.screenshot], attachments: [item.screenshot] } : {}),
    })
    defectStates.value = {
      ...defectStates.value,
      [key]: {
        status: result.ok ? 'success' : 'failed',
        defectId: result.defectId,
        defectUrl: result.defectUrl,
        error: result.error,
      },
    }
  } catch (reason) {
    defectStates.value = {
      ...defectStates.value,
      [key]: {
        status: 'failed',
        error: reason instanceof Error ? reason.message : '建单失败',
      },
    }
  }
}

onBeforeUnmount(() => {
  if (activityClock) clearInterval(activityClock)
  if (planImpactTimer) clearTimeout(planImpactTimer)
  unsubscribeRoots?.()
  unsubscribeLocal?.()
  unsubscribeMenuNav?.()
  unsubscribeMenuCommand?.()
})
</script>

<template>
  <main class="shell shell-with-nav">
    <!-- ===== 工作台左导航（常显，P0 工作台布局） ===== -->
    <WorkspaceNav
      :view="view"
      :recent-projects="recentProjects"
      :project-path="form.projectPath"
      :suite-loading="suiteLoading"
      :suite-tree="suiteTree"
      :expanded-layers="expandedLayers"
      :plan-available="planAvailable"
      :plan-case-count="currentPlanCaseCount"
      @go="go"
      @open-plan-tab="openPlanTab"
      @open-dashboard="openDashboard"
      @select-project="selectProjectFromNav"
      @toggle-layer="toggleLayer"
    />
    <!-- ===== 中间工作区（包裹所有 view，flex:1） ===== -->
    <div class="workspace-main">
    <template v-if="view === 'home'">
      <div class="home-heading">
        <div>
          <h1 class="home-title">工作台</h1>
          <p>从一个明确的测试任务开始，先确认计划，再查看真实执行结果。</p>
        </div>
        <span class="home-host-state" :class="{ off: !localStatus.running }">{{ localStatus.running ? '本机 Host 就绪' : '本机 Host 未就绪' }}</span>
      </div>

      <!-- P1-0 必处理点2：进行中任务置顶卡（taskActive 时，高于项目卡片） -->
      <section v-if="taskActive" class="card active-task-card">
        <div class="active-task-info">
          <span class="active-task-dot">●</span>
          <span class="active-task-name">{{ form.projectPath ? basename(form.projectPath) : '当前任务' }}</span>
          <span class="active-task-phase">{{ phaseText() }}</span>
        </div>
        <div class="active-task-actions">
          <button class="btn btn-primary btn-sm" @click="go('run')">回到任务 →</button>
          <button class="btn btn-dark btn-sm" @click="cancelTask">取消</button>
        </div>
      </section>

      <!-- P1-0 必处理点1：首次用户无 history 空状态 → 快速开始升回主位 + 引导 -->
      <section v-if="!recentProjects.length && !form.projectPath" class="card hero-card quick-start-main">
        <div class="hero-head">
          <div>
            <h1>新建测试任务</h1>
            <p class="guide">选择本地项目和测试类型。AI 会先生成计划，确认后才开始执行。</p>
          </div>
          <div class="hero-actions">
            <button v-if="taskActive" class="btn btn-dark" @click="cancelTask">取消任务</button>
            <button v-if="canRerunCheckpoint" class="btn btn-primary" :disabled="starting" @click="rerunFromCheckpoint">{{ starting ? '启动中…' : retryStageLabel }}</button>
            <button v-if="canRerunCheckpoint && hasRestorablePlan" class="btn btn-soft" :disabled="starting" @click="requestRegeneratePlan">重新生成计划</button>
            <button v-if="!canRerunCheckpoint && !taskActive" class="btn btn-primary" :disabled="!canStart" :title="startBlockReason" @click="startTask">{{ starting ? '分析中…' : '生成测试计划' }}</button>
            <span v-if="!canStart && !taskActive && startBlockReason" class="start-block-reason" aria-live="polite">{{ startBlockReason }}</span>
          </div>
        </div>
        <div class="task-summary-bar" v-if="form.projectPath">
          <span>{{ basename(form.projectPath) }}</span>
          <span v-if="form.testTypes.length">· {{ form.testTypes.map(t => laneLabels[t]).join('/') }}</span>
          <span v-if="executionBackendLabel">· {{ executionBackendLabel }}</span>
          <span v-if="form.version">· {{ form.version }}</span>
        </div>
        <div class="setup-grid">
          <div class="field">
            <label>项目目录</label>
            <div class="project-field">
              <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
              <button class="btn btn-soft" @click="selectProject">选择</button>
            </div>
          </div>
          <div class="field">
            <label>系统</label>
            <input v-model="form.systemName" aria-label="系统名称" placeholder="自动识别" />
          </div>
          <div class="field">
            <label>版本</label>
            <input v-model="form.version" aria-label="版本" placeholder="Git 分支" />
          </div>
        </div>
        <div class="setup-meta">
          <button v-for="type in (['unit','regression','ui','api'] as TestType[])" :key="type" type="button" class="tag tag-button" :class="{ selected: form.testTypes.includes(type) }" :aria-pressed="form.testTypes.includes(type)" @click="toggleTestType(type)">{{ laneLabels[type] }}</button>
          <span class="hint">知识库：{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置' }}</span>
          <span v-if="error" class="error">{{ error }}</span>
        </div>
        <div v-if="form.testTypes.includes('ui') || form.testTypes.includes('api')" class="target-endpoint-grid">
          <label v-if="form.testTypes.includes('ui')" class="field"><span>UI 入口地址</span><input v-model="form.uiEntryUrl" type="url" placeholder="http://127.0.0.1:4173" /><small>可留空使用项目 Playwright 配置中的 webServer；生产验收建议明确填写。</small></label>
          <label v-if="form.testTypes.includes('api')" class="field"><span>API 基础地址 <b>必填</b></span><input v-model="form.apiBaseUrl" type="url" required placeholder="http://127.0.0.1:8080" /><small>接口用例会向此地址发送真实 HTTP 请求。</small></label>
          <label v-if="form.testTypes.includes('api')" class="field"><span>OpenAPI 文档</span><input v-model="form.openApiUrl" placeholder="http://127.0.0.1:8080/v3/api-docs 或绝对文件路径" /><small>可选，用于发现接口、参数和响应结构。</small></label>
        </div>
        <div v-if="isJavaProject && form.testTypes.some(type => type === 'unit' || type === 'regression')" class="setup-meta">
          <span class="meta-label">执行模式</span>
          <button type="button" class="tag tag-button" :class="{ selected: form.testStrategy === 'junit' }" :aria-pressed="form.testStrategy === 'junit'" @click="setTestStrategy('junit')">传统 JUnit（maven_test）</button>
          <button type="button" class="tag tag-button" :class="{ selected: form.testStrategy === 'reflect' }" :aria-pressed="form.testStrategy === 'reflect'" @click="setTestStrategy('reflect')">反射场景驱动（reflect_test）</button>
          <span class="hint">反射模式：LLM 生成 JSON 场景，确定性引擎执行（R1）</span>
        </div>
      </section>

      <!-- ===== P4-1-a：状态 B — 有项目 → 三入口行动卡 + 可折叠面板 ===== -->
      <template v-else>
        <section v-if="form.projectPath" class="card home-project-overview">
          <div>
            <span class="eyebrow">当前项目</span>
            <h2>{{ basename(form.projectPath) }}</h2>
            <p :title="form.projectPath">{{ form.projectPath }}</p>
          </div>
          <div class="home-project-facts">
            <span>{{ form.version || '未识别版本' }}</span>
            <span>用例库：{{ suiteTree.reduce((sum, node) => sum + node.cases.length, 0) }} 条</span>
            <span v-if="plannedCases.length">本次计划：{{ plannedCases.length }} 条</span>
          </div>
        </section>
        <div class="section-head home-section-head"><h2>开始测试</h2><span class="hint">选择一种适合当前任务的方式</span></div>
        <!-- 三入口平级行动卡 -->
        <div class="home-action-row">
          <button class="card action-card" :class="{ 'action-card-selected': showAiForm }" :disabled="taskActive" :aria-expanded="showAiForm" aria-controls="home-ai-task-form" @click="showAiForm = !showAiForm; showQuickReflect = false">
            <span class="action-kicker">推荐 · 先计划后执行</span>
            <h2>发起 AI 测试</h2>
            <p>分析项目、生成可审阅用例，确认范围后执行。</p>
            <span class="action-link">{{ showAiForm ? '收起设置 ↑' : '设置测试任务 →' }}</span>
          </button>
          <button class="card action-card" @click="go('suites')">
            <span class="action-kicker">已有测试资产</span>
            <h2>运行回归套件</h2>
            <p>选择保存的用例组合，直接运行回归。</p>
            <span class="action-link">选择套件 →</span>
          </button>
          <button class="card action-card" :class="{ 'action-card-selected': showQuickReflect }" :aria-expanded="showQuickReflect" @click="showQuickReflect = !showQuickReflect; showAiForm = false">
            <span class="action-kicker">高级快捷入口</span>
            <h2>场景直跑</h2>
            <p>已有结构化场景时，不经过 AI 生成步骤。</p>
            <span class="action-link">{{ showQuickReflect ? '收起场景 ↑' : '填写场景 →' }}</span>
          </button>
        </div>

        <!-- 写场景直跑面板（P4-1-b 组件，折叠/展开） -->
        <QuickReflectRun
          v-if="showQuickReflect"
          :project-path="form.projectPath"
          @close="showQuickReflect = false"
        />

        <!-- AI 测试表单（原 hero 卡完整表单，可折叠；建议 1：整块搬不省略） -->
        <section v-if="showAiForm" id="home-ai-task-form" class="card hero-card quick-start-main">
          <div class="hero-head">
            <div>
              <h2>测试任务设置</h2>
              <p class="guide">选择测试对象与类型。下一步会先生成计划供你确认，不会直接执行测试。</p>
            </div>
            <div class="hero-actions">
              <button v-if="taskActive" class="btn btn-dark" @click="cancelTask">取消任务</button>
              <button v-if="canRerunCheckpoint" class="btn btn-primary" :disabled="starting" @click="rerunFromCheckpoint">{{ starting ? '启动中…' : retryStageLabel }}</button>
              <button v-if="canRerunCheckpoint && hasRestorablePlan" class="btn btn-soft" :disabled="starting" @click="requestRegeneratePlan">重新生成计划</button>
              <button v-if="!canRerunCheckpoint && !taskActive" class="btn btn-primary" :disabled="!canStart" :title="startBlockReason" @click="startTask">{{ starting ? '分析中…' : '生成测试计划' }}</button>
            </div>
          </div>
          <div class="task-summary-bar" v-if="form.projectPath">
            <span>{{ basename(form.projectPath) }}</span>
            <span v-if="form.testTypes.length">· {{ form.testTypes.map(t => laneLabels[t]).join('/') }}</span>
            <span v-if="executionBackendLabel">· {{ executionBackendLabel }}</span>
            <span v-if="form.version">· {{ form.version }}</span>
          </div>
          <div class="setup-grid">
            <div class="field">
              <label>项目目录</label>
              <div class="project-field">
                <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
                <button class="btn btn-soft" @click="selectProject">选择</button>
              </div>
            </div>
            <div class="field">
              <label>系统</label>
              <input v-model="form.systemName" aria-label="系统名称" placeholder="自动识别" />
            </div>
            <div class="field">
              <label>版本</label>
              <input v-model="form.version" aria-label="版本" placeholder="Git 分支" />
            </div>
          </div>
          <div class="setup-meta">
            <span v-for="type in (['unit','regression','ui','api'] as TestType[])" :key="type" class="tag" :class="{ selected: form.testTypes.includes(type) }" @click="toggleTestType(type)">{{ laneLabels[type] }}</span>
            <span class="hint">知识库：{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置' }}</span>
            <span v-if="error" class="error">{{ error }}</span>
          </div>
          <div v-if="form.testTypes.includes('ui') || form.testTypes.includes('api')" class="target-endpoint-grid">
            <label v-if="form.testTypes.includes('ui')" class="field"><span>UI 入口地址</span><input v-model="form.uiEntryUrl" type="url" placeholder="http://127.0.0.1:4173" /><small>可留空使用项目 Playwright 配置中的 webServer；生产验收建议明确填写。</small></label>
            <label v-if="form.testTypes.includes('api')" class="field"><span>API 基础地址 <b>必填</b></span><input v-model="form.apiBaseUrl" type="url" required placeholder="http://127.0.0.1:8080" /><small>接口用例会向此地址发送真实 HTTP 请求。</small></label>
            <label v-if="form.testTypes.includes('api')" class="field"><span>OpenAPI 文档</span><input v-model="form.openApiUrl" placeholder="http://127.0.0.1:8080/v3/api-docs 或绝对文件路径" /><small>可选，用于发现接口、参数和响应结构。</small></label>
          </div>
          <div v-if="isJavaProject && form.testTypes.some(type => type === 'unit' || type === 'regression')" class="setup-meta">
            <span class="meta-label">执行模式</span>
            <span class="tag" :class="{ selected: form.testStrategy === 'junit' }" @click="setTestStrategy('junit')">传统 JUnit（maven_test）</span>
            <span class="tag" :class="{ selected: form.testStrategy === 'reflect' }" @click="setTestStrategy('reflect')">反射场景驱动（reflect_test）</span>
            <span class="hint">反射模式：LLM 生成 JSON 场景，确定性引擎执行（R1）</span>
          </div>
        </section>

        <!-- 我的测试项目（recentProjects 去重，与左导航同源） -->
        <div v-if="recentProjects.length" class="section-head"><h2>最近项目</h2><span class="hint">{{ recentProjects.length }} 个</span></div>
        <div v-if="recentProjects.length" class="project-card-row">
          <button v-for="p in recentProjects" :key="p.projectPath" class="card project-card" :class="{ active: form.projectPath === p.projectPath }" @click="selectProjectFromNav(p)">
            <div class="project-card-name">{{ p.projectName || basename(p.projectPath) }}</div>
            <div class="project-card-meta">{{ p.version || '—' }} · {{ projectCaseCount(p) }} 用例<span v-if="projectSuiteCount(p)"> · {{ projectSuiteCount(p) }} 套件</span></div>
            <div class="project-card-time">上次运行 {{ relativeTime(p.savedAt) }}</div>
          </button>
        </div>

        <!-- 质量概览 stat bar -->
        <div class="section-head"><h2>📊 质量概览</h2><span class="hint">最近运行 {{ history.length }} 次</span></div>
        <div class="stat-grid">
          <div class="card stat"><div class="num" :class="overview?.gate?.passed ? 'green' : overview?.gate ? 'red' : ''">{{ overview?.gate ? (overview.gate.passed ? '通过' : '未通过') : '--' }}</div><div class="lbl">质量门禁</div></div>
          <div class="card stat"><div class="num">{{ overviewQuality }}</div><div class="lbl">质量分</div></div>
          <div class="card stat"><div class="num">{{ history.length }}</div><div class="lbl">运行次数</div></div>
        </div>

        <!-- 最近运行（跨项目时间流 + 阶段状态 + 产物 chips） -->
        <template v-if="recentRuns.length">
          <div class="section-head"><h2>🕒 最近运行</h2><span class="hint">{{ recentRuns.length }} 次</span></div>
          <div class="recent-run-list">
            <div v-for="h in recentRuns" :key="h.id" class="card recent-run-card" @click="openHistory(h)">
              <div class="recent-run-head">
                <span class="recent-run-name">{{ h.projectName || basename(h.projectPath) }}</span>
                <span class="recent-run-branch">{{ h.version || '—' }}</span>
                <span class="recent-run-time">{{ relativeTime(h.savedAt) }}</span>
                <span class="recent-run-status" :class="h.snapshot.status">{{ runStatusText(h) }}</span>
              </div>
              <div class="recent-run-body">
                <span v-if="h.snapshot.report" class="recent-run-stat green">✅{{ h.snapshot.report.passed }}</span>
                <span v-if="h.snapshot.report" class="recent-run-stat" :class="{ red: h.snapshot.report.failed }">❌{{ h.snapshot.report.failed }}</span>
                <span v-if="h.snapshot.report && h.snapshot.report.coverage !== null" class="recent-run-stat">📈{{ h.snapshot.report.coverage }}%</span>
                <span v-for="chip in runArtifacts(h)" :key="chip.key" class="recent-run-chip" @click.stop="onChipClick(h, chip.key)" :title="chip.key === 'cases' ? '查看用例集' : '查看报告'">{{ chip.icon }} {{ chip.label }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 覆盖率趋势（保留） -->
        <section v-if="coverageTrend.length" class="card panel trend-card">
          <div class="section-head" style="margin-top:0"><h2>覆盖率趋势</h2><span class="hint">最近 {{ coverageTrend.length }} 次</span></div>
          <div class="trend-chart">
            <div v-for="(point, index) in coverageTrend" :key="index" class="trend-bar-wrap">
              <div class="trend-bar" :style="{ height: `${point.coverage}%` }"></div>
              <span class="trend-value">{{ point.coverage }}%</span>
              <span class="trend-label">{{ point.label }}</span>
            </div>
          </div>
        </section>
      </template>

      <template v-if="report">
        <div class="section-head"><h2>PR 评论</h2><button class="btn btn-soft" @click="copyPrComment">复制评论</button></div>
        <pre class="pr-comment">{{ prComment }}</pre>
      </template>

      <footer v-if="localStatus.running" class="footer">{{ runtime.message }}</footer>
    </template>

    <div v-else-if="view === 'plan'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">用例与计划</h1>
      <p class="detail-sub">{{ planPending ? 'AI 已生成计划草案。请核对范围和用例，确认后才会执行测试。' : '查看已生成的测试用例与执行范围。' }}</p>
      <p v-if="error" class="plan-error" role="alert">{{ error }}</p>
      <div class="plan-collection-tabs" role="tablist" aria-label="用例清单类型">
        <button role="tab" :aria-selected="planCollectionTab === 'current'" :class="{ active: planCollectionTab === 'current' }" @click="planCollectionTab = 'current'">
          <span>本次计划</span><strong>{{ currentPlanCaseCount }}</strong><small>核对、编辑并选择执行范围</small>
        </button>
        <button role="tab" :aria-selected="planCollectionTab === 'saved'" :class="{ active: planCollectionTab === 'saved' }" @click="planCollectionTab = 'saved'">
          <span>已保存用例</span><strong>{{ libraryCases.length }}</strong><small>跨任务复用和回归执行</small>
        </button>
      </div>
      <section v-if="planCollectionTab === 'saved'" class="card library-panel">
        <div class="library-panel-head">
          <div><span class="eyebrow">项目用例库</span><h2>{{ libraryCases.length }} 条已保存用例</h2><p>全量执行会运行项目全部测试；部分执行只运行勾选且带反射场景的用例。</p></div>
          <div class="library-panel-actions">
            <button class="btn btn-soft library-reset-button" :disabled="libraryRunBusy" @click="resetLibraryForNewAnalysis">清空用例库并重新开始</button>
            <button class="btn btn-dark" :disabled="libraryRunBusy" @click="runAllLibraryTests">{{ libraryRunBusy ? '执行中…' : '运行全部项目测试' }}</button>
          </div>
        </div>
        <div class="library-selection-bar">
          <span>已选 {{ librarySelectedCaseIds.length }} 条，可统一运行单元、API 和 UI 回归；其中 {{ selectedReflectLibraryCases.length }} 条支持无 AI 快速反射执行</span>
          <button class="btn btn-primary" :disabled="libraryRunBusy || !selectedLibraryCases.length" @click="runSelectedLibraryCases">运行已选用例（{{ selectedLibraryCases.length }}）</button>
          <button class="btn btn-soft" :disabled="libraryRunBusy || !selectedReflectLibraryCases.length" @click="runSelectedLibraryReflect">快速运行反射场景</button>
        </div>
        <div class="library-case-list">
          <div v-if="!libraryCases.length && !suiteLoading" class="plan-case-empty">当前项目还没有已保存用例。先在“本次计划”中核对用例，再选择“仅保存用例”或执行测试。</div>
          <div v-for="item in libraryCases" :key="item.id" class="library-case-row">
            <input type="checkbox" :checked="librarySelectedCaseIds.includes(item.id)" @change="librarySelectedCaseIds = librarySelectedCaseIds.includes(item.id) ? librarySelectedCaseIds.filter(id => id !== item.id) : [...librarySelectedCaseIds, item.id]" />
            <span class="library-case-main"><strong>{{ item.title }}</strong><small>{{ item.id }} · {{ item.layer ?? '未分类' }}</small></span>
            <span :class="['library-case-capability', 'ready']">{{ item.layer === 'api' ? 'API 契约回归' : item.layer === 'ui' ? 'UI 浏览器回归' : hasScenarioFlag(item) ? '可反射执行' : 'Agent/JUnit 回归' }}</span>
            <button class="library-case-delete" :aria-label="`删除用例 ${item.title}`" @click="deleteLibraryCase(item)">删除</button>
          </div>
        </div>
      </section>
      <template v-else>
      <section class="card plan-overview">
        <div class="plan-overview-header">
          <div><span class="eyebrow">{{ planPending ? '等待人工确认' : '计划记录' }}</span><h2>{{ form.systemName || (form.projectPath ? basename(form.projectPath) : '当前项目') }}</h2></div>
          <span class="plan-count">本次计划 {{ visiblePlanCases.length || report?.casesMeta?.count || 0 }} 条</span>
        </div>
        <div class="plan-overview-grid">
          <div><span>测试类型</span><strong>{{ form.testTypes.map(t => laneLabels[t]).join('、') || '未指定' }}</strong></div>
          <div><span>执行方式</span><strong>{{ form.testStrategy === 'reflect' ? '反射场景驱动' : 'JUnit / Maven' }}</strong></div>
          <div><span>提交给 Agent</span><strong>{{ executionScope === 'full' ? '全部计划用例' : executionScope === 'incremental' ? '增量匹配用例' : `已勾选 ${selectedPlanCases.length} 条` }}</strong></div>
          <div v-if="report"><span>工具实际执行</span><strong>{{ executedToolTestCount }} 个测试</strong></div>
        </div>
        <p v-if="planPending" class="plan-overview-note">计划范围只约束交给 Agent 的用例。JUnit / Maven 等底层验证命令可能仍会运行项目已有的其他测试，不能保证命令级隔离。</p>
        <div v-if="planPending" class="plan-impact-preview" aria-live="polite">
          <span v-if="planImpactLoading">正在预估拟执行用例…</span>
          <span v-else-if="planImpactError" class="plan-impact-warning">预估失败：{{ planImpactError }}。可改选全量执行。</span>
          <template v-else-if="planImpactPreview">
            <strong>拟执行 {{ planImpactPreview.selected }} 条</strong><span>不执行 {{ planImpactPreview.skipped }} 条</span>
            <span v-if="executionScope === 'incremental'">检测到 {{ planImpactPreview.changedFilesCount }} 个变更文件</span>
            <span v-if="planImpactPreview.fallbackReason">{{ planImpactPreview.fallbackReason }}</span>
            <span v-if="planImpactPreview.selected === 0" class="plan-impact-warning">零命中，不能开始执行；请改为全量或调整用例目标。</span>
          </template>
        </div>
      </section>
      <details class="card plan-cases-panel" open>
        <summary>本次计划用例 <span>{{ visiblePlanCases.length }} 条 · 可核对目标、场景和预期结果</span></summary>
        <div class="plan-case-toolbar">
          <input v-model="planCaseQuery" type="search" class="cell-input plan-case-search" aria-label="搜索用例" placeholder="搜索用例、场景、预期或目标…" />
          <select v-model="planCaseLayer" class="cell-select" aria-label="按层级筛选"><option value="all">全部层级</option><option value="unit">单元测试</option><option value="api">接口测试</option><option value="ui">UI 测试</option></select>
          <select v-model="planCasePriority" class="cell-select" aria-label="按优先级筛选"><option value="all">全部优先级</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select>
          <span class="plan-case-result">显示 {{ filteredPlanCaseRows.length }} / {{ planCaseRows.length }} 条</span>
        </div>
        <div v-if="planPending && planCaseRows.length" class="plan-case-bulk">
          <label><input type="checkbox" :checked="currentPageFullySelected" @change="toggleCurrentPageCases" /> 全选当前页</label>
          <template v-if="selectedPlanCaseIds.length">
            <strong>已选 {{ selectedPlanCaseIds.length }} 条</strong>
            <select v-model="bulkCasePriority" class="cell-select" aria-label="批量修改优先级" @change="bulkUpdateCases('priority', bulkCasePriority)"><option value="">修改优先级…</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select>
            <select v-model="bulkCaseLayer" class="cell-select" aria-label="批量修改层级" @change="bulkUpdateCases('layer', bulkCaseLayer)"><option value="">修改层级…</option><option value="unit">单元测试</option><option value="api">接口测试</option><option value="ui">UI 测试</option></select>
            <button class="btn btn-soft btn-sm plan-bulk-delete" @click="bulkDeleteCases">删除所选</button>
            <button class="btn btn-soft btn-sm" @click="selectedPlanCaseIds = []">清空选择</button>
          </template>
        </div>
        <div v-if="!filteredPlanCaseRows.length" class="plan-case-empty">{{ planCaseRows.length ? '没有匹配的用例，试试调整搜索或筛选条件。' : '暂无结构化用例。' }}</div>
        <div v-for="{ item, index } in visiblePlanCaseRows" :key="item.id" class="plan-case-item">
          <div class="plan-case-row">
            <input v-if="planPending" type="checkbox" :checked="selectedPlanCaseIds.includes(item.id)" :aria-label="`选择用例 ${item.title}`" @change="selectedPlanCaseIds = selectedPlanCaseIds.includes(item.id) ? selectedPlanCaseIds.filter(id => id !== item.id) : [...selectedPlanCaseIds, item.id]" />
            <button class="plan-case-open" :aria-expanded="expandedPlanCaseId === item.id" @click="expandedPlanCaseId = expandedPlanCaseId === item.id ? null : item.id"><span class="plan-case-chevron">{{ expandedPlanCaseId === item.id ? '▾' : '▸' }}</span><span class="plan-case-title">{{ item.title }}</span></button>
            <span class="plan-case-tag">{{ item.layer === 'unit' ? '单元' : item.layer === 'api' ? '接口' : item.layer === 'ui' ? 'UI' : '未分类' }}</span>
            <span class="plan-case-tag" :class="`priority-${item.priority}`">{{ item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低' }}</span>
          </div>
          <div v-if="expandedPlanCaseId === item.id" class="plan-case-detail">
            <label>用例名称<input v-if="planPending" :value="item.title" class="cell-input" @change="updateCase(index, 'title', ($event.target as HTMLInputElement).value)" /><span v-else>{{ item.title }}</span></label>
            <div class="plan-case-meta">
              <label>用例编号<input v-if="planPending" :value="item.id" class="cell-input" @change="updateCase(index, 'id', ($event.target as HTMLInputElement).value)" /><span v-else>{{ item.id }}</span></label>
              <label>层级<select v-if="planPending" :value="item.layer ?? ''" class="cell-select" @change="updateCase(index, 'layer', ($event.target as HTMLSelectElement).value)"><option value="">未分类</option><option value="unit">单元测试</option><option value="api">接口测试</option><option value="ui">UI 测试</option></select><span v-else>{{ item.layer ?? '未分类' }}</span></label>
              <label>优先级<select v-if="planPending" :value="item.priority" class="cell-select" @change="updateCase(index, 'priority', ($event.target as HTMLSelectElement).value)"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select><span v-else>{{ item.priority }}</span></label>
            </div>
            <div class="plan-case-text-fields">
              <label>场景<textarea v-if="planPending" :value="item.scenario" rows="3" class="cell-input" @change="updateCase(index, 'scenario', ($event.target as HTMLTextAreaElement).value)"></textarea><span v-else>{{ item.scenario }}</span></label>
              <label>预期结果<textarea v-if="planPending" :value="item.expected" rows="3" class="cell-input" @change="updateCase(index, 'expected', ($event.target as HTMLTextAreaElement).value)"></textarea><span v-else>{{ item.expected }}</span></label>
            </div>
            <div v-if="item.layer === 'api'" class="scenario-panel api-contract-panel">
              <div class="scenario-panel-head"><span class="scenario-label">可执行 API 契约</span><small>这些字段会直接控制真实 HTTP 请求和响应校验</small></div>
              <div class="plan-case-meta">
                <label>请求方法<select v-if="planPending" :value="item.method ?? ''" class="cell-select" @change="updateCase(index, 'method', ($event.target as HTMLSelectElement).value)"><option value="">请选择</option><option v-for="method in ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']" :key="method" :value="method">{{ method }}</option></select><span v-else>{{ item.method ?? '未填写' }}</span></label>
                <label>接口路径<input v-if="planPending" :value="item.path ?? ''" class="cell-input" placeholder="/api/orders" @change="updateCase(index, 'path', ($event.target as HTMLInputElement).value)" /><span v-else>{{ item.path ?? '未填写' }}</span></label>
                <label>期望状态码<input v-if="planPending" :value="item.expectedStatus ?? ''" class="cell-input" type="number" min="100" max="599" @change="updateCase(index, 'expectedStatus', ($event.target as HTMLInputElement).value)" /><span v-else>{{ item.expectedStatus ?? '未填写' }}</span></label>
              </div>
              <div class="plan-case-text-fields">
                <label>请求体（JSON 对象）<textarea v-if="planPending" :value="item.body ? JSON.stringify(item.body, null, 2) : ''" rows="5" class="cell-input" placeholder="{&quot;name&quot;:&quot;示例&quot;}" @change="updateApiJsonField(index, 'body', ($event.target as HTMLTextAreaElement).value)"></textarea><pre v-else class="scenario-json">{{ item.body ? JSON.stringify(item.body, null, 2) : '无' }}</pre></label>
                <label>响应必须包含（每行一个）<textarea v-if="planPending" :value="item.expectedBodyContains?.join('\n') ?? ''" rows="5" class="cell-input" placeholder="success" @change="updateCase(index, 'expectedBodyContains', ($event.target as HTMLTextAreaElement).value)"></textarea><span v-else>{{ item.expectedBodyContains?.join('；') || '无' }}</span></label>
                <label>响应 JSON 子集<textarea v-if="planPending" :value="item.expectedJsonSubset ? JSON.stringify(item.expectedJsonSubset, null, 2) : ''" rows="5" class="cell-input" placeholder="{&quot;status&quot;:&quot;ok&quot;}" @change="updateApiJsonField(index, 'expectedJsonSubset', ($event.target as HTMLTextAreaElement).value)"></textarea><pre v-else class="scenario-json">{{ item.expectedJsonSubset ? JSON.stringify(item.expectedJsonSubset, null, 2) : '无' }}</pre></label>
              </div>
            </div>
            <div v-if="hasStructuredScenario(item)" class="scenario-panel">
                <div class="scenario-panel-head">
                  <span class="scenario-label">JSON 场景</span>
                  <template v-if="!scenarioEditState[item.id]">
                    <button class="btn btn-soft btn-sm" @click="startEditScenario(item)">编辑</button>
                    <button class="btn btn-soft btn-sm" @click="copyScenarioJson(item)">复制</button>
                  </template>
                  <template v-else>
                    <button class="btn btn-primary btn-sm" @click="saveScenarioEdit(item, true)">保存到 .test-agent/scenarios/</button>
                    <button class="btn btn-soft btn-sm" @click="saveScenarioEdit(item, false)">仅本次运行</button>
                    <button class="btn btn-dark btn-sm" @click="cancelEditScenario(item.id)">取消</button>
                  </template>
                </div>
                <pre v-if="!scenarioEditState[item.id]" class="scenario-json">{{ JSON.stringify(item.structuredScenario, null, 2) }}</pre>
                <textarea v-else v-model="scenarioEditState[item.id].raw" class="scenario-editor" rows="14"></textarea>
                <div v-if="scenarioEditState[item.id]?.errors.length" class="scenario-errors">
                  <div v-for="err in scenarioEditState[item.id].errors" :key="err">⚠ {{ err }}</div>
                </div>
            </div>
            <button v-if="planPending" class="btn btn-soft btn-sm plan-bulk-delete" @click="deleteCase(index); selectedPlanCaseIds = selectedPlanCaseIds.filter(id => id !== item.id)">删除此用例</button>
          </div>
        </div>
        <nav v-if="planCasePageCount > 1" class="plan-case-pagination" aria-label="用例分页">
          <button class="btn btn-soft btn-sm" :disabled="planCasePage <= 1" @click="planCasePage--">上一页</button>
          <span>第 {{ planCasePage }} / {{ planCasePageCount }} 页</span>
          <button class="btn btn-soft btn-sm" :disabled="planCasePage >= planCasePageCount" @click="planCasePage++">下一页</button>
        </nav>
      </details>
      <section v-if="planPending || (visiblePlanCases.length && form.projectPath)" class="card plan-command-panel">
        <div class="plan-command-heading">
          <div><span class="eyebrow">下一步</span><h2>{{ planPending ? '核对计划并选择后续动作' : hasRestorablePlan ? '当前计划尚未执行' : '保存测试资产' }}</h2></div>
          <div class="plan-command-utilities">
            <button v-if="planPending" class="btn btn-soft" @click="addCase">添加用例</button>
          </div>
        </div>
        <div v-if="suiteSaveMode" class="plan-suite-save">
          <input v-model="suiteSaveName" class="cell-input" aria-label="回归套件名称" placeholder="套件名称，如订单服务核心回归" />
          <button class="btn btn-primary btn-sm" :disabled="!suiteSaveName.trim()" @click="saveSuiteFromCurrent">保存套件</button>
          <button class="btn btn-soft btn-sm" @click="suiteSaveMode = false; suiteSaveName = ''">取消</button>
        </div>
        <div v-if="planPending && plannedCases.length" class="plan-command-footer">
          <fieldset class="plan-scope-options"><legend>执行范围</legend>
            <label :class="{ selected: executionScope === 'full' }"><input v-model="executionScope" type="radio" value="full" /><span><strong>全量执行 · 推荐</strong><small>按确认的计划用例执行</small></span></label>
            <label :class="{ selected: executionScope === 'incremental' }"><input v-model="executionScope" type="radio" value="incremental" /><span><strong>增量执行</strong><small>仅运行匹配变更文件的用例；零命中时暂停</small></span></label>
            <label :class="{ selected: executionScope === 'selected' }"><input v-model="executionScope" type="radio" value="selected" /><span><strong>仅处理已勾选用例（{{ selectedPlanCases.length }} 条）</strong><small>只把勾选项交给 Agent；底层测试命令可能覆盖更多已有测试</small></span></label>
          </fieldset>
          <div class="plan-primary-actions">
            <details class="plan-more-actions">
              <summary>更多操作</summary>
              <div class="plan-more-menu">
                <button type="button" @click="suiteSaveMode = true">保存为回归套件</button>
                <button type="button" @click="requestRegeneratePlan">重新生成计划</button>
                <button type="button" @click="cancelPlan">取消当前计划</button>
              </div>
            </details>
            <button class="btn btn-soft" :disabled="planSaveBusy" @click="saveCurrentPlanToLibrary">{{ planSaveBusy ? '保存中…' : '仅保存用例' }}</button>
            <button class="btn btn-primary" :disabled="starting || !!invalidPlanCases.length || (executionScope === 'selected' && selectedPlanCases.length === 0) || (executionScope === 'incremental' && (planImpactLoading || !planImpactPreview || planImpactPreview.selected === 0))" @click="confirmExecution">{{ starting ? '启动中…' : '生成测试代码并执行' }}</button>
          </div>
        </div>
        <div v-else-if="hasRestorablePlan" class="plan-command-footer">
          <p>继续后会生成测试代码、运行 Maven，并在执行结束后自动保存用例。</p>
          <div class="plan-primary-actions">
            <details class="plan-more-actions">
              <summary>更多操作</summary>
              <div class="plan-more-menu">
                <button type="button" @click="suiteSaveMode = true">保存为回归套件</button>
                <button type="button" @click="requestRegeneratePlan">重新生成计划</button>
              </div>
            </details>
            <button class="btn btn-soft" :disabled="planSaveBusy" @click="saveCurrentPlanToLibrary">{{ planSaveBusy ? '保存中…' : '仅保存用例' }}</button>
            <button class="btn btn-primary" :disabled="!canRerunCheckpoint || starting" @click="rerunFromCheckpoint">{{ starting ? '启动中…' : '生成测试代码并执行' }}</button>
          </div>
        </div>
        <p v-if="planSaveMessage" class="library-run-success" role="status">{{ planSaveMessage }}</p>
        <p v-if="planSaveError" class="plan-error" role="alert">{{ planSaveError }}</p>
        <p v-if="planPending && invalidPlanCases.length" class="plan-error" role="alert">实际执行范围内有 {{ invalidPlanCases.length }} 条用例信息不完整。请补齐编号、名称、步骤、场景和预期；API 用例还必须填写方法、路径、状态码及至少一种响应内容断言。</p>
        <p v-else-if="planPending && executionScope === 'selected' && selectedPlanCases.length === 0" class="plan-error" role="alert">请先在上方勾选至少一条要交给 Agent 的用例。</p>
      </section>
      </template>
    </div>

    <div v-else-if="view === 'run'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">执行过程</h1>
      <p class="detail-sub">{{ form.systemName || (form.projectPath ? basename(form.projectPath) : '尚未启动任务') }}<span v-if="localTaskId"> · 任务 ID {{ localTaskId }}</span></p>
      <TaskJourney v-if="localTaskId || snapshot?.taskId" :steps="journeySteps" />
      <section v-if="libraryRunActive" class="card run-status-panel library-execution-panel">
        <div class="run-status-head">
          <div>
            <span class="eyebrow">本地项目测试</span>
            <h2>{{ libraryRunBusy ? (libraryRunKind === 'all' ? '正在运行全部项目测试' : libraryRunKind === 'reflect' ? '正在运行所选反射场景' : '正在运行保存的前后端用例') : libraryRunError ? '测试执行失败' : '测试执行完成' }}</h2>
          </div>
          <button v-if="!libraryRunBusy" class="btn btn-soft" @click="go('plan')">返回用例与计划</button>
        </div>
        <p>{{ libraryRunKind === 'all' ? '执行范围：项目现有全部测试' : libraryRunKind === 'reflect' ? `执行范围：严格限定为 ${selectedReflectLibraryCases.length} 条已选反射场景` : `执行范围：${completedPlannedCases.length} 条已保存用例（单元/API/UI 统一执行）` }}</p>
        <p v-if="libraryRunBusy" class="library-run-progress" role="status">测试命令执行中，请等待结果…</p>
        <p v-if="libraryRunError" class="plan-error" role="alert">{{ libraryRunError }}</p>
        <p v-if="libraryRunMessage" class="library-run-success" role="status">{{ libraryRunMessage }}</p>
        <details v-if="libraryRunOutput" class="library-run-details" :open="!!libraryRunError"><summary>{{ libraryRunError ? '失败详情与完整 Maven 输出' : '查看完整 Maven 输出' }}</summary><pre>{{ libraryRunOutput }}</pre></details>
        <div v-if="libraryReflectResults.length" class="library-reflect-results">
          <div v-for="item in libraryReflectResults" :key="item.name" :class="['library-result-row', item.ok ? 'passed' : 'failed']"><strong>{{ item.name }}</strong><span>{{ item.ok ? '通过' : item.error || '失败' }}</span></div>
        </div>
      </section>
      <section v-if="!localTaskId && !snapshot?.taskId && !libraryRunActive" class="card page-empty-state">
        <template v-if="hasRestorablePlan">
          <span class="eyebrow">已恢复测试计划</span>
          <h2>{{ completedPlannedCases.length }} 条计划等待继续执行</h2>
          <p>无需重新分析项目。继续后将使用已确认的计划生成或运行测试代码。</p>
          <button class="btn btn-primary" :disabled="!canRerunCheckpoint || starting" @click="rerunFromCheckpoint">{{ starting ? '启动中…' : retryStageLabel }}</button>
          <button class="btn btn-soft" :disabled="starting" @click="requestRegeneratePlan">重新生成计划</button>
        </template>
        <template v-else>
          <span class="eyebrow">尚无运行中的任务</span>
          <h2>执行进度会在任务开始后显示</h2>
          <p>先从工作台生成并确认测试计划；执行后可在这里查看测试结果和后续诊断状态。</p>
          <button class="btn btn-primary" @click="go('home')">返回工作台</button>
        </template>
      </section>
      <div v-if="testExecutionSummary" class="card panel" style="margin-bottom:16px;border-left:4px solid var(--amber)">
        <strong>测试命令已结束：{{ testExecutionSummary.passed }} 通过、{{ testExecutionSummary.failed }} 失败。</strong>
        <span class="hint">{{ taskActive ? '任务仍在处理诊断或报告，尚未全部完成。' : '任务已结束，请查看最终报告或失败状态。' }}</span>
      </div>

      <!-- 中断恢复：从当前阶段起点重跑；scout 尚无产物时从项目分析重新开始。 -->
      <div v-if="canRerunCheckpoint && (localTaskId || snapshot?.taskId)" class="card panel" style="margin-bottom:16px;border-left:4px solid var(--amber);display:flex;align-items:center;gap:12px">
        <span style="font-weight:600">任务已中断。{{ currentPhase === 'scout' ? '项目分析尚无可续接的产物，需要重新分析。' : '已保留前一阶段产物，可重跑当前阶段。' }}</span>
        <button class="btn btn-primary" :disabled="starting" @click="rerunFromCheckpoint">{{ starting ? '启动中…' : retryStageLabel }}</button>
      </div>

      <!-- ===== P0 项3：执行控制条（单场景重跑，针对反射用例） ===== -->
      <div v-if="rerunnableCases.length" class="card panel exec-controls">
        <div class="section-head" style="margin-top:0"><h2 style="font-size:15px">执行控制</h2></div>
        <div class="exec-controls-row">
          <select v-model="rerunTargetCaseId" class="cell-select" aria-label="选择重跑用例">
            <option value="">选择用例…</option>
            <option v-for="c in rerunnableCases" :key="c.id" :value="c.id">{{ c.title }}（{{ c.id }}）</option>
          </select>
          <button class="btn btn-primary" :disabled="!rerunTargetCaseId || rerunRunning" @click="rerunScenario">{{ rerunRunning ? '重跑中…' : '↻ 单场景重跑' }}</button>
          <span class="hint">main 本地 spawn mvn，不进 control-server（5min 超时）</span>
        </div>
        <div v-if="rerunError" class="error">⚠ {{ rerunError }}</div>
        <pre v-if="rerunOutput" class="rerun-output">{{ rerunOutput }}</pre>
        <!-- P3-5：用例跳过控制（标记后重跑时排除） -->
        <div v-if="rerunnableCases.length" class="skip-controls">
          <div class="skip-controls-head"><span class="hint">跳过用例（标记后重跑/继续时排除）</span></div>
          <div class="skip-cases-list">
            <label v-for="c in rerunnableCases" :key="c.id" class="skip-case-item" :class="{ skipped: isCaseSkipped(c.id) }">
              <input type="checkbox" :checked="isCaseSkipped(c.id)" @change="toggleSkipCase(c.id)" />
              <span class="skip-case-id">{{ c.id }}</span>
              <span class="skip-case-title">{{ c.title }}</span>
              <span v-if="isCaseSkipped(c.id)" class="skip-badge">⏭ 已跳过</span>
            </label>
          </div>
        </div>
      </div>

      <section v-if="localTaskId || snapshot?.taskId" class="card run-status-panel">
        <div class="run-status-head">
          <div><span class="eyebrow">任务状态</span><h2>{{ taskStatusSummary }}</h2></div>
          <div class="run-status-actions">
            <button v-if="taskActive" class="btn btn-soft run-interrupt" title="取消当前运行，之后可从本阶段起点重新执行" @click="pauseTask">中断当前阶段</button>
          </div>
        </div>
        <p v-if="!terminalFailureReason">{{ taskStatusDetail }}</p>
        <p v-if="terminalFailureReason" class="run-failure-reason" role="alert"><strong>失败原因</strong><span>{{ terminalFailureReason }}</span></p>
        <p v-if="taskActive && secondsSinceActivity >= 120" class="run-idle-warning">已有 {{ Math.floor(secondsSinceActivity / 60) }} 分钟没有收到新事件，可能正在等待模型或工具。可先查看技术日志；确认无进展后中断当前阶段，测试计划会保留供重试。</p>
      </section>

      <section v-if="generationTargets.length && currentPhase === 'generate'" class="card generation-progress-panel" aria-label="测试代码生成进度">
        <div class="generation-progress-head">
          <div><span class="eyebrow">测试准备</span><h2>正在生成测试代码</h2></div>
          <strong>{{ generationCompletedCount }} / {{ generationTargets.length }} 个目标完成<span v-if="generationActiveCount"> · {{ generationActiveCount }} 个处理中</span></strong>
        </div>
        <div class="generation-progress-list">
          <div v-for="item in generationTargets" :key="item.outputPath" class="generation-progress-row" :class="item.status">
            <span class="generation-progress-mark">{{ item.status === 'completed' || item.status === 'reused' ? '✓' : item.status === 'failed' ? '!' : item.status === 'retrying' ? '↻' : item.status === 'running' ? '•' : '○' }}</span>
            <span class="generation-progress-target">{{ item.target.split('/').pop()?.replace(/\.[^.]+$/, '') }}</span>
            <span class="generation-progress-state">{{ item.status === 'completed' ? '已生成' : item.status === 'reused' ? '已复用' : item.status === 'failed' ? '失败' : item.status === 'retrying' ? '自动重试中' : item.status === 'running' ? '生成中' : '等待中' }}</span>
            <small v-if="item.message">{{ item.message }}</small>
          </div>
        </div>
        <p class="generation-progress-note">已完成的目标会保留；中断或失败后继续执行时，不会重新生成这些文件。</p>
      </section>

      <details v-if="localTaskId || snapshot?.taskId" class="run-log-details">
        <summary>
          <span class="run-log-label run-log-label-closed">查看完整执行日志</span>
          <span class="run-log-label run-log-label-open">收起执行日志</span>
          <span>{{ unifiedLogLines.length }} 条记录 · 技术详情</span>
        </summary>
      <!-- P4-6 合并：统一日志流（业务事件 + 工具调用，时间序） -->
      <div v-if="unifiedLogLines.length" class="agent-log-stream">
        <div v-for="line in unifiedLogLines" :key="line.id" class="agent-log-line" :class="line.level">
          <span class="log-time">[{{ line.time }}]</span>
          <span class="log-text">{{ line.text }}</span>
        </div>
      </div>
      <p v-else class="log-empty">{{ runtime.message }}</p>

      <!-- P4-6：折叠详情（默认折叠，直接展示工作内容；内部轮次编号不暴露给普通用户） -->
      <details class="agent-details-collapse">
        <summary>查看详细日志（thinking + 工具参数）</summary>
        <div v-if="agentWorkRecords.length" class="agent-stream">
          <div v-for="record in agentWorkRecords" :key="record.role ?? 'agent'" class="agent-turn">
            <div class="turn-header">
              <span class="turn-badge" :class="record.status">{{ displayRoleName(record.role) }}工作记录</span>
              <span class="turn-status">{{ record.status === 'running' ? '正在处理…' : record.status === 'error' ? '已中断' : '已完成' }}</span>
            </div>
            <p v-if="!record.thinkingText && !record.toolCalls.length" class="log-empty">等待模型输出或工具调用…</p>
            <div v-if="record.thinkingText" class="turn-thinking">
              <div class="thinking-label">处理说明</div>
              <div class="thinking-text">{{ unescapeJson(record.thinkingText) }}</div>
            </div>
            <div v-if="record.role === 'result-reviewer' && record.readCount" class="diagnosis-read-summary">
              已读取 {{ record.readCount }} 份直接相关的测试报告或源码证据；逐条文件路径保留在技术日志中。
            </div>
            <div v-if="record.toolCalls.length" class="turn-tools">
              <div v-for="call in record.toolCalls" :key="call.toolCallId" class="tool-call" :class="call.status">
                <div class="tool-call-head">
                  <span class="tool-icon">🛠</span>
                  <span class="tool-name">{{ call.toolName }}</span>
                  <span v-if="call.argsText" class="tool-args">{{ call.argsText }}</span>
                  <span class="chip" :class="call.status === 'done' ? 'passed' : call.status === 'error' ? 'failed' : 'running'">{{ call.status === 'running' ? '执行中…' : call.status === 'error' ? '失败' : '完成' }}</span>
                </div>
                <div v-if="call.testDetails" class="tool-result">
                  <span class="result-stat" :class="call.testDetails.ok ? 'pass' : 'fail'">{{ call.testDetails.pass }}/{{ call.testDetails.tests }} 通过</span>
                  <span v-if="call.testDetails.fail" class="result-stat fail">{{ call.testDetails.fail }} 失败</span>
                  <span v-if="call.testDetails.coverage !== null" class="result-stat">覆盖率 {{ call.testDetails.coverage }}%</span>
                </div>
                <div v-else-if="call.resultSummary" class="tool-result">
                  <span class="result-stat">{{ call.resultSummary }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </details>
      </details>

      <!-- Escalation 弹窗区（片B：角色发起 escalation 时显示，人答或跳过） -->
      <section v-if="hasEscalationPending()" class="report-section escalation-section">
        <div class="section-head"><h2>⚠️ Escalation 待答复</h2><span class="hint">{{ escalationPendings.length }} 条</span></div>
        <div v-for="item in escalationPendings" :key="item.escalationId" class="card escalation-item">
          <div class="escalation-head">
            <span class="diag-name">{{ item.role }}</span>
            <span class="diag-tag tag-flaky">escalation</span>
          </div>
          <p class="escalation-question">{{ item.question }}</p>
          <p v-if="item.fallback" class="escalation-fallback">保守方案：{{ item.fallback }}</p>
          <p v-if="item.context" class="escalation-context">背景：{{ item.context }}</p>
          <div class="escalation-actions">
            <input v-model="escalationAnswers[item.escalationId]" placeholder="输入答复…" class="escalation-input" @keydown.enter="replyEscalation(item)" />
            <button class="btn btn-primary" :disabled="!escalationAnswers[item.escalationId]?.trim()" @click="replyEscalation(item)">答复</button>
            <button class="btn btn-dark" @click="dismissEscalation(item)">跳过并立即按保守方案继续</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else-if="view === 'diagnosis'" class="detail-view">
      <h1 class="detail-title">失败诊断确认</h1>
      <p class="detail-sub">请查看诊断结果，决定是否让 agent 按诊断修复</p>
      <section v-if="diagnosisPending?.failedCases?.length" class="report-section">
        <div class="section-head"><h2>失败诊断</h2><span class="hint">{{ diagnosisPending.failedCases.length }} 条</span></div>
        <div v-for="(item, i) in diagnosisPending.failedCases" :key="i" class="card diag-item">
          <div class="diag-head">
            <span class="diag-name">{{ item.name }}</span>
            <span class="diag-tag" :class="`tag-${item.category}`">{{ categoryLabel(item.category) }}</span>
            <span class="confidence-tag" :class="item.confidence ?? 'low'">{{ confidenceLabel(item.confidence) }}</span>
            <span class="diag-layer">{{ item.layer }}</span>
          </div>
          <div class="diag-error">{{ item.error }}</div>
          <!-- P0 项4：代码位置（surefire stack 第一帧） + 重跑按钮 -->
          <div v-if="item.location" class="diag-location">📍 {{ item.location.path }}:{{ item.location.line }}<span v-if="item.testClass"> · {{ item.testClass }}</span></div>
          <div v-if="item.evidence" class="diag-evidence">证据：{{ item.evidence }}</div>
          <div v-if="item.suggestion" class="diag-suggestion">建议：{{ item.suggestion }}</div>
          <!-- P3-4：UI 截图缩略图（失败用例可视化） -->
          <div v-if="item.screenshot" class="diag-screenshot">
            <img :src="shotUrl(item.screenshot)" class="diag-shot-thumb" :alt="item.screenshot" @click="openScreenshot(item.screenshot)" />
            <span class="hint">点击查看截图</span>
          </div>
          <div v-else class="diag-no-screenshot"><span class="muted">📷 [无截图]</span></div>
          <div v-if="resolveRerunCaseId(item)" class="diag-rerun-row">
            <button class="btn btn-soft btn-sm" :disabled="rerunRunning" @click="rerunFailedCase(item)">{{ rerunRunning && rerunTargetCaseId === resolveRerunCaseId(item) ? '重跑中…' : '↻ 重跑此场景' }}</button>
            <span class="hint">跳转执行页查看输出</span>
          </div>
          <!-- 缺陷联动（PRD 功能三）：仅 real-bug 显示建单按钮 -->
          <div v-if="shouldShowCreateDefectButton(item.category)" class="defect-actions">
            <button v-if="!defectStates[defectKey(item.name, i)] || defectStates[defectKey(item.name, i)].status === 'idle'" class="btn btn-soft" @click="createDefect(item, i)">建单</button>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'creating'" class="defect-status creating">建单中…</span>
            <a v-else-if="defectStates[defectKey(item.name, i)].status === 'success' && defectStates[defectKey(item.name, i)].defectUrl" :href="defectStates[defectKey(item.name, i)].defectUrl" target="_blank" class="defect-status success">已建单：{{ defectStates[defectKey(item.name, i)].defectId }} ↗</a>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'success'" class="defect-status success">已建单：{{ defectStates[defectKey(item.name, i)].defectId }}</span>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'failed'" class="defect-status failed">建单失败，可手动重试 <button class="btn btn-soft btn-sm" @click="createDefect(item, i)">重试</button></span>
          </div>
        </div>
      </section>
      <section v-if="diagnosisPending?.fixDecision?.action === 'needs-confirm'" class="report-section">
        <div class="card">
          <p>诊断已完成，测试结果已保留。修复会修改项目代码，只有你明确确认后才会启动。</p>
          <p v-if="diagnosisPending.fixDecision.reason" class="hint">{{ diagnosisPending.fixDecision.reason }}</p>
          <p v-if="error" class="plan-error" role="alert">{{ error }}</p>
          <div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn btn-primary" :disabled="starting" @click="confirmFixByDiagnosis">{{ starting ? '启动中…' : '✓ 按诊断修复' }}</button>
            <button class="btn btn-soft" @click="skipFix">我自己处理</button>
          </div>
        </div>
      </section>
      <section v-else-if="diagnosisPending?.fixDecision?.action === 'no-fix'" class="report-section">
        <div class="card">
          <p>失败为环境/flaky 问题，agent 不修代码。请检查环境后重跑，或手动隔离 flaky 测试。</p>
          <div style="margin-top:12px">
            <button class="btn btn-soft" @click="skipFix">已知悉，查看报告</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else-if="view === 'report'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <div class="head-row">
        <div><h1 class="detail-title" style="margin:0 0 6px">测试报告</h1><p class="detail-sub" style="margin:0">{{ form.systemName || '尚未选择项目' }}<span v-if="report?.durationMs !== undefined"> · 耗时 {{ durationText }}</span></p></div>
        <span v-if="report" class="verdict compact" :class="report.gate?.passed && report.passed + report.failed > 0 ? 'pass' : 'warn'">{{ report.passed + report.failed === 0 ? '⚠ 无可核验测试结果' : report.gate ? (report.gate.passed ? '✓ 质量门禁通过' : '⚠ 需人工关注') : '质量门禁未评估' }}</span>
      </div>
      <div v-if="!report" class="card panel report-empty-state">
        <h2>尚无可用测试报告</h2>
        <p>当前任务还没有完成并产出可核验的执行结果。这里不会把未测量的数据记为 0，也不会判断测试通过。</p>
        <button class="btn btn-primary" @click="go(snapshot ? 'run' : 'home')">{{ snapshot ? '查看执行进度' : '返回工作台创建任务' }}</button>
      </div>

      <template v-else>

      <div class="card report-evidence-note">
        <strong>结果口径</strong>
        <p>通过与失败是测试工具实际报告的测试数量，不代表下方每条 AI 用例都已逐条执行。计划清单用于核对范围；逐条执行状态只有在能关联到工具证据时才可认定。</p>
        <span>本次送交执行 {{ report.cases?.length ?? 0 }} 条候选用例 · {{ verifiedPlanCaseCount }} 条有逐条证据 · 工具报告 {{ report.passed + report.failed }} 个测试结果</span>
      </div>
      <section v-if="report.provenance" class="report-section">
        <div class="section-head"><h2>运行溯源</h2><span class="hint">执行时捕获</span></div>
        <div class="card panel">
          <div class="detail-grid">
            <div><span class="muted">Git commit</span><strong>{{ report.provenance.gitCommitSha ?? '非 Git 项目' }}</strong></div>
            <div><span class="muted">工作树</span><strong>{{ report.provenance.gitDirty == null ? '不适用' : report.provenance.gitDirty ? 'dirty' : 'clean' }}</strong></div>
            <div><span class="muted">项目类型</span><strong>{{ report.provenance.projectType }}</strong></div>
            <div><span class="muted">执行环境</span><strong>{{ report.provenance.executionEnvironment }}</strong></div>
            <div><span class="muted">目标 URL</span><strong>{{ report.provenance.targetUrl ?? '未指定' }}</strong></div>
            <div><span class="muted">捕获时间</span><strong>{{ report.provenance.capturedAt }}</strong></div>
          </div>
        </div>
      </section>
      <div v-if="plannedReportCaseCount > verifiedPlanCaseCount && executedToolTestCount > 0" class="card legacy-evidence-note">
        <strong>部分计划用例尚未建立稳定证据链</strong>
        <p>旧测试或第三方测试若没有写入 <code>[CASE:用例ID]</code>，系统不会按标题猜测关联，也不会把套件通过误算为这些用例逐条通过。</p>
        <span>建议在“用例与计划”页重新生成或更新这些测试；新生成测试会自动携带稳定用例 ID。</span>
        <button class="btn btn-soft btn-sm" @click="go('plan')">返回用例与计划</button>
      </div>

      <div class="stat-grid">
        <div v-if="hasTestResults" class="card stat"><div class="num green">{{ report?.passed ?? '--' }}</div><div class="lbl">工具测试通过</div></div>
        <div v-if="hasTestResults" class="card stat"><div class="num" :class="{ red: report?.failed }">{{ report?.failed ?? '--' }}</div><div class="lbl">工具测试失败</div></div>
        <div class="card stat"><div class="num">{{ durationText }}</div><div class="lbl">耗时</div></div>
        <div v-if="report.coverage != null" class="card stat"><div class="num">{{ report.coverage }}%</div><div class="lbl">覆盖率</div></div>
        <div v-if="report.gate" class="card stat"><div class="num" :class="report.gate.passed && report.passed + report.failed > 0 ? 'green' : 'red'">{{ report.passed + report.failed === 0 ? '未验证' : report.gate.passed ? '通过' : '未通过' }}</div><div class="lbl">质量门禁</div></div>
        <div v-if="qualityScore !== null" class="card stat"><div class="num">{{ qualityScore }}</div><div class="lbl">质量分</div></div>
      </div>

      <div v-if="report?.summary" class="card panel summary-card">{{ report.summary }}</div>

      <section v-if="report?.failedCases?.length" class="report-section">
        <div class="section-head"><h2>失败诊断</h2><span class="hint">{{ report.failedCases.length }} 条</span>
          <button class="btn btn-soft btn-sm" :disabled="batchRerunRunning" @click="rerunFailedBatch">{{ batchRerunRunning ? '重跑中…' : '↻ 只跑失败' }}</button>
        </div>
        <!-- P1-2：批量重跑结果汇总 -->
        <div v-if="batchRerunResult" class="card panel batch-rerun-result">
          <div class="batch-summary">
            <span>批量重跑完成：✅{{ batchRerunResult.summary.pass }} ❌{{ batchRerunResult.summary.fail }}<span v-if="batchRerunResult.summary.skipped"> ⏭{{ batchRerunResult.summary.skipped }}</span> / 共 {{ batchRerunResult.summary.total }}</span>
            <span v-if="batchRerunResult.error" class="error">⚠ {{ batchRerunResult.error }}</span>
          </div>
          <div v-for="(r, i) in batchRerunResult.results" :key="i" class="batch-result-row">
            <span class="batch-status" :class="{ ok: r.ok, fail: !r.ok && !r.skipped, skip: r.skipped }">{{ r.ok ? '✅' : r.skipped ? '⏭' : '❌' }}</span>
            <span class="batch-name">{{ r.name }}</span>
            <span v-if="r.error" class="batch-error">{{ r.error }}</span>
            <button v-if="r.output" class="btn btn-soft btn-sm" @click="toggleBatchExpand(i)">{{ batchExpanded.has(i) ? '收起' : '输出' }}</button>
            <pre v-if="r.output && batchExpanded.has(i)" class="batch-output">{{ r.output }}</pre>
          </div>
        </div>
        <div v-for="(item, i) in report.failedCases" :key="i" class="card diag-item">
          <div class="diag-head">
            <span class="diag-name">{{ item.name }}</span>
            <span class="diag-tag" :class="`tag-${item.category}`">{{ categoryLabel(item.category) }}</span>
            <span class="confidence-tag" :class="item.confidence ?? 'low'">{{ confidenceLabel(item.confidence) }}</span>
            <span class="diag-layer">{{ item.layer }}</span>
          </div>
          <div class="diag-error">{{ item.error }}</div>
          <!-- P0 项4：代码位置（surefire stack 第一帧） + 重跑按钮 -->
          <div v-if="item.location" class="diag-location">📍 {{ item.location.path }}:{{ item.location.line }}<span v-if="item.testClass"> · {{ item.testClass }}</span></div>
          <div v-if="item.evidence" class="diag-evidence">证据：{{ item.evidence }}</div>
          <div v-if="item.suggestion" class="diag-suggestion">建议：{{ item.suggestion }}</div>
          <!-- P3-4：UI 截图缩略图 + 录像回放入口（失败用例可视化） -->
          <div v-if="item.screenshot" class="diag-screenshot">
            <img :src="shotUrl(item.screenshot)" class="diag-shot-thumb" :alt="item.screenshot" @click="openScreenshot(item.screenshot)" />
            <span class="hint">点击查看截图</span>
          </div>
          <div v-else class="diag-no-screenshot"><span class="muted">📷 [无截图]</span></div>
          <div v-if="report?.recording?.video" class="diag-video-link">
            <button class="btn btn-soft btn-sm" @click="scrollToVideo">▶ 录像回放</button>
          </div>
          <div v-if="resolveRerunCaseId(item)" class="diag-rerun-row">
            <button class="btn btn-soft btn-sm" :disabled="rerunRunning" @click="rerunFailedCase(item)">{{ rerunRunning && rerunTargetCaseId === resolveRerunCaseId(item) ? '重跑中…' : '↻ 重跑此场景' }}</button>
            <span class="hint">跳转执行页查看输出</span>
          </div>
          <!-- 缺陷联动（PRD 功能三）：仅 real-bug 显示建单按钮 -->
          <div v-if="shouldShowCreateDefectButton(item.category)" class="defect-actions">
            <button v-if="!defectStates[defectKey(item.name, i)] || defectStates[defectKey(item.name, i)].status === 'idle'" class="btn btn-soft" @click="createDefect(item, i)">建单</button>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'creating'" class="defect-status creating">建单中…</span>
            <a v-else-if="defectStates[defectKey(item.name, i)].status === 'success' && defectStates[defectKey(item.name, i)].defectUrl" :href="defectStates[defectKey(item.name, i)].defectUrl" target="_blank" class="defect-status success">已建单：{{ defectStates[defectKey(item.name, i)].defectId }} ↗</a>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'success'" class="defect-status success">已建单：{{ defectStates[defectKey(item.name, i)].defectId }}</span>
            <span v-else-if="defectStates[defectKey(item.name, i)].status === 'failed'" class="defect-status failed">建单失败，可手动重试 <button class="btn btn-soft btn-sm" @click="createDefect(item, i)">重试</button></span>
          </div>
        </div>
      </section>

      <section v-if="report?.readOnlyViolation?.changedFiles?.length" class="report-section">
        <div class="section-head"><h2>⚠️ read-only 违规</h2><span class="hint">诊断 Agent 修改了文件</span></div>
        <div class="card violation-warning">
          <p>诊断 Agent 违反 read-only 约束，修改了以下文件：</p>
          <ul>
            <li v-for="file in report.readOnlyViolation.changedFiles" :key="file">{{ file }}</li>
          </ul>
        </div>
      </section>
      <section v-else-if="report?.readOnlyViolation?.unavailable" class="report-section">
        <div class="section-head"><h2>变更追踪</h2></div>
        <div class="card violation-info">
          <p class="muted">变更追踪不可用：{{ report.readOnlyViolation.unavailable }}</p>
        </div>
      </section>

      <section v-if="report?.fixActions?.length" class="report-section">
        <div class="section-head"><h2>修复动作</h2><span class="hint">{{ report.fixActions.length }} 条·可追溯可回滚</span></div>
        <div v-for="(action, i) in report.fixActions" :key="i" class="card fix-action-item">
          <div class="fix-action-head">
            <span class="diag-tag" :class="`tag-${action.category}`">{{ categoryLabel(action.category) }}</span>
            <span class="confidence-tag" :class="action.confidence">{{ confidenceLabel(action.confidence) }}</span>
            <span class="diag-name">{{ action.diagnosisName }}</span>
          </div>
          <div class="fix-action-files">
            <p class="muted">修改文件：</p>
            <ul>
              <li v-for="f in action.files" :key="f.path">{{ f.path }}</li>
            </ul>
          </div>
          <div class="fix-action-rerun">
            <p>重跑结果：{{ action.rerunResult.passed }} 通过 / {{ action.rerunResult.failed }} 失败</p>
          </div>
          <div class="fix-action-actions">
            <button class="btn btn-soft" @click="rollbackFix(i)">↩ 回滚</button>
          </div>
        </div>
      </section>

      <section v-if="report?.escalations?.length" class="report-section">
        <div class="section-head"><h2>escalation 汇总</h2><span class="hint">{{ report.escalations.length }} 条·角色向总代理提问记录</span></div>
        <div v-for="(esc, i) in report.escalations" :key="esc.escalationId || i" class="card escalation-item" :class="{ 'escalation-degraded': esc.degraded }">
          <div class="escalation-head">
            <span class="escalation-role">{{ esc.role }}</span>
            <span v-if="esc.resolved" class="escalation-status status-resolved">已答复</span>
            <span v-else-if="esc.degraded" class="escalation-status status-degraded">[需人工复核] 降级</span>
            <span v-else class="escalation-status status-pending">待答复</span>
            <span v-if="esc.durationMs !== undefined" class="muted">{{ esc.durationMs >= 1000 ? `${(esc.durationMs / 1000).toFixed(1)}s` : `${esc.durationMs}ms` }}</span>
            <span class="muted escalation-time">{{ esc.timestamp.slice(11, 19) }}</span>
          </div>
          <div class="escalation-question">{{ esc.question }}</div>
          <div v-if="esc.fallback" class="escalation-fallback muted">保守方案：{{ esc.fallback }}</div>
          <div v-if="esc.answer" class="escalation-answer">答复：{{ esc.answer }}</div>
          <div v-if="esc.burstWarning" class="escalation-burst">⚠️ {{ esc.burstWarning }}</div>
        </div>
      </section>

      <section v-if="report?.uiSteps?.length || report?.timeline?.length" class="report-section execution-summary-section">
        <div class="section-head"><div><h2>执行摘要</h2><p class="hint">展示关键处理阶段及其结果；底层命令与参数请到执行详情查看。</p></div><button class="btn btn-soft btn-sm" @click="go('run')">查看执行详情</button></div>
        <div v-if="report?.uiSteps?.length" class="exec-timeline">
          <div v-for="(step, index) in report.uiSteps" :key="index" class="card exec-step" :class="step.status">
            <img v-if="step.screenshot" :src="shotUrl(step.screenshot)" class="exec-thumb" :alt="step.name" />
            <div class="exec-step-body">
              <div class="exec-step-head"><b>{{ step.name }}</b><span class="chip" :class="step.status">{{ step.status }}</span><span class="muted">{{ step.durationMs !== undefined ? `${Math.round(step.durationMs / 1000)}s` : '' }}</span></div>
              <div v-if="step.error" class="exec-step-error">{{ step.error }}</div>
            </div>
          </div>
        </div>
        <div v-else class="timeline">
          <div v-for="item in compactReportTimeline" :key="`${item.stage}-${item.status}`" class="timeline-item" :class="item.status">
            <span class="timeline-dot"></span>
            <div class="timeline-body">
              <div class="timeline-head"><b>{{ item.stage }}</b><span class="chip" :class="item.status">{{ timelineStatusLabel(item.status) }}</span><span v-if="timelineDurationText(item.durationMs)" class="muted">{{ timelineDurationText(item.durationMs) }}</span></div>
              <div class="timeline-description">{{ timelineStageDescription(item.stage) }}<span v-if="item.count > 1"> · {{ item.count }} 项操作</span></div>
              <div v-if="item.message" class="timeline-message">{{ item.message }}</div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="reportDataUnavailable" class="report-section">
        <h2>测试结果</h2>
        <div class="card report-data-unavailable">
          <div><strong>测试结果尚未生成</strong><p>测试命令在产生有效结果前失败，因此没有测试计数、泳道统计或覆盖率数据。候选用例仍保留，不能据此判断通过或覆盖情况。</p></div>
          <button class="btn btn-soft btn-sm" @click="go('run')">查看执行详情</button>
        </div>
      </section>

      <section v-if="hasReportMetrics" class="report-section">
        <h2>覆盖率</h2>
        <div class="card panel report-metrics-panel">
          <template v-if="report.coverage != null"><div class="report-metric-head"><span class="muted">行覆盖率</span><b>{{ report.coverage }}%</b></div>
          <div class="bar"><div :style="{ width: `${report?.coverage ?? 0}%` }"></div></div>
          </template>
          <template v-if="report.branchCoverage != null"><div class="report-metric-head"><span class="muted">分支覆盖率</span><b>{{ report.branchCoverage }}%</b></div>
          <div class="bar amber"><div :style="{ width: `${report?.branchCoverage ?? 0}%` }"></div></div>
          </template>
          <template v-if="effectivePercent !== null"><div class="report-metric-head"><span class="muted">有效用例占比</span><b>{{ effectivePercent }}%</b></div>
          <div class="bar amber"><div :style="{ width: `${effectivePercent ?? 0}%` }"></div></div>
          </template>
        </div>
        <div v-if="report.coverageEvidence" class="card panel coverage-evidence-card">
          <div class="section-head"><div><h3>覆盖率证据</h3><p class="hint">仅采信本次测试更新的报告：{{ report.coverageEvidence.source }}</p></div></div>
          <div v-if="report.coverageEvidence.gaps.length" class="coverage-gap-list">
            <div v-for="gap in report.coverageEvidence.gaps" :key="gap.file" class="coverage-gap-row">
              <b>{{ gap.file }}</b><span class="muted">{{ gap.uncoveredLines.length }} 个未覆盖行：{{ gap.uncoveredLines.slice(0, 12).join(', ') }}{{ gap.uncoveredLines.length > 12 ? '…' : '' }}</span>
            </div>
          </div>
          <p v-else class="hint">报告没有返回可展示的未覆盖行。</p>
        </div>
      </section>
      <section v-else-if="hasTestResults" class="report-section">
        <h2>覆盖率</h2>
        <div class="card report-data-unavailable">
          <div><strong>本次未采集覆盖率</strong><p>测试结果有效，但测试命令没有生成可验证的覆盖率报告。这不等于覆盖率为 0；Maven 项目需配置 JaCoCo，Node 项目需让测试脚本输出覆盖率后才能展示缺口。</p></div>
          <button class="btn btn-soft btn-sm" @click="openSettingsSection('coverage')">检查覆盖率设置</button>
        </div>
      </section>

      <section v-if="report?.fitness" class="report-section">
        <h2>自修复迭代曲线</h2>
        <div class="card panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <span class="muted">迭代轮次 {{ report.fitness.iterations }} / 判停阈值 K={{ report.fitness.k }}</span>
            <span class="chip" :class="report.fitness.converged ? 'passed' : 'failed'">{{ report.fitness.converged ? '已收敛' : '未收敛' }}</span>
          </div>
          <div v-if="report.fitness.curve.length" class="fitness-chart">
            <div v-for="point in report.fitness.curve" :key="point.iter" class="fitness-row" :class="{ 'no-improve': !point.improvement && point.iter > 0 }">
              <span class="fitness-iter">{{ point.iter === 0 ? '基线' : `第${point.iter}轮` }}</span>
              <div class="fitness-bars">
                <div class="bar"><div :style="{ width: `${point.passRate}%` }"></div></div>
                <div v-if="point.coverage !== null" class="bar amber"><div :style="{ width: `${point.coverage}%` }"></div></div>
              </div>
              <span class="muted fitness-val">{{ point.passRate }}%{{ point.coverage !== null ? ` / ${point.coverage}%` : '' }}{{ point.iter > 0 ? ` (Δ${point.passRateDelta > 0 ? '+' : ''}${point.passRateDelta})` : '' }}</span>
            </div>
          </div>
          <div class="muted" style="margin-top:10px">{{ report.fitness.message }}</div>
          <div v-if="report.fitness.tokenCost" class="muted" style="margin-top:6px">Token 用量：输入 {{ report.fitness.tokenCost.input }} / 输出 {{ report.fitness.tokenCost.output }} / 合计 {{ report.fitness.tokenCost.total }}</div>
          <div v-else class="muted" style="margin-top:6px">Token 用量：数据积累中</div>
        </div>
      </section>

      <section v-if="report?.riskPoints?.length" class="report-section">
        <h2>风险点</h2>
        <div v-for="risk in report.riskPoints" :key="risk.file" class="card" style="padding:14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px">
          <span class="severity" :class="risk.severity">{{ risk.severity === 'high' ? '高' : risk.severity === 'medium' ? '中' : '低' }}</span>
          <span><b>{{ risk.file }}</b><div class="muted">{{ risk.message }}{{ risk.suggestion ? ` · ${risk.suggestion}` : '' }}</div></span>
        </div>
      </section>

      <section v-if="report?.fixes?.length" class="report-section">
        <h2>建议修复</h2>
        <div v-for="(fix, index) in report.fixes" :key="index" class="card fix-card">
          <div class="fix-head">
            <span class="severity" :class="fix.severity">{{ fix.severity === 'high' ? '高' : fix.severity === 'medium' ? '中' : '低' }}</span>
            <b>{{ fix.title }}</b>
            <span class="muted">{{ fix.file }}</span>
          </div>
          <div class="muted fix-summary">{{ fix.summary }}</div>
          <div class="fix-diff">
            <div><div class="muted">修复前</div><pre class="code-block">{{ fix.beforeCode || '-' }}</pre></div>
            <div><div class="muted">修复后</div><pre class="code-block">{{ fix.afterCode || '-' }}</pre></div>
          </div>
        </div>
      </section>

      <section v-if="meaningfulLanes.length" class="report-section">
        <h2>测试泳道</h2>
        <div class="lane-row">
          <article v-for="lane in meaningfulLanes" :key="lane.type" class="card lane-card">
            <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : lane.type === 'ui' ? 'UI' : 'A' }}</span><h3>{{ laneLabels[lane.type] }}</h3><span class="chip" :class="lane.status">{{ laneStatusLabel(lane.status) }}</span></div>
            <p>{{ lane.summary }}</p>
          </article>
        </div>
      </section>

      <section v-if="report?.api" class="report-section">
        <h2>接口测试</h2>
        <table class="data-table">
          <thead><tr><th>方法</th><th>路径</th><th>状态</th><th>实际状态码</th><th>耗时</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-if="!report.api.details?.length"><td colspan="6" class="muted">暂无接口执行记录。</td></tr>
            <tr v-for="item in report.api.details" :key="item.caseId">
              <td><span class="chip">{{ item.method }}</span></td>
              <td>{{ item.path }}</td>
              <td><span class="chip" :class="item.status">{{ item.status }}</span></td>
              <td>{{ item.statusCode ?? '-' }}</td>
              <td>{{ item.durationMs !== undefined ? `${item.durationMs}ms` : '-' }}</td>
              <td>{{ item.reason ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="report-section">
        <h2>计划用例核验</h2>
        <p class="hint">本次计划 {{ plannedReportCaseCount }} 条，工具实际执行 {{ executedToolTestCount }} 个测试，其中 {{ verifiedPlanCaseCount }} 条计划用例取得可关联证据。未关联项保持“未核验”，不根据测试总数推断通过。</p>
        <table class="data-table">
          <thead><tr><th>计划用例</th><th>核验状态</th><th>执行证据</th><th>目标方法</th><th>层级</th><th>优先级</th></tr></thead>
          <tbody>
            <tr v-if="!report?.cases?.length"><td colspan="6" class="muted">本次报告没有计划用例。</td></tr>
            <tr v-for="item in visibleReportCases" :key="item.id"><td>{{ item.title }}</td><td>{{ reportCaseEvidence.get(item.id)?.status === 'passed' ? '已通过' : reportCaseEvidence.get(item.id)?.status === 'failed' ? '失败' : reportCaseEvidence.get(item.id)?.status === 'skipped' ? '已跳过' : '未核验' }}</td><td>{{ reportCaseEvidence.get(item.id)?.evidence ?? '测试工具未返回相同用例 ID' }}</td><td>{{ item.target ?? '-' }}</td><td>{{ item.layer ?? '-' }}</td><td>{{ item.priority }}</td></tr>
          </tbody>
        </table>
        <nav v-if="reportCasePageCount > 1" class="plan-case-pagination" aria-label="报告候选用例分页">
          <button class="btn btn-soft btn-sm" :disabled="reportCasePage <= 1" @click="reportCasePage--">上一页</button>
          <span>第 {{ reportCasePage }} / {{ reportCasePageCount }} 页 · 共 {{ report?.cases?.length ?? 0 }} 条</span>
          <button class="btn btn-soft btn-sm" :disabled="reportCasePage >= reportCasePageCount" @click="reportCasePage++">下一页</button>
        </nav>
      </section>

      <section v-if="report.caseResults?.length" class="report-section">
        <details class="card panel">
          <summary>查看工具逐条测试记录（{{ report.caseResults.length }} 条）</summary>
          <p class="hint">这是测试工具返回的原始测试名。只有测试名与计划用例 ID 完全一致时，才会关联上方计划状态。</p>
          <table class="data-table">
            <thead><tr><th>工具</th><th>测试名 / 用例 ID</th><th>结果</th><th>来源</th></tr></thead>
            <tbody>
              <tr v-for="(item, index) in report.caseResults" :key="`${item.tool}-${item.caseId}-${index}`"><td>{{ item.tool }}</td><td>{{ item.caseId }}</td><td>{{ item.status === 'passed' ? '通过' : item.status === 'failed' ? '失败' : '跳过' }}</td><td>{{ item.evidence }}</td></tr>
            </tbody>
          </table>
        </details>
      </section>

      <section class="report-section">
        <h2>失败用例明细</h2>
        <div v-if="!report?.failedCases?.length" class="card" :class="reportDataUnavailable ? 'report-neutral-empty' : 'report-success-empty'">{{ reportDataUnavailable ? '测试结果未生成，因此没有可核验的失败用例明细。' : '本次运行没有失败用例。' }}</div>
        <table v-else class="data-table">
          <thead><tr><th>用例</th><th>层级</th><th>分类</th><th>错误摘要</th><th>证据</th><th>根因建议</th><th>截图</th></tr></thead>
          <tbody>
            <tr v-for="item in report?.failedCases" :key="item.name"><td>{{ item.name }}</td><td>{{ item.layer }}</td><td><span class="diag-tag" :class="`tag-${item.category}`">{{ categoryLabel(item.category) }}</span></td><td>{{ item.error }}</td><td>{{ item.evidence ?? '-' }}</td><td>{{ item.suggestion ?? '-' }}</td><td><img v-if="item.screenshot" :src="shotUrl(item.screenshot)" class="step-shot" :alt="item.screenshot" /><span v-else>-</span></td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="report?.screenshots?.length" class="report-section">
        <h2>UI 截图</h2>
        <div class="shot-grid">
          <figure v-for="shot in report.screenshots" :key="shot" class="shot-item"><img :src="shotUrl(shot)" :alt="shot" /><figcaption>{{ shot }}</figcaption></figure>
        </div>
      </section>

      <section v-if="report?.recording?.video || report?.recording?.trace" class="report-section">
        <h2>执行录像 / Trace</h2>
        <div class="recording-row">
          <div v-if="report.recording.video" class="card panel">
            <div class="muted" style="margin-bottom:8px">执行录像</div>
            <video :src="shotUrl(report.recording.video)" controls style="width:100%;border-radius:10px;background:#000"></video>
          </div>
          <div v-if="report.recording.trace" class="card panel">
            <div class="muted" style="margin-bottom:8px">Playwright Trace</div>
            <a class="btn btn-soft" :href="shotUrl(report.recording.trace)" target="_blank" rel="noreferrer">打开 Trace 文件</a>
            <div class="path muted" style="margin-top:8px">{{ report.recording.trace }}</div>
          </div>
        </div>
      </section>

      <section class="report-section">
        <h2>测试产物</h2>
        <div v-if="!artifactItems.length" class="muted">暂无制品。</div>
        <div v-else class="artifact-list">
          <div v-for="artifact in artifactItems" :key="artifact.path" class="artifact"><span>📄</span><span><div class="name">{{ artifact.name }}</div><div class="path">{{ artifact.path }}</div></span></div>
        </div>
      </section>

      <section v-if="form.projectPath" class="report-section">
        <details class="card report-secondary-details">
          <summary><span>跨任务升级审计</span><span class="hint">按需查看历史提问与答复</span></summary>
          <div class="report-secondary-body">
            <div class="report-secondary-actions"><span class="hint">{{ escalationAudit.length }} 条历史记录</span><button class="btn btn-soft btn-sm" @click="loadEscalationAuditHistory">加载历史</button></div>
            <div v-if="escalationAudit.length" v-for="(entry, i) in escalationAudit" :key="entry.escalationId || i" class="card escalation-item" :class="{ 'escalation-degraded': entry.degraded }">
              <div class="escalation-head"><span class="escalation-role">{{ entry.role }}</span><span v-if="entry.resolved" class="escalation-status status-resolved">已答复</span><span v-else-if="entry.degraded" class="escalation-status status-degraded">需人工复核</span><span v-else class="escalation-status status-pending">待答复</span><span class="muted escalation-time">{{ entry.timestamp.slice(11, 19) }}</span></div>
              <div class="escalation-question">{{ entry.question }}</div><div v-if="entry.fallback" class="escalation-fallback muted">保守方案：{{ entry.fallback }}</div><div v-if="entry.answer" class="escalation-answer">答复：{{ entry.answer }}</div>
            </div>
            <p v-else class="muted report-secondary-empty">尚未加载跨任务审计记录。</p>
          </div>
        </details>
      </section>

      <div class="export-bar">
        <button class="btn btn-primary" :disabled="!report" @click="exportReport('markdown')">导出 Markdown</button>
        <button class="btn btn-dark" :disabled="!report" @click="exportReport('html')">导出 HTML</button>
        <button class="btn btn-dark" :disabled="!report" @click="exportReport('pdf')">导出 PDF</button>
        <button class="btn btn-soft" :disabled="!report" @click="copySummary">复制摘要</button>
      </div>
      </template>
    </div>

    <div v-else-if="view === 'history'" class="detail-view">
      <button class="back" @click="go('home')">← 返回首页</button>
      <div class="head-row">
        <div><h1 class="detail-title">运行历史</h1><p class="detail-sub" style="margin:0">已保存的本地执行记录</p></div>
        <button class="btn btn-soft" :disabled="!history.length" @click="clearHistory">清空历史</button>
      </div>
      <div v-if="!history.length" class="card panel muted">暂无运行历史</div>
      <div v-else class="history-list">
        <article v-for="item in history" :key="item.id" class="card history-card" @click="openHistory(item)">
          <div class="history-head">
            <div>
              <div class="history-title">{{ item.projectName || '未命名项目' }}</div>
              <div class="history-path">{{ item.projectPath }}</div>
            </div>
            <span class="chip" :class="item.snapshot.report?.gate?.passed === false ? 'failed' : item.snapshot.report?.gate?.passed ? 'passed' : 'pending'">{{ !item.snapshot.report ? '无报告' : item.snapshot.report.gate?.passed === false ? '需人工关注' : item.snapshot.report.gate?.passed ? '门禁通过' : '门禁未评估' }}</span>
          </div>
          <div class="history-stats">
            <span>通过 <b>{{ item.snapshot.report?.passed ?? '--' }}</b></span>
            <span>失败 <b :class="{ red: item.snapshot.report?.failed }">{{ item.snapshot.report?.failed ?? '--' }}</b></span>
            <span>覆盖率 <b>{{ item.snapshot.report?.coverage === null || item.snapshot.report?.coverage === undefined ? 'N/A' : `${item.snapshot.report.coverage}%` }}</b></span>
            <span class="muted">{{ new Date(item.savedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </div>
        </article>
      </div>
    </div>

    <div v-else-if="view === 'settings'" class="detail-view">
      <button class="back" @click="go('home')">← 返回首页</button>
      <h1 class="detail-title">设置</h1>
      <p class="detail-sub">测试环境、接口、UI、覆盖率与知识库配置</p>
      <div class="settings-tabs">
        <button :class="{ active: settingsSection === 'environment' }" @click="settingsSection = 'environment'">环境配置</button>
        <button :class="{ active: settingsSection === 'api' }" @click="settingsSection = 'api'">接口测试</button>
        <button :class="{ active: settingsSection === 'ui' }" @click="settingsSection = 'ui'">UI/E2E</button>
        <button :class="{ active: settingsSection === 'coverage' }" @click="settingsSection = 'coverage'">覆盖率</button>
        <button :class="{ active: settingsSection === 'knowledge' }" @click="settingsSection = 'knowledge'">知识库</button>
        <button :class="{ active: settingsSection === 'ai' }" @click="settingsSection = 'ai'">AI 模型</button>
        <button :class="{ active: settingsSection === 'data' }" @click="settingsSection = 'data'">数据管理</button>
      </div>
      <section v-show="settingsSection === 'environment'" class="report-section">
        <h2>环境配置</h2>
        <div class="card panel">
          <div class="section-head" style="margin-top:0">
            <span class="muted">保存多套环境，切换后自动带入接口/UI 地址、Header 和环境变量</span>
            <button class="btn btn-primary" :disabled="!form.projectPath || !hasEnvironmentDraft" title="请先选择项目并填写至少一项环境配置" @click="saveCurrentEnvironment">安全保存当前配置</button>
          </div>
          <div v-if="!environments.length" class="muted">当前项目暂无环境配置。敏感 Header 和环境变量会使用 Windows 安全存储加密，不写入项目目录或 localStorage。</div>
          <div v-else class="env-profile-list">
            <div v-for="profile in environments" :key="profile.id" class="env-profile-item" :class="{ active: activeEnvironmentId === profile.id }" @click="applyEnvironment(profile.id)">
              <span>{{ profile.name }}</span>
              <span class="muted">{{ profile.apiBaseUrl || '未配置 API 地址' }}</span>
              <button class="btn btn-soft" @click.stop="deleteEnvironment(profile.id)">删除</button>
            </div>
          </div>
        </div>
      </section>
      <section v-show="settingsSection === 'coverage'" class="report-section">
        <h2>覆盖率目标</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">质量门禁最低覆盖率（%）</div>
            <input v-model.number="form.coverageTarget" type="number" min="0" max="100" class="settings-input" />
          </div>
          <span class="hint">低于该值时，质量门禁会标记为需人工关注</span>
        </div>
      </section>
      <section v-show="settingsSection === 'knowledge'" class="report-section">
        <h2>知识库目录</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">当前知识库</div>
            <div class="root-list">{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置' }}</div>
          </div>
          <button class="btn btn-primary" @click="selectKnowledgeRoots">选择目录</button>
        </div>
      </section>
      <section v-show="settingsSection === 'data'" class="report-section">
        <h2>数据管理</h2>
        <div class="card panel settings-row">
          <div>
            <strong>当前项目测试资产</strong>
            <div class="muted" style="margin-top:6px">清理用例库、关联反射场景，以及可确认由 Test Agent 生成的未跟踪测试文件。不会删除项目源码或已有测试。</div>
          </div>
          <button class="btn btn-soft library-reset-button" :disabled="!form.projectPath || libraryDeleteBusy" @click="resetLibraryForNewAnalysis">清理当前项目测试资产</button>
        </div>
      </section>
      <section v-show="settingsSection === 'ai'" class="report-section">
        <h2>AI 模型配置</h2>
        <div class="card panel">
          <div class="section-head" style="margin-top:0">
            <span class="muted">配置内置 LLM 模型（直连 GLM 网关，无需 CLI 子进程）。手动添加 provider、模型和 API Key。</span>
            <button class="btn btn-primary" @click="saveAiConfig">保存配置</button>
          </div>
          <div v-if="aiSaved" class="ai-feedback ai-feedback-ok">✓ 配置已保存</div>
          <div v-if="aiError" class="ai-feedback ai-feedback-err">✗ 保存失败：{{ aiError }}</div>
          <div class="settings-row" style="margin-top:8px">
            <input v-model="aiNewProviderId" class="settings-input" placeholder="provider 名称，如 glm" style="width:200px" />
            <button class="btn btn-soft" @click="addAiProvider">添加 provider</button>
          </div>
          <div v-if="!aiProviderIds().length" class="muted" style="margin-top:8px">暂无 provider，请在上方输入名称并添加。</div>
          <div v-for="pid in aiProviderIds()" :key="pid" class="card panel" style="margin-top:12px">
            <div class="section-head" style="margin-top:0">
              <strong>{{ pid }}</strong>
              <button class="btn btn-soft" @click="removeAiProvider(pid)">删除</button>
            </div>
            <div class="muted">Base URL</div>
            <input v-model="aiEditing.providers[pid].baseUrl" class="settings-input" style="width:420px" placeholder="http://agi-gateway.cxmt.com/cloud/v1" />
            <div class="muted" style="margin-top:8px">API Key</div>
            <input v-model="aiEditing.providers[pid].apiKey" class="settings-input" style="width:420px" type="password" placeholder="token" />
            <div class="muted" style="margin-top:8px">模型列表</div>
            <div v-if="aiEditing.providers[pid].models.length" class="env-profile-list">
              <span v-for="m in aiEditing.providers[pid].models" :key="m.id" class="env-profile-item" style="cursor:default">
                <span>{{ m.id }}</span>
                <label class="muted"><input type="checkbox" v-model="m.reasoning" /> reasoning</label>
                <button class="btn btn-soft" @click="removeAiModel(pid, m.id)">移除</button>
              </span>
            </div>
            <div class="settings-row" style="margin-top:8px">
              <input v-model="aiNewModelId" class="settings-input" placeholder="模型 ID，如 glm-5.2" style="width:200px" />
              <button class="btn btn-soft" @click="addAiModel(pid)">添加模型</button>
            </div>
          </div>
          <div v-if="aiAllModelIds().length" style="margin-top:12px">
            <div class="muted">默认 Provider / Model</div>
            <select v-model="aiEditing.defaultProvider" class="settings-input" style="width:200px">
              <option :value="undefined">（未选择）</option>
              <option v-for="pid in aiProviderIds()" :key="pid" :value="pid">{{ pid }}</option>
            </select>
            <select v-model="aiEditing.defaultModel" class="settings-input" style="width:200px; margin-left:8px">
              <option :value="undefined">（未选择）</option>
              <option v-for="m in aiAllModelIds()" :key="m.provider + '/' + m.model" :value="m.model">{{ m.provider }}/{{ m.model }}</option>
            </select>
          </div>
          <div v-if="aiAllModelIds().length" class="card panel" style="margin-top:12px">
            <div class="section-head" style="margin-top:0">
              <strong>执行引擎</strong>
            </div>
            <div class="muted">选择发起测试任务时使用的 Agent 引擎。切换后下次启动任务生效。</div>
            <div class="settings-row" style="margin-top:8px">
              <label><input type="radio" :checked="aiEditing.executionEngine !== 'ai-native'" @change="aiEditing.executionEngine = 'cimicode'" /> CimiCode（公司默认 CLI provider）</label>
            </div>
            <div class="settings-row" style="margin-top:4px">
              <label><input type="radio" :checked="aiEditing.executionEngine === 'ai-native'" @change="aiEditing.executionEngine = 'ai-native'" /> 内置 LLM（直连 GLM 网关，无需 CLI 子进程）</label>
            </div>
          </div>
        </div>
      </section>
      <section v-show="settingsSection === 'api'" class="report-section">
        <h2>接口测试入口</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">API 基础地址（选择接口测试时使用）</div>
            <input v-model="form.apiBaseUrl" class="settings-input" style="width:420px" placeholder="http://127.0.0.1:8080" />
            <div class="muted" style="margin-top:12px">OpenAPI / Swagger 文档地址或本地文件路径</div>
            <input v-model="form.openApiUrl" class="settings-input" style="width:420px" placeholder="http://127.0.0.1:8080/v3/api-docs 或 C:\path\openapi.json" />
          </div>
          <span class="hint">Agent 会从测试计划中提取接口路径，并基于该地址执行 HTTP 断言</span>
        </div>
      </section>
      <section v-show="settingsSection === 'api'" class="report-section">
        <h2>接口认证 / Header</h2>
        <div class="card panel">
          <div class="section-head" style="margin-top:0"><span class="muted">例如 Authorization: Bearer xxx，或 X-API-Key: xxx</span><button class="btn btn-soft" @click="addApiHeaderEntry">添加 Header</button></div>
          <div v-if="!apiHeaderEntries.length" class="muted">暂无自定义 Header</div>
          <div v-else class="env-list">
            <div v-for="(entry, index) in apiHeaderEntries" :key="index" class="env-row">
              <input v-model="entry.key" class="settings-input env-key" placeholder="Header 名，如 Authorization" />
              <input v-model="entry.value" type="password" class="settings-input env-value" placeholder="Header 值" />
              <button class="btn btn-soft" @click="removeApiHeaderEntry(index)">删除</button>
            </div>
          </div>
        </div>
      </section>
      <section v-show="settingsSection === 'ui'" class="report-section">
        <h2>UI/E2E 测试入口</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">测试入口 URL（留空则自动启动本地 Vite）</div>
            <input v-model="form.uiEntryUrl" class="settings-input" style="width:420px" placeholder="https://app.example.com/login" />
          </div>
          <span class="hint">通用 UI 冒烟会打开这个地址，并透传给 Playwright 测试环境</span>
        </div>
      </section>
      <section v-show="settingsSection === 'ui'" class="report-section">
        <h2>UI/E2E 环境变量</h2>
        <div class="card panel">
          <div class="section-head" style="margin-top:0"><span class="muted">凭据建议只放本地，不会写入报告或历史</span><button class="btn btn-soft" @click="addEnvEntry">添加变量</button></div>
          <div v-if="!envEntries.length" class="muted">暂无环境变量</div>
          <div v-else class="env-list">
            <div v-for="(entry, index) in envEntries" :key="index" class="env-row">
              <input v-model="entry.key" class="settings-input env-key" placeholder="变量名，如 TEST_ACCOUNT" />
              <input v-model="entry.value" type="password" class="settings-input env-value" placeholder="变量值" />
              <button class="btn btn-soft" @click="removeEnvEntry(index)">删除</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ===== 质量看板视图（PRD 功能二片3） ===== -->
    <div v-else-if="view === 'dashboard'" class="detail-view">
      <button class="back" @click="go('home')">← 返回首页</button>
      <div class="head-row">
        <div><h1 class="detail-title">质量看板</h1><p class="detail-sub" style="margin:0">5 维度按周预聚合趋势 · 下钻 · 突变告警</p></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-soft" :class="{ active: dashboardRange === 'week' }" @click="switchDashboardRange('week')">周视图</button>
          <button class="btn btn-soft" :class="{ active: dashboardRange === 'month' }" @click="switchDashboardRange('month')">月视图</button>
          <button class="btn btn-soft" @click="loadDashboard">刷新</button>
        </div>
      </div>

      <div v-if="dashboardLoading" class="card panel muted">加载中…</div>
      <div v-else-if="!dashboardPoints.length" class="card panel muted">暂无质量数据（完成测试任务后会自动聚合）</div>
      <template v-else>
        <!-- 突变告警区 -->
        <section v-if="dashboardAnomalies.length" class="card panel" style="margin-bottom:16px;border-left:4px solid var(--amber)">
          <div class="section-head" style="margin-top:0"><h2 style="color:var(--amber)">⚠ 突变告警</h2><span class="hint">{{ dashboardAnomalies.length }} 条</span></div>
          <div v-for="(alert, i) in dashboardAnomalies" :key="i" class="anomaly-alert">
            <span class="severity medium">{{ alert.dimension === 'flakyRate' ? 'Flaky率突变' : '通过率突变' }}</span>
            <span class="muted" style="margin-left:8px">{{ alert.weekStart.slice(0, 10) }}</span>
            <p style="margin:4px 0 0">{{ alert.message }}</p>
          </div>
        </section>

        <!-- 系统级：5 维度趋势 -->
        <template v-if="dashboardDrillLevel === 'system'">
          <div class="section-head"><h2>5 维度趋势（系统级）</h2><span class="hint">{{ dashboardPoints.length }} 周</span></div>
          <div class="dash-grid">
            <!-- 通过率 -->
            <section class="card panel dash-card" @click="drillToModule('passRate')">
              <div class="section-head" style="margin-top:0"><h3>通过率</h3><span class="hint">点击下钻</span></div>
              <div class="trend-chart">
                <div v-for="(pt, i) in dashboardPassRateTrend" :key="i" class="trend-bar-wrap">
                  <div class="trend-bar" :style="{ height: `${pt.value}%` }"></div>
                  <span class="trend-value">{{ pt.value }}%</span>
                  <span class="trend-label">{{ pt.label }}</span>
                </div>
              </div>
            </section>
            <!-- 失败分类占比 -->
            <section class="card panel dash-card" @click="drillToModule('failCategory')">
              <div class="section-head" style="margin-top:0"><h3>失败分类占比</h3><span class="hint">点击下钻</span></div>
              <div class="fail-cat-chart">
                <div v-for="(pt, i) in dashboardFailCategoryTrend" :key="i" class="fail-cat-col">
                  <div class="fail-cat-bar real-bug" :style="{ height: `${pt['real-bug']}%` }" :title="`real-bug ${pt['real-bug']}%`"></div>
                  <div class="fail-cat-bar test-defect" :style="{ height: `${pt['test-defect']}%` }" :title="`test-defect ${pt['test-defect']}%`"></div>
                  <div class="fail-cat-bar environment" :style="{ height: `${pt.environment}%` }" :title="`environment ${pt.environment}%`"></div>
                  <div class="fail-cat-bar flaky" :style="{ height: `${pt.flaky}%` }" :title="`flaky ${pt.flaky}%`"></div>
                  <span class="trend-label">{{ pt.label }}</span>
                </div>
              </div>
              <div class="fail-cat-legend">
                <span class="fail-cat-legend-item"><span class="dot real-bug"></span>real-bug</span>
                <span class="fail-cat-legend-item"><span class="dot test-defect"></span>test-defect</span>
                <span class="fail-cat-legend-item"><span class="dot environment"></span>environment</span>
                <span class="fail-cat-legend-item"><span class="dot flaky"></span>flaky</span>
              </div>
            </section>
            <!-- Flaky 率 -->
            <section class="card panel dash-card" @click="drillToModule('flakyRate')">
              <div class="section-head" style="margin-top:0"><h3>Flaky 率</h3><span class="hint">点击下钻</span></div>
              <div class="trend-chart">
                <div v-for="(pt, i) in dashboardFlakyRateTrend" :key="i" class="trend-bar-wrap">
                  <div class="trend-bar" :style="{ height: `${Math.min(pt.value, 100)}%`, background: 'var(--amber)' }"></div>
                  <span class="trend-value">{{ pt.value }}%</span>
                  <span class="trend-label">{{ pt.label }}</span>
                </div>
              </div>
            </section>
            <!-- 平均执行时长 -->
            <section class="card panel dash-card" @click="drillToModule('avgDuration')">
              <div class="section-head" style="margin-top:0"><h3>平均执行时长</h3><span class="hint">点击下钻</span></div>
              <div class="trend-chart">
                <div v-for="(pt, i) in dashboardDurationTrend" :key="i" class="trend-bar-wrap">
                  <div v-if="pt.value !== null" class="trend-bar" :style="{ height: `${Math.min(pt.value, 100)}%`, background: 'var(--violet)' }"></div>
                  <div v-else class="trend-bar" style="height:2px;background:var(--line)"></div>
                  <span class="trend-value">{{ pt.value !== null ? `${pt.value}s` : 'N/A' }}</span>
                  <span class="trend-label">{{ pt.label }}</span>
                </div>
              </div>
            </section>
            <!-- Token 成本 -->
            <section class="card panel dash-card" @click="drillToModule('tokenCost')">
              <div class="section-head" style="margin-top:0"><h3>Token 成本</h3><span class="hint">点击下钻</span></div>
              <div v-if="dashboardTokenTrend.every((p) => p.value === null)" class="muted" style="padding:20px 0;text-align:center">数据积累中</div>
              <div v-else class="trend-chart">
                <div v-for="(pt, i) in dashboardTokenTrend" :key="i" class="trend-bar-wrap">
                  <div v-if="pt.value !== null" class="trend-bar" :style="{ height: `${Math.min((pt.value / Math.max(...dashboardTokenTrend.map((t) => t.value ?? 1))) * 100, 100)}%`, background: 'var(--green)' }"></div>
                  <div v-else class="trend-bar" style="height:2px;background:var(--line)"></div>
                  <span class="trend-value">{{ pt.value !== null ? pt.value.toLocaleString() : 'N/A' }}</span>
                  <span class="trend-label">{{ pt.label }}</span>
                </div>
              </div>
            </section>
          </div>
        </template>

        <!-- 模块级下钻 -->
        <template v-if="dashboardDrillLevel === 'module'">
          <div class="section-head">
            <h2>模块级下钻：{{ dashboardDimLabel }}</h2>
            <button class="btn btn-soft" @click="drillReset">← 返回系统级</button>
          </div>
          <div v-if="!dashboardModuleBreakdown.length" class="card panel muted">暂无模块分组数据（需有用例 layer 信息）</div>
          <div v-else class="stat-grid">
            <div v-for="m in dashboardModuleBreakdown" :key="m.layer" class="card stat dash-module-card" @click="drillToCase(m.layer)">
              <div class="num" :class="moduleNumClass(m)">{{ moduleDisplayValue(m) }}</div>
              <div class="lbl">{{ m.layer }}（{{ m.total }} 用例）</div>
              <span v-if="dashboardDrillDim !== 'passRate' && dashboardDrillDim !== 'flakyRate'" class="hint">降级显示通过率 · 点击查看用例</span>
              <span v-else class="hint">点击查看用例</span>
            </div>
          </div>
        </template>

        <!-- 用例级下钻 -->
        <template v-if="dashboardDrillLevel === 'case'">
          <div class="section-head">
            <h2>用例级（{{ dashboardDrillLayer || '全部' }}）</h2>
            <button class="btn btn-soft" @click="drillReset">← 返回系统级</button>
          </div>
          <div v-if="!dashboardCaseBreakdown.length" class="card panel muted">暂无用例数据</div>
          <table v-else class="data-table">
            <thead><tr><th>用例标题</th><th>分层</th><th>目标</th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in dashboardCaseBreakdown" :key="i">
                <td>{{ c.title }}</td>
                <td>{{ c.layer }}</td>
                <td>{{ c.target ?? '--' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </div>

    <!-- ===== P3-1 回归套件视图 ===== -->
    <SuitesPanel v-else-if="view === 'suites'"
      :suites="suites"
      :suite-running="suiteRunning"
      :suite-run-results="suiteRunResults"
      :expanded-suite-results="expandedSuiteResults"
      :project-path="form.projectPath"
      @back="go('home')"
      @run="runSuiteNow"
      @toggle-result="toggleSuiteResult"
      @delete="deleteSuiteById"
    />

    <ScenariosPanel v-else-if="view === 'scenarios'"
      :scenario-files="scenarioFiles"
      :project-path="form.projectPath"
      :load-scenario="loadScenarioJson"
      @back="go('home')"
      @save="saveScenarioFromPanel"
      @delete="deleteScenarioFile"
      @export-all="exportScenarios"
      @import-scenarios="importScenariosFromPanel"
      @refresh="loadScenarioFiles"
    />

    </div>
    <aside v-if="view === 'fix' || view === 'diagnosis'" class="role-sidebar" :class="{ 'role-sidebar-compact': !showRoleSidebarFull }">
      <template v-if="!showRoleSidebarFull">
        <!-- 精简模式：调度器状态 + escalation 徽标（点击跳转执行页答复） -->
        <div class="coordinator-card">
          <div class="coordinator-head">
            <span class="coordinator-icon">🎯</span>
            <span class="coordinator-title">调度器</span>
          </div>
          <div class="coordinator-status">{{ coordinatorStatus || '等待启动' }}</div>
          <div v-if="runningWorkers.length" class="coordinator-running-count">
            {{ runningWorkers.length }} 个角色运行中
            <span v-if="runningWorkers.length > 1" class="parallel-badge">并行</span>
          </div>
        </div>
        <div v-if="hasEscalationPending()" class="esc-badge-compact" @click="go('run')">
          ⚠ 待答 ×{{ escalationPendings.length }}
        </div>
      </template>
      <template v-else>
        <!-- 完整模式：角色卡片 + 调度消息 + escalation 答复（现有行为） -->
        <div class="coordinator-card">
          <div class="coordinator-head">
            <span class="coordinator-icon">🎯</span>
            <span class="coordinator-title">调度器</span>
          </div>
          <div class="coordinator-status">{{ coordinatorStatus || '等待启动' }}</div>
          <div v-if="runningWorkers.length" class="coordinator-running-count">
            {{ runningWorkers.length }} 个角色运行中
            <span v-if="runningWorkers.length > 1" class="parallel-badge">并行</span>
          </div>
        </div>
        <div v-if="recentDispatchMessages.length && coordinatorActive" class="dispatch-flow">
          <div class="dispatch-flow-head">调度消息</div>
          <div class="dispatch-flow-list">
            <div v-for="msg in recentDispatchMessages" :key="msg.id" class="dispatch-item" :class="`dispatch-${msg.type}`">
              <span class="dispatch-icon">{{ msg.type === 'dispatch' ? '📡' : msg.type === 'ask' ? '❓' : msg.type === 'reply' ? '💬' : '✅' }}</span>
              <span class="dispatch-route">{{ displayRoleName(msg.from) }} → {{ displayRoleName(msg.to) }}</span>
              <span class="dispatch-content">{{ msg.content }}</span>
              <span class="dispatch-time">{{ new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
            </div>
          </div>
        </div>
        <div class="role-sidebar-head">角色</div>
        <div
          v-for="role in roleOrder"
          :key="role"
          class="role-card"
          :class="{ active: selectedRole === role }"
          @click="selectedRole = selectedRole === role ? null : role"
        >
          <div class="role-card-head">
            <span class="role-card-name">{{ displayRoleName(role) }}</span>
            <span class="role-status-badge" :class="`status-${roleStates[role]?.status ?? 'idle'}`">{{ { idle: '●', running: '▶', done: '✓', escalating: '⚠' }[roleStates[role]?.status ?? 'idle'] ?? '●' }}</span>
          </div>
          <div class="role-card-meta">
            <span v-if="roleStates[role]?.lastTool" class="muted">当前操作：{{ roleStates[role]?.lastTool }}</span>
            <span v-else class="muted">{{ roleStates[role]?.status === 'running' ? '等待工作内容…' : '暂无操作' }}</span>
          </div>
          <div v-if="roleStates[role]?.escalationCount" class="role-card-esc">⚠ 待答复 ×{{ roleStates[role]?.escalationCount }}</div>
        </div>
        <button v-if="selectedRole" class="btn btn-soft role-reset-btn" @click="selectedRole = null">显示全部角色</button>
      </template>
    </aside>
  </main>
  <div v-if="libraryDeleteIntent" class="app-modal-backdrop" @click.self="!libraryDeleteBusy && (libraryDeleteIntent = null)">
    <section class="app-modal" role="alertdialog" aria-modal="true" aria-labelledby="library-delete-title" aria-describedby="library-delete-description">
      <div class="app-modal-icon">!</div>
      <div class="app-modal-content">
        <h2 id="library-delete-title">{{ libraryDeleteIntent.kind === 'all' ? (libraryDeleteIntent.count ? '清空当前项目用例库？' : '清理遗留生成测试？') : '删除这条用例？' }}</h2>
        <p id="library-delete-description" v-if="libraryDeleteIntent.kind === 'all'">将清空 {{ libraryDeleteIntent.count }} 条用例及关联反射场景，并清理 {{ libraryDeleteIntent.removableFiles.length }} 个可确认由 Test Agent 生成的未跟踪测试文件。</p>
        <p id="library-delete-description" v-else>“{{ libraryDeleteIntent.item.title }}”将从当前项目用例库中移除。</p>
        <p v-if="libraryDeleteIntent.kind === 'all' && libraryDeleteIntent.protectedFiles.length" class="app-modal-note">另有 {{ libraryDeleteIntent.protectedFiles.length }} 个相关文件因已被 Git 跟踪或归属不明确，将保留。</p>
        <p v-else-if="libraryDeleteIntent.kind === 'all'" class="app-modal-note">项目源码、Git 已跟踪测试和无法证明归属的文件都会保留。</p>
        <p v-else class="app-modal-note">不会删除项目源码或已有 JUnit 文件。</p>
        <div class="app-modal-actions">
          <button class="btn btn-soft" :disabled="libraryDeleteBusy" @click="libraryDeleteIntent = null">取消</button>
          <button class="btn app-modal-danger" :disabled="libraryDeleteBusy" @click="confirmLibraryDeletion">{{ libraryDeleteBusy ? '处理中…' : libraryDeleteIntent.kind === 'all' ? (libraryDeleteIntent.count ? `清空 ${libraryDeleteIntent.count} 条用例并清理文件` : `清理 ${libraryDeleteIntent.removableFiles.length} 个生成文件`) : '删除此用例' }}</button>
        </div>
      </div>
    </section>
  </div>
  <div v-if="regeneratePlanIntent" class="app-modal-backdrop" @click.self="regeneratePlanIntent = false">
    <section class="app-modal" role="alertdialog" aria-modal="true" aria-labelledby="regenerate-plan-title" aria-describedby="regenerate-plan-description">
      <div class="app-modal-icon">!</div>
      <div class="app-modal-content">
        <h2 id="regenerate-plan-title">重新生成测试计划？</h2>
        <p id="regenerate-plan-description">将重新分析当前项目，并用新计划替换现有的 {{ completedPlannedCases.length }} 条计划。</p>
        <p class="app-modal-note">不会删除项目源码、已有 JUnit 文件或已保存用例。当前计划在新任务开始后将不再保留。</p>
        <div class="app-modal-actions">
          <button class="btn btn-soft" @click="regeneratePlanIntent = false">取消</button>
          <button class="btn btn-primary" @click="confirmRegeneratePlan">确认重新生成</button>
        </div>
      </div>
    </section>
  </div>
  <div v-if="view !== 'home'" class="host-pill" :class="{ off: !localStatus.running }"><span class="dot"></span>{{ localStatus.running ? '本机 Host 在线' : '本机 Host 未就绪' }}</div>
</template>

<style>
/* ===== 切片 2-4：角色可视化 CSS（不引外部库，纯 flex + 箭头字符） ===== */

/* 侧栏布局：shell 在 run/fix/diagnosis view 变 flex 行 */
.shell-with-sidebar {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.shell-with-sidebar > .detail-view {
  flex: 1;
  min-width: 0;
}

/* ===== P0 工作台布局：左导航 + 中工作区 + 右栏 ===== */
.shell-with-nav {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.workspace-nav {
  width: 180px;
  flex-shrink: 0;
  position: sticky;
  top: 70px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.workspace-nav-head {
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 2px;
}
.nav-home-link { cursor: pointer; transition: color .15s; }
.nav-home-link:hover { color: var(--blue); }
/* ===== P1-1：项目列表 + 套件树 + view 图标条 ===== */
.nav-section { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.nav-section-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .04em;
  padding: 4px 8px 2px;
}
.nav-project {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.nav-project:hover { border-color: var(--blue); }
.nav-project.active { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(37,99,235,.12); }
.nav-project-name { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-project-meta { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-empty { font-size: 11px; color: var(--muted); padding: 4px 10px; }
.nav-suite { display: flex; flex-direction: column; }
.nav-suite-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.nav-suite-head:hover { color: var(--blue); }
.nav-toggle { width: 10px; color: var(--muted); }
.nav-suite-layer { flex: 1; }
.nav-suite-count { font-size: 10px; color: var(--muted); font-weight: 400; }
.nav-suite-cases { display: flex; flex-direction: column; gap: 1px; padding-left: 18px; }
.nav-case {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 11px;
  color: var(--text);
  border-radius: 4px;
}
.nav-case:hover { background: var(--hover-bg, rgba(0,0,0,.06)); }
.nav-case-scenario { font-size: 10px; }
.nav-case-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-view-bar {
  display: flex;
  gap: 2px;
  padding: 8px 4px 0;
  margin-top: auto;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.nav-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  cursor: pointer;
  font-size: 14px;
}
.nav-icon:hover { border-color: var(--blue); }
.nav-icon.active { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(37,99,235,.12); }
/* ===== P1-0：工作台首页重设 ===== */
.home-title { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
.active-task-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-left: 3px solid var(--blue);
  margin-bottom: 12px;
}
.active-task-info { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.active-task-dot { color: var(--blue); animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.active-task-name { font-weight: 700; }
.active-task-phase { color: var(--muted); }
.active-task-actions { display: flex; gap: 6px; }
.guide { color: var(--muted); }
.task-summary-bar {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  background: var(--hover-bg, rgba(0,0,0,.04));
  padding: 6px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.project-card-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.project-card {
  flex: 1 1 180px;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  cursor: pointer;
  text-align: left;
  border: 1px solid var(--line);
}
.project-card:hover { border-color: var(--blue); }
.project-card.active { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
.project-card-name { font-size: 14px; font-weight: 700; }
.project-card-meta { font-size: 11px; color: var(--muted); }
.project-card-time { font-size: 10px; color: var(--muted); }
.recent-run-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.recent-run-card { cursor: pointer; padding: 10px 12px; }
.recent-run-card:hover { border-color: var(--blue); }
.recent-run-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.recent-run-name { font-size: 13px; font-weight: 700; }
.recent-run-branch { font-size: 11px; color: var(--muted); }
.recent-run-time { font-size: 11px; color: var(--muted); margin-left: auto; }
.recent-run-status { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 8px; }
.recent-run-status.completed { color: var(--green); background: var(--green-bg); }
.recent-run-status.failed { color: var(--danger, #e53935); background: rgba(229,57,53,.1); }
.recent-run-status.cancelled { color: var(--muted); background: var(--hover-bg, rgba(0,0,0,.06)); }
.recent-run-body { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.recent-run-stat { font-size: 12px; font-weight: 600; }
.recent-run-stat.green { color: var(--green); }
.recent-run-stat.red { color: var(--danger, #e53935); }
.recent-run-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--hover-bg, rgba(0,0,0,.06));
  color: var(--text);
  cursor: pointer;
  transition: background .15s;
}
.recent-run-chip:hover { background: var(--blue); color: #fff; }
.quick-start-mini { padding: 14px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  transition: border-color .15s, box-shadow .15s;
  text-align: left;
  width: 100%;
}
.nav-item:hover {
  border-color: var(--blue);
}
.nav-item.active {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(37,99,235,.12);
  background: var(--blue-bg);
}
.workspace-main {
  flex: 1;
  min-width: 0;
}
/* 右栏精简模式（非执行 view） */
.role-sidebar-compact {
  width: 160px;
}
.esc-badge-compact {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--amber-bg);
  border: 1px solid var(--amber);
  color: var(--amber);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  text-align: center;
  transition: box-shadow .15s;
}
.esc-badge-compact:hover {
  box-shadow: 0 0 0 3px rgba(245,158,11,.15);
}

/* 左侧栏角色卡片 */
.role-sidebar {
  width: 200px;
  flex-shrink: 0;
  position: sticky;
  top: 70px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.role-sidebar-head {
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 2px;
}
.role-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.role-card:hover {
  border-color: var(--blue);
}
.role-card.active {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(37,99,235,.12);
}
.role-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.role-card-name {
  font-weight: 600;
  font-size: 13px;
}
.role-card-meta {
  margin-top: 4px;
  font-size: 11px;
}
.role-card-esc {
  margin-top: 3px;
  font-size: 11px;
  color: var(--amber);
}
.role-reset-btn {
  margin-top: 2px;
  font-size: 12px;
  padding: 7px 10px;
  text-align: center;
}

/* 状态徽章 */
.role-status-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: .3px;
}
.status-idle { background: #eef1f6; color: var(--muted); }
.status-running { background: var(--blue-bg); color: var(--blue); }
.status-done { background: var(--green-bg); color: var(--green); }
.status-escalating { background: var(--amber-bg); color: var(--amber); }

/* 切片 4：角色互动流转图 */
.role-flow {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 14px 16px;
  margin-bottom: 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 13px;
}
.role-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
}
.role-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #cbd2de;
  flex-shrink: 0;
}
.role-node.status-running .role-dot { background: var(--blue); }
.role-node.status-done .role-dot { background: var(--green); }
.role-node.status-escalating .role-dot { background: var(--amber); }
.role-node.status-idle .role-dot { background: #cbd2de; }
.role-node-label {
  font-size: 12px;
  font-weight: 600;
}
.role-arrow {
  font-size: 14px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.role-arrow-esc {
  font-size: 13px;
}

/* running 角色脉冲动画 */
.role-node.status-running .role-dot {
  animation: role-pulse 1.4s ease-in-out infinite;
}
@keyframes role-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,.4); }
  50% { box-shadow: 0 0 0 5px rgba(37,99,235,0); }
}

/* ===== 切片 3A-B：Planner 调度卡片 + 多 worker 并行可视化 ===== */
.coordinator-card {
  background: linear-gradient(135deg, var(--blue-bg), var(--panel));
  border: 2px solid var(--blue);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 4px;
}
.coordinator-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.coordinator-icon {
  font-size: 18px;
}
.coordinator-title {
  font-weight: 700;
  font-size: 13px;
  color: var(--blue);
}
.coordinator-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
}
.coordinator-running-count {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.parallel-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--green);
  color: #fff;
  text-transform: uppercase;
  letter-spacing: .3px;
}

/* ===== 切片 3C：调度消息流 CSS ===== */
.dispatch-flow {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 4px;
  max-height: 240px;
  overflow-y: auto;
}
.dispatch-flow-head {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 6px;
}
.dispatch-flow-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dispatch-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 6px;
  background: #f8f9fb;
  flex-wrap: wrap;
}
.dispatch-icon {
  font-size: 12px;
  flex-shrink: 0;
}
.dispatch-route {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.dispatch-content {
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dispatch-time {
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
  white-space: nowrap;
}
/* 类型颜色区分 */
.dispatch-dispatch {
  border-left: 3px solid var(--blue);
}
.dispatch-ask {
  border-left: 3px solid var(--amber);
}
.dispatch-report {
  border-left: 3px solid var(--green);
}

/* ===== 切片 3D：SVG 分支图 CSS ===== */
.role-flow-with-branches {
  margin-bottom: 16px;
}
.tester-branch-svg {
  width: 100%;
  max-width: 480px;
  height: 110px;
  display: block;
  margin: 4px auto 0;
}
.branch-line {
  stroke: var(--line);
  stroke-width: 1.5;
  fill: none;
}
.branch-arrow {
  stroke: var(--muted);
  stroke-width: 2;
  marker-end: url(#branch-arrow);
}
.branch-node {
  fill: var(--panel);
  stroke: var(--line);
  stroke-width: 1.5;
}
.branch-node.branch-running {
  stroke: var(--blue);
  fill: var(--blue-bg);
  animation: branch-pulse 1.4s ease-in-out infinite;
}
@keyframes branch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .6; }
}
.branch-text {
  font-size: 10px;
  fill: var(--text);
  font-weight: 600;
}
/* ===== P0 backend-耦合波：执行模式选择 ===== */
.meta-label {
  font-size: 12px;
  color: var(--text);
  opacity: .7;
  margin-right: 4px;
}
/* ===== P0 项1+2：JSON 场景查看/编辑面板 ===== */
.scenario-toggle {
  display: inline-block;
  cursor: pointer;
  color: var(--amber);
  margin-right: 6px;
  user-select: none;
  font-weight: 600;
}
.scenario-toggle:hover { opacity: .8; }
.scenario-row > td { padding: 0 8px 12px; }
.scenario-panel {
  background: var(--card-bg, rgba(0,0,0,.04));
  border: 1px solid var(--border, rgba(0,0,0,.1));
  border-radius: 6px;
  padding: 10px 12px;
}
.scenario-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.scenario-label {
  font-size: 12px;
  font-weight: 600;
  opacity: .8;
  margin-right: auto;
}
.btn-sm { padding: 2px 8px; font-size: 12px; }
.scenario-json {
  margin: 0;
  padding: 10px;
  background: rgba(0,0,0,.06);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}
.scenario-editor {
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  background: rgba(0,0,0,.06);
  border: 1px solid var(--border, rgba(0,0,0,.2));
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre;
  overflow: auto;
  resize: vertical;
}
.scenario-errors {
  margin-top: 8px;
  color: var(--danger, #e53935);
  font-size: 12px;
}
/* ===== P0 项3：执行控制条 ===== */
.exec-controls { margin-bottom: 16px; }
.exec-controls-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.exec-controls-row .cell-select { min-width: 240px; }
.rerun-output {
  margin: 10px 0 0;
  padding: 10px;
  background: rgba(0,0,0,.06);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 360px;
  overflow: auto;
}
/* ===== P0 项4：失败诊断代码位置 + 重跑按钮 ===== */
.diag-location {
  margin: 6px 0;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--amber);
  opacity: .9;
}
.diag-rerun-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
/* ===== P1-2：批量只跑失败结果展示 ===== */
.batch-rerun-result { margin-bottom: 12px; }
.batch-summary {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.batch-result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--border, rgba(0,0,0,.08));
  flex-wrap: wrap;
}
.batch-status { font-size: 14px; }
.batch-name { font-size: 13px; }
.batch-error { font-size: 12px; color: var(--danger, #e53935); }
.batch-output {
  flex-basis: 100%;
  margin: 6px 0 0;
  padding: 8px;
  background: rgba(0,0,0,.06);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
}
/* ===== P3-1：回归套件视图 ===== */
.suite-list { display: flex; flex-direction: column; gap: 12px; }
.suite-card { padding: 16px; }
.suite-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.suite-name { font-size: 15px; font-weight: 700; }
.suite-strategy { font-size: 12px; color: var(--violet); background: rgba(0,0,0,.06); padding: 2px 8px; border-radius: 10px; }
.suite-count { font-size: 12px; color: var(--muted); }
.suite-card-meta { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.suite-card-actions { display: flex; gap: 8px; }
.suite-results { margin-top: 12px; border-top: 1px solid var(--border, rgba(0,0,0,.08)); padding-top: 10px; }
.suite-results-summary { display: flex; gap: 12px; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.suite-result-row { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 13px; }
.suite-result-row.suite-result-fail { background: rgba(229,57,53,.06); border-radius: 4px; padding: 4px 6px; }
.suite-result-name { flex: 0 1 auto; }
.suite-result-error-wrap { flex: 1; min-width: 0; }
.suite-result-error { font-size: 12px; color: var(--danger, #e53935); cursor: pointer; }
.suite-result-error-full { margin: 4px 0 0; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: rgba(229,57,53,.08); border-radius: 4px; max-height: 200px; overflow: auto; }
/* P3-2 场景文件管理 */
.head-row-actions { display: flex; gap: 8px; }
.scenario-file-list { display: flex; flex-direction: column; gap: 8px; }
.scenario-file-card { padding: 12px 16px; }
.scenario-file-head { display: flex; align-items: center; gap: 8px; }
.scenario-file-id { font-weight: 600; font-size: 13px; }
.scenario-file-title { font-size: 12px; opacity: .7; flex: 1; }
.scenario-file-actions { display: flex; gap: 6px; }
.scenario-file-edit { margin-top: 8px; }
.scenario-json-textarea { width: 100%; font-family: monospace; font-size: 12px; border: 1px solid var(--border, rgba(0,0,0,.08)); border-radius: 4px; padding: 8px; box-sizing: border-box; resize: vertical; }
.scenario-import-textarea { width: 100%; font-family: monospace; font-size: 12px; border: 1px solid var(--border, rgba(0,0,0,.08)); border-radius: 4px; padding: 8px; box-sizing: border-box; resize: vertical; }
/* P3-4：失败用例截图/录像展示 */
.diag-screenshot { margin-top: 8px; display: flex; align-items: center; gap: 8px; }
.diag-shot-thumb { width: 120px; height: auto; max-height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border, rgba(0,0,0,.12)); cursor: pointer; }
.diag-shot-thumb:hover { border-color: var(--accent, #4f8cff); }
.diag-no-screenshot { margin-top: 8px; }
.diag-video-link { margin-top: 4px; }
/* P3-5：跳过用例控制 */
.skip-controls { margin-top: 12px; border-top: 1px solid var(--border, rgba(0,0,0,.08)); padding-top: 10px; }
.skip-controls-head { margin-bottom: 6px; }
.skip-cases-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.skip-case-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.skip-case-item:hover { background: var(--hover, rgba(0,0,0,.04)); }
.skip-case-item.skipped { opacity: .55; text-decoration: line-through; }
.skip-case-id { font-family: monospace; font-size: 12px; color: var(--muted, #888); min-width: 60px; }
.skip-case-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skip-badge { font-size: 11px; color: var(--amber, #d97706); }
/* P4-1-a：首页三入口行动卡 */
.home-action-row { display: flex; gap: 12px; margin-bottom: 16px; }
.action-card { flex: 1; cursor: pointer; padding: 16px; text-align: center; transition: border-color 0.2s, box-shadow 0.2s; }
.action-card:hover { border-color: var(--accent, #4f46e5); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
.action-card .action-icon { font-size: 24px; }
.action-card h2 { margin: 8px 0 4px; font-size: 15px; }
.action-card p { margin: 0; font-size: 12px; color: var(--muted, #888); }
.action-card-disabled { opacity: .5; cursor: default; }
.action-card-disabled:hover { border-color: var(--border, rgba(0,0,0,.08)); box-shadow: none; }

/* 工作台信息层级：侧栏只放导航和概览，不承载整份用例清单。 */
.shell { max-width: 1600px; }
.shell-with-nav { gap: 26px; }
.workspace-nav { width: 218px; top: 22px; max-height: calc(100vh - 44px); overflow-y: auto; padding: 16px 12px; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
.nav-sidebar-title { padding: 6px 10px 8px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.nav-home-item { margin-bottom: 12px; }
.nav-section { margin-bottom: 16px; }
.nav-section-label { padding: 6px 10px; font-size: 11px; }
.nav-recent-label { margin-top: 12px; }
.nav-current-project { padding: 10px; border-radius: 9px; background: #f3f6fb; min-width: 0; }
.nav-current-project strong, .nav-current-project small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-current-project strong { font-size: 13px; }
.nav-current-project small { margin-top: 4px; color: var(--muted); font-size: 11px; }
.nav-project { border-color: transparent; background: transparent; }
.nav-project.active { border-color: #bfdbfe; background: var(--blue-bg); box-shadow: none; }
.nav-case-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 0; width: 100%; padding: 6px; border: 1px solid var(--line); border-radius: 9px; background: #fff; color: var(--text); text-align: left; }
.nav-case-metric { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 5px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.nav-case-metric:hover:not(:disabled), .nav-case-metric:focus-visible { background: var(--blue-bg); outline: none; }
.nav-case-metric:disabled { opacity: .45; cursor: not-allowed; }
.nav-case-metric + .nav-case-metric { padding-left: 9px; border-left: 1px solid var(--line); }
.nav-case-summary strong { color: var(--blue); font-size: 20px; line-height: 1.1; }
.nav-case-summary small { color: var(--muted); font-size: 11px; white-space: nowrap; }
.nav-view-bar { display: grid; grid-template-columns: 1fr; gap: 3px; padding: 12px 0 0; }
.nav-icon { width: 100%; height: auto; justify-content: flex-start; padding: 9px 10px; border-color: transparent; font-size: 12px; font-weight: 600; text-align: left; }
.nav-icon.active { border-color: #bfdbfe; background: var(--blue-bg); color: var(--blue); box-shadow: none; }
.nav-icon:disabled, .nav-case-summary:disabled { opacity: .45; cursor: not-allowed; }
.nav-menu-count { margin-left: auto; padding: 1px 6px; border-radius: 999px; background: #eef2f7; color: var(--muted); font-size: 10px; }
.workspace-main { max-width: none; }

.eyebrow { color: var(--blue); font-size: 10px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
.home-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 20px; }
.home-heading .home-title { margin: 5px 0 4px; font-size: 27px; }
.home-heading p { margin: 0; color: var(--muted); font-size: 13px; }
.home-host-state { padding: 7px 10px; border-radius: 999px; background: var(--green-bg); color: var(--green); font-size: 11px; font-weight: 700; white-space: nowrap; }
.home-host-state.off { background: var(--amber-bg); color: var(--amber); }
.start-block-reason { max-width: 220px; color: #875014; font-size: 11px; line-height: 1.4; text-align: right; }
.tag-button { font: inherit; }
.home-project-overview { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 22px 24px; }
.home-project-overview h2 { margin: 4px 0; font-size: 21px; }
.home-project-overview p { margin: 0; max-width: 650px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.home-project-facts { display: flex; gap: 8px; flex-wrap: wrap; }
.home-project-facts span { padding: 7px 10px; border-radius: 7px; background: #f3f6fb; color: var(--muted); font-size: 11px; white-space: nowrap; }
.home-section-head { margin-top: 24px; }
.home-action-row { align-items: stretch; }
.action-card { min-width: 0; min-height: 158px; display: flex; flex-direction: column; align-items: flex-start; padding: 20px; text-align: left; color: var(--text); }
.action-card-selected { border-color: #b8ccff; background: linear-gradient(145deg, #fff, #f1f5ff); box-shadow: 0 0 0 1px #b8ccff inset; }
.action-card .action-kicker { color: var(--blue); font-size: 11px; font-weight: 700; }
.action-card h2 { margin: 14px 0 6px; font-size: 17px; }
.action-card p { line-height: 1.5; }
.action-card .action-link { margin-top: auto; padding-top: 14px; color: var(--blue); font-size: 12px; font-weight: 700; }
.action-card:disabled { opacity: .55; cursor: not-allowed; }

.plan-overview { padding: 22px 24px; margin: 18px 0; }
.plan-collection-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
.plan-collection-tabs button { display: grid; grid-template-columns: 1fr auto; gap: 4px 14px; min-width: 0; padding: 15px 17px; border: 1px solid var(--line); border-radius: 11px; background: #fff; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.plan-collection-tabs button:hover { border-color: #a9c1f7; }
.plan-collection-tabs button.active { border-color: var(--blue); background: var(--blue-bg); box-shadow: inset 0 0 0 1px rgba(47, 108, 246, .08); }
.plan-collection-tabs span { font-size: 14px; font-weight: 750; }
.plan-collection-tabs strong { grid-row: span 2; align-self: center; color: var(--blue); font-size: 24px; line-height: 1; }
.plan-collection-tabs small { color: var(--muted); font-size: 11px; }
.page-empty-state { padding: 38px 40px; margin-top: 20px; }
.page-empty-state h2 { margin: 10px 0 8px; font-size: 20px; }
.page-empty-state p { max-width: 600px; margin: 0 0 22px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.page-empty-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.plan-overview-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.plan-overview-header h2 { margin: 5px 0 0; font-size: 21px; }
.plan-count { padding: 8px 12px; border-radius: 999px; background: var(--blue-bg); color: var(--blue); font-weight: 700; font-size: 12px; }
.plan-overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; padding-top: 20px; margin-top: 18px; border-top: 1px solid var(--line); }
.plan-overview-grid div { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.plan-overview-grid span { color: var(--muted); font-size: 11px; }
.plan-overview-grid strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.plan-overview-note { margin: 18px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--amber-bg); color: #875014; font-size: 12px; }
.plan-impact-preview { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-top: 14px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 9px; background: #f8faff; color: var(--muted); font-size: 12px; }
.plan-impact-preview strong { color: var(--text); font-size: 14px; }
.plan-impact-warning { color: #a44917; font-weight: 700; }
.report-evidence-note { margin: 18px 0; padding: 16px 20px; border-left: 3px solid var(--blue); }
.report-evidence-note strong { font-size: 13px; }
.report-evidence-note p { margin: 8px 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.report-evidence-note span { color: var(--text); font-size: 12px; font-weight: 600; }
.timeline-count { padding: 2px 7px; border-radius: 999px; background: #eef2f7; color: var(--muted); font-size: 11px; font-weight: 700; }
.execution-summary-section .section-head { align-items: flex-end; }
.execution-summary-section .section-head h2 { margin-bottom: 4px; }
.execution-summary-section .section-head p { margin: 0; }
.timeline-description { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.timeline-message { margin-top: 7px; padding: 8px 10px; border-radius: 7px; background: #f6f8fb; color: var(--muted); font-size: 11px; line-height: 1.5; }
.report-metrics-panel { display: grid; gap: 7px; }
.report-metric-head { display: flex; justify-content: space-between; margin-top: 7px; }
.report-metric-head:first-child { margin-top: 0; }
.report-metric-empty, .report-success-empty, .report-data-unavailable { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 18px; }
.report-metric-empty p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.report-data-unavailable { border-color: #efd6a7; background: #fffaf0; }
.report-data-unavailable p { max-width: 820px; margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.report-coverage-note { margin: 10px 2px 0; }
.report-success-empty { border-color: #ccebd8; background: #f5fcf7; color: #137a37; font-size: 13px; font-weight: 600; }
.report-neutral-empty { padding: 15px 18px; color: var(--muted); font-size: 13px; }
.report-secondary-details { overflow: hidden; }
.report-secondary-details > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; cursor: pointer; font-size: 13px; font-weight: 700; }
.report-secondary-body { padding: 0 16px 16px; border-top: 1px solid var(--line); }
.report-secondary-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }
.report-secondary-empty { margin: 4px 0 0; font-size: 12px; }
@media (max-width: 700px) { .report-metric-empty, .report-data-unavailable { align-items: flex-start; flex-direction: column; } }
.plan-error { padding: 12px 16px; border: 1px solid #f1bbb5; border-radius: 9px; background: #fff3f1; color: #a12d25; font-size: 13px; }
.plan-cases-panel { overflow: hidden; margin-bottom: 14px; }
.plan-cases-panel > summary { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; cursor: pointer; font-size: 14px; font-weight: 700; }
.plan-cases-panel > summary span { color: var(--muted); font-size: 11px; font-weight: 400; }
.plan-cases-panel .plan-table { margin: 0; width: 100%; }
.plan-case-toolbar, .plan-case-bulk { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 20px; border-top: 1px solid var(--line); }
.plan-case-toolbar .cell-select, .plan-case-bulk .cell-select { min-height: 36px; padding: 6px 10px; border-radius: 8px; background: #fff; }
.plan-case-search { flex: 1 1 260px; min-width: 180px; min-height: 36px; }
.plan-case-result { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.plan-case-bulk { background: #f8faff; font-size: 12px; }
.plan-case-bulk label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.plan-bulk-delete { color: #bb3333; }
.plan-case-empty { padding: 28px 20px; color: var(--muted); text-align: center; }
.plan-case-item { border-top: 1px solid var(--line); }
.plan-case-row { display: flex; align-items: center; gap: 12px; min-height: 54px; padding: 9px 20px; }
.plan-case-open { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.plan-case-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.plan-case-chevron { color: var(--muted); }
.plan-case-tag { flex: none; padding: 4px 8px; border-radius: 6px; background: #f1f4f9; color: var(--muted); font-size: 11px; }
.plan-case-tag.priority-high { background: #fff1ec; color: #a64a29; }
.plan-case-tag.priority-medium { background: #fff7e8; color: #92621b; }
.plan-case-detail { display: grid; gap: 14px; padding: 16px 20px 18px 47px; background: #fff; border-top: 1px solid var(--line); border-left: 2px solid #8eb2ff; }
.plan-case-detail > label, .plan-case-meta label, .plan-case-text-fields label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.plan-case-detail label > span { color: var(--text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.plan-case-detail .cell-input, .plan-case-detail .cell-select { width: 100%; min-width: 0; min-height: 34px; box-sizing: border-box; padding: 6px 4px; border: 0; border-bottom: 1px solid #cfd7e4; border-radius: 0; outline: none; background: transparent; color: var(--text); font: inherit; }
.plan-case-detail .cell-input:focus, .plan-case-detail .cell-select:focus { border-bottom-color: var(--blue); box-shadow: 0 1px 0 var(--blue); }
.plan-case-detail textarea.cell-input { min-height: 82px; padding: 9px 10px; border: 1px solid #dbe1ea; border-radius: 6px; background: #fbfcfe; resize: vertical; line-height: 1.5; }
.plan-case-detail textarea.cell-input:focus { border-color: #8eb2ff; box-shadow: 0 0 0 2px rgba(47, 108, 246, .08); background: #fff; }
.plan-case-meta { display: grid; grid-template-columns: minmax(150px, .8fr) minmax(150px, 1fr) minmax(150px, 1fr); gap: 16px; }
.plan-case-text-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.plan-case-detail .plan-bulk-delete { justify-self: end; padding: 4px 2px; border-color: transparent; background: transparent; }
.plan-case-detail .plan-bulk-delete:hover { background: #fff5f5; color: #a61b1b; }
.plan-case-detail .scenario-panel { min-width: 0; overflow: auto; }
.library-panel { overflow: hidden; padding: 0; }
.library-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 20px; }
.library-panel-head h2 { margin: 5px 0 7px; font-size: 20px; }
.library-panel-head p { margin: 0; color: var(--muted); font-size: 12px; }
.library-panel-actions { display: flex; align-items: center; gap: 8px; }
.library-reset-button { color: #a33; }
.library-selection-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #f7f9fc; font-size: 12px; font-weight: 600; }
.library-case-list { max-height: 520px; overflow: auto; }
.library-case-row { display: flex; align-items: center; gap: 12px; min-height: 54px; padding: 9px 20px; border-bottom: 1px solid var(--line); cursor: pointer; }
.library-case-row:last-child { border-bottom: 0; }
.library-case-row.unavailable { cursor: default; }
.library-case-row.unavailable .library-case-main, .library-case-row.unavailable .library-case-capability { opacity: .62; }
.library-case-main { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.library-case-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.library-case-main small { color: var(--muted); font-size: 11px; }
.library-case-capability { flex: none; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.library-case-capability.ready { background: var(--green-bg); color: var(--green); }
.library-case-capability.missing { background: #eef2f7; color: var(--muted); }
.library-case-delete { flex: none; padding: 5px 7px; border: 0; border-radius: 6px; background: transparent; color: #a33; font: inherit; font-size: 11px; cursor: pointer; }
.library-case-delete:hover { background: #fff1f1; }
.app-modal-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, .34); backdrop-filter: blur(2px); }
.app-modal { display: flex; gap: 14px; width: min(440px, 100%); padding: 22px; border: 1px solid #ead7d7; border-radius: 14px; background: #fff; box-shadow: 0 24px 70px rgba(15, 23, 42, .24); }
.app-modal-icon { display: grid; flex: none; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: #fff0f0; color: #b42318; font-weight: 800; }
.app-modal-content { flex: 1; min-width: 0; }
.app-modal h2 { margin: 1px 0 8px; font-size: 18px; }
.app-modal p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.app-modal .app-modal-note { margin-top: 8px; color: #8a5a18; }
.app-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.app-modal-danger { border-color: #c9362b; background: #c9362b; color: #fff; }
.app-modal-danger:hover { border-color: #a82b22; background: #a82b22; }
.library-run-success { margin: 12px 20px; padding: 10px 12px; border-radius: 8px; background: var(--green-bg); color: var(--green); font-size: 12px; }
.library-run-details { margin: 12px 20px; border: 1px solid var(--line); border-radius: 8px; }
.library-run-details summary { padding: 10px 12px; cursor: pointer; font-size: 12px; font-weight: 700; }
.library-run-details pre { max-height: 260px; margin: 0; padding: 12px; overflow: auto; border-top: 1px solid var(--line); background: #0f172a; color: #dbeafe; font: 12px/1.55 Consolas, monospace; white-space: pre-wrap; }
.library-reflect-results { margin: 12px 20px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.library-result-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 12px; }
.library-result-row:last-child { border-bottom: 0; }
.library-result-row.passed span { color: var(--green); }
.library-result-row.failed span { color: var(--red); }
.plan-case-pagination { display: flex; justify-content: center; align-items: center; gap: 14px; padding: 14px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.plan-scope-options { display: flex; flex-wrap: wrap; gap: 10px; min-width: 0; margin: 0; padding: 0; border: 0; }
.plan-scope-options legend { margin-bottom: 8px; color: var(--muted); font-size: 12px; }
.plan-scope-options label { display: flex; align-items: flex-start; gap: 9px; min-width: 210px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; cursor: pointer; }
.plan-scope-options label.selected { border-color: var(--blue); background: var(--blue-bg); }
.plan-scope-options label span { display: grid; gap: 3px; }
.plan-scope-options label strong { color: var(--text); font-size: 12px; }
.plan-scope-options label small { color: var(--muted); font-size: 11px; }
.plan-command-panel { padding: 20px 24px; margin-top: 14px; }
.plan-command-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.plan-command-heading h2 { margin: 5px 0 0; font-size: 17px; }
.plan-command-utilities, .plan-primary-actions, .plan-suite-save { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.plan-command-utilities .btn { font-size: 12px; }
.plan-suite-save { padding-top: 18px; margin-top: 18px; border-top: 1px solid var(--line); }
.plan-suite-save .cell-input { flex: 1 1 260px; max-width: 360px; }
.plan-command-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; padding-top: 18px; margin-top: 18px; border-top: 1px solid var(--line); }
.plan-command-footer > p { max-width: 560px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.plan-lifecycle { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
.plan-lifecycle-step { min-width: 0; padding: 5px 12px; border-left: 3px solid var(--line); background: transparent; }
.plan-lifecycle-step strong, .plan-lifecycle-step span { display: block; }
.plan-lifecycle-step strong { margin-bottom: 4px; font-size: 13px; }
.plan-lifecycle-step span { color: var(--muted); font-size: 11px; line-height: 1.45; }
.plan-lifecycle-step.active { border-left-color: var(--blue); }
.plan-lifecycle-step.done { border-left-color: var(--green); }
.plan-lifecycle-step.done strong { color: var(--green); }
.plan-scope-field { display: flex; flex-direction: column; gap: 8px; min-width: 280px; color: var(--muted); font-size: 12px; }
.plan-scope-field .cell-select { width: 100%; min-height: 40px; color: var(--text); }
.plan-primary-actions { justify-content: flex-end; }
.plan-more-actions { position: relative; }
.plan-more-actions > summary { min-height: 38px; display: inline-flex; align-items: center; padding: 0 12px; border: 1px solid var(--line); border-radius: 9px; background: #fff; color: var(--muted-strong); font-size: 13px; font-weight: 650; cursor: pointer; list-style: none; }
.plan-more-actions > summary::-webkit-details-marker { display: none; }
.plan-more-actions > summary::after { content: '⌄'; margin-left: 7px; color: var(--muted); }
.plan-more-actions[open] > summary { border-color: var(--blue); color: var(--blue); }
.plan-more-menu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 8; min-width: 190px; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: #fff; box-shadow: 0 12px 30px rgba(15, 23, 42, .14); }
.plan-more-menu button { width: 100%; padding: 9px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.plan-more-menu button:hover { background: var(--surface-soft); }
@media (max-width: 900px) { .plan-command-heading, .plan-command-footer, .library-panel-head, .library-selection-bar { align-items: stretch; flex-direction: column; } .plan-collection-tabs { grid-template-columns: 1fr; } .library-panel-actions { align-items: stretch; flex-direction: column; } .plan-scope-field { min-width: 0; } .plan-primary-actions { justify-content: flex-start; } .plan-case-meta, .plan-case-text-fields { grid-template-columns: 1fr; } .plan-case-detail { padding-left: 20px; } }
@media (max-width: 900px) { .generation-progress-head { align-items: flex-start; flex-direction: column; } .generation-progress-list { grid-template-columns: 1fr; } }

.run-status-panel { padding: 16px 20px; margin: 18px 0; }
.run-status-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-status-head h2 { margin: 4px 0 0; font-size: 19px; }
.run-status-actions { display: flex; align-items: center; gap: 10px; }
.run-interrupt { min-height: 32px; padding: 6px 10px; border-color: #d8dee9; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; }
.run-interrupt:hover { border-color: #f0b8b8; background: #fff5f5; color: #b42318; }
.run-status-panel > p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.run-status-panel .run-failure-reason { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 11px 12px; margin-top: 12px; border: 1px solid #f1bbb5; border-radius: 8px; background: #fff3f1; color: #8f2822; line-height: 1.5; }
.run-failure-reason strong { white-space: nowrap; }
.diagnosis-read-summary { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: #eef5ff; color: #36567d; font-size: 13px; }
.run-steps { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; }
.run-step { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; }
.run-step-mark { font-size: 15px; }
.run-step.status-done { border-color: #bce8cc; background: var(--green-bg); color: #137a37; }
.run-step.status-running, .run-step.status-escalating { border-color: #b8ccff; background: var(--blue-bg); color: var(--blue); font-weight: 700; }
.run-idle-warning { padding: 10px 12px; margin: 12px 0 0 !important; border-radius: 8px; background: var(--amber-bg); color: #875014 !important; }
.generation-progress-panel { padding: 18px 20px; margin: 16px 0; }
.generation-progress-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.generation-progress-head h2 { margin: 4px 0 0; font-size: 18px; }
.generation-progress-head > strong { color: var(--blue); font-size: 13px; }
.generation-progress-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.generation-progress-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
.generation-progress-row small { grid-column: 2 / -1; color: var(--muted); }
.generation-progress-mark { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #e8edf5; color: var(--muted); font-weight: 800; }
.generation-progress-target { overflow: hidden; color: var(--text); font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.generation-progress-state { color: var(--muted); font-size: 12px; }
.generation-progress-row.running { border-color: #b8ccff; background: var(--blue-bg); }
.generation-progress-row.running .generation-progress-mark { background: var(--blue); color: #fff; }
.generation-progress-row.retrying { border-color: #f2c47d; background: var(--amber-bg); }
.generation-progress-row.retrying .generation-progress-mark { background: #d88714; color: #fff; }
.generation-progress-row.completed, .generation-progress-row.reused { border-color: #bce8cc; background: var(--green-bg); }
.generation-progress-row.completed .generation-progress-mark, .generation-progress-row.reused .generation-progress-mark { background: var(--green); color: #fff; }
.generation-progress-row.failed { border-color: #f1bbb5; background: #fff3f1; }
.generation-progress-row.failed .generation-progress-mark { background: #c13a31; color: #fff; }
.generation-progress-note { margin: 12px 0 0; color: var(--muted); font-size: 12px; }
.run-log-details { margin-top: 18px; }
.run-log-details > summary { padding: 14px 16px; border: 1px solid var(--line); border-radius: 9px; background: #fff; cursor: pointer; font-size: 13px; font-weight: 700; }
.run-log-label { margin-left: 0 !important; color: var(--ink) !important; font-size: 13px !important; font-weight: 700 !important; }
.run-log-label-open { display: none; }
.run-log-details[open] .run-log-label-closed { display: none; }
.run-log-details[open] .run-log-label-open { display: inline; }
.run-log-details > summary span { margin-left: 8px; color: var(--muted); font-weight: 400; font-size: 11px; }
.run-log-details .agent-log-stream { margin-top: 8px; }
@media (max-width: 1120px) {
  .shell-with-nav { gap: 14px; }
  .workspace-nav { width: 180px; }
  .home-action-row { flex-wrap: wrap; }
  .action-card { flex: 1 1 220px; }
  .setup-grid { grid-template-columns: 1fr 1fr; }
  .setup-grid .field:first-child { grid-column: 1 / -1; }
}
</style>
