import { contextBridge, ipcRenderer } from 'electron'
import type { TaskInput } from '@cxmt/protocol'
import type { AppMenuCommand, AppNavTarget, DefectCreateInput, DesktopApi, HistoryRecord, LocalHostApi, TaskSnapshot } from '../types.js'
import { toIpcValue } from './ipc-serialization.js'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`${channel}: ${message}`)
  }) as Promise<T>
}

const api: DesktopApi = {
  selectProject: () => invoke('project:select'),
  detectProject: (path: string) => invoke('project:detect', path),
  getKnowledgeRoots: () => ipcRenderer.invoke('config:getKnowledgeRoots'),
  onKnowledgeRootsChanged: (listener: (roots: string[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, roots: string[]) => listener(roots)
    ipcRenderer.on('config:changed', handler)
    return () => ipcRenderer.removeListener('config:changed', handler)
  },
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startTask: (input: TaskInput) => ipcRenderer.invoke('task:start', toIpcValue(input)),
  getTask: (taskId: string) => ipcRenderer.invoke('task:get', taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  retryTask: (taskId: string) => ipcRenderer.invoke('task:retry', taskId),
  rollbackFix: (projectPath: string, patch: string) => ipcRenderer.invoke('task:rollback', projectPath, patch),
  exportReport: (format, snapshot, projectPath) => ipcRenderer.invoke('report:export', format, toIpcValue(snapshot), projectPath),
  copyReportSummary: (snapshot) => ipcRenderer.invoke('report:copy', toIpcValue(snapshot)),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  getHistory: () => ipcRenderer.invoke('history:get'),
  saveHistory: (record: HistoryRecord) => ipcRenderer.invoke('history:save', toIpcValue(record)),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  selectKnowledgeRoots: () => ipcRenderer.invoke('config:selectKnowledgeRoots'),
  getAiConfig: () => ipcRenderer.invoke('config:getAiConfig'),
  saveAiConfig: (config) => ipcRenderer.invoke('config:saveAiConfig', toIpcValue(config)),
  loadEnvironmentProfiles: (projectPath: string) => invoke('config:loadEnvironmentProfiles', projectPath),
  saveEnvironmentProfiles: (projectPath, profiles) => ipcRenderer.invoke('config:saveEnvironmentProfiles', projectPath, toIpcValue(profiles)),
  authorizeProjectArtifacts: (projectPath: string) => ipcRenderer.invoke('config:authorizeProjectArtifacts', projectPath),
  onNavigate: (listener: (target: AppNavTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: AppNavTarget) => listener(target)
    ipcRenderer.on('menu:navigate', handler)
    return () => ipcRenderer.removeListener('menu:navigate', handler)
  },
  onCommand: (listener: (command: AppMenuCommand) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppMenuCommand) => listener(command)
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  },
  subscribeTask: (listener: (snapshot: TaskSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: TaskSnapshot) => listener(snapshot)
    ipcRenderer.on('task:snapshot', handler)
    return () => ipcRenderer.removeListener('task:snapshot', handler)
  },
  loadCases: (projectPath: string) => invoke('cases:load', projectPath),
  previewPlanImpact: (projectPath: string, cases: unknown[]) => ipcRenderer.invoke('plan:previewImpact', projectPath, toIpcValue(cases)),
  saveCase: (projectPath: string, testCase: Record<string, unknown>) => ipcRenderer.invoke('cases:save', projectPath, toIpcValue(testCase)),
  deleteCaseFromLibrary: (projectPath: string, title: string) => ipcRenderer.invoke('cases:delete', projectPath, title),
  previewGeneratedTestReset: (projectPath: string) => ipcRenderer.invoke('cases:resetGeneratedPreview', projectPath),
  resetGeneratedTests: (projectPath: string) => ipcRenderer.invoke('cases:resetGenerated', projectPath),
  readScenario: (projectPath: string, caseId: string) => ipcRenderer.invoke('scenarios:read', projectPath, caseId),
  saveScenario: (projectPath: string, caseId: string, scenario: unknown) => ipcRenderer.invoke('scenarios:save', projectPath, caseId, toIpcValue(scenario)),
  listScenarios: (projectPath: string) => invoke('scenarios:list', projectPath),
  deleteScenario: (projectPath: string, caseId: string) => ipcRenderer.invoke('scenarios:delete', projectPath, caseId),
  importScenarios: (projectPath: string, scenarios: Array<{ caseId: string; scenario: unknown }>) => ipcRenderer.invoke('scenarios:import', projectPath, toIpcValue(scenarios)),
  exportScenarios: (projectPath: string, caseIds?: string[]) => ipcRenderer.invoke('scenarios:export', projectPath, caseIds),
  rerunLocal: (projectPath: string, caseId: string) => ipcRenderer.invoke('task:rerunLocal', projectPath, caseId),
  runAllLocal: (projectPath: string) => ipcRenderer.invoke('task:runAllLocal', projectPath),
  runSelectedReflect: (projectPath: string, caseIds: string[]) => ipcRenderer.invoke('task:runSelectedReflect', projectPath, caseIds),
  rerunFailedBatch: (projectPath: string, failedCases: Array<{ name: string; layer: string; caseId?: string; testClass?: string }>) => ipcRenderer.invoke('task:rerunFailedBatch', projectPath, toIpcValue(failedCases)),
  // P3-1 回归套件管理（SuiteLibrary 本地 .test-agent/suites/，控制面零改动）
  saveSuite: (projectPath: string, name: string, caseIds: string[], testStrategy: 'reflect' | 'junit') => ipcRenderer.invoke('suite:save', projectPath, name, caseIds, testStrategy),
  listSuites: (projectPath: string) => invoke('suite:list', projectPath),
  deleteSuite: (projectPath: string, suiteId: string) => ipcRenderer.invoke('suite:delete', projectPath, suiteId),
  runSuite: (projectPath: string, suiteId: string) => ipcRenderer.invoke('suite:run', projectPath, suiteId),
  getMetrics: (projectPath: string, range?: { start: string; end: string }) => ipcRenderer.invoke('metrics:get', projectPath, range),
  createDefect: (input: DefectCreateInput) => ipcRenderer.invoke('defect:create', toIpcValue(input)),
  replyEscalation: (executionId: string, escalationId: string, answer: string) => ipcRenderer.invoke('escalation:reply', executionId, escalationId, answer),
  dismissEscalation: (executionId: string, escalationId: string) => ipcRenderer.invoke('escalation:dismiss', executionId, escalationId),
  getEscalationAudit: (projectPath: string) => ipcRenderer.invoke('escalation:audit', projectPath)
}

const localApi: LocalHostApi = {
  getStatus: () => invoke('host:status'),
  start: (input: TaskInput, executionId?: string) => invoke('host:start', toIpcValue(input), executionId),
  cancel: (executionId: string) => ipcRenderer.invoke('host:cancel', executionId),
  subscribe: (listener: (message: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message)
    ipcRenderer.on('host:message', handler)
    return () => ipcRenderer.removeListener('host:message', handler)
  }
}

contextBridge.exposeInMainWorld('testAgent', api)
contextBridge.exposeInMainWorld('testAgentLocal', localApi)
