<script setup lang="ts">
import type { HistoryRecord, TestCaseRecord } from '../../../types.js'

type View = 'home' | 'plan' | 'run' | 'diagnosis' | 'fix' | 'report' | 'history' | 'settings' | 'dashboard' | 'suites' | 'scenarios'

defineProps<{
  view: View
  recentProjects: HistoryRecord[]
  projectPath: string
  suiteLoading: boolean
  suiteTree: Array<{ layer: string; cases: TestCaseRecord[] }>
  expandedLayers: Set<string>
  planAvailable: boolean
  planCaseCount: number
}>()

const emit = defineEmits<{
  go: [view: View]
  openPlanTab: [tab: 'current' | 'saved']
  openDashboard: []
  selectProject: [p: HistoryRecord]
  toggleLayer: [layer: string]
}>()

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/$/, '')
  const seg = norm.split('/').filter(Boolean).pop()
  return seg ?? p
}

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

</script>

<template>
  <aside class="workspace-nav">
    <div class="nav-sidebar-title">导航</div>
    <button class="nav-icon nav-home-item" :class="{ active: view === 'home' }" :aria-current="view === 'home' ? 'page' : undefined" @click="emit('go', 'home')">首页</button>
    <div class="nav-section">
      <div class="nav-section-label">当前项目</div>
      <div v-if="projectPath" class="nav-current-project" :title="projectPath">
        <strong>{{ basename(projectPath) }}</strong>
        <small>{{ projectPath }}</small>
      </div>
      <span v-else class="nav-empty">尚未选择项目</span>
      <div v-if="recentProjects.length" class="nav-section-label nav-recent-label">最近项目</div>
      <button v-for="p in recentProjects.slice(0, 3)" :key="p.projectPath" class="nav-project" :class="{ active: projectPath === p.projectPath }" @click="emit('selectProject', p)" :title="p.projectPath">
        <span class="nav-project-name">{{ p.projectName || basename(p.projectPath) }}</span>
        <span class="nav-project-meta">{{ p.version }} · {{ relativeTime(p.savedAt) }}</span>
      </button>
    </div>
    <div v-if="projectPath" class="nav-section">
      <div class="nav-section-label">用例概览</div>
      <div class="nav-case-summary" :class="{ disabled: !planAvailable }">
        <button class="nav-case-metric" :disabled="!planCaseCount" title="查看本次计划用例" @click="emit('openPlanTab', 'current')"><strong>{{ planCaseCount }}</strong><small>当前计划</small></button>
        <button class="nav-case-metric" :disabled="!suiteTree.reduce((sum, node) => sum + node.cases.length, 0)" title="查看已保存用例" @click="emit('openPlanTab', 'saved')"><strong>{{ suiteTree.reduce((sum, node) => sum + node.cases.length, 0) }}</strong><small>已保存用例</small></button>
      </div>
      <span v-if="suiteLoading" class="nav-empty">正在读取用例…</span>
    </div>
    <div class="nav-view-bar">
      <button class="nav-icon" :class="{active: view==='plan'}" :disabled="!planAvailable" :title="planAvailable ? '' : '暂无用例或待确认计划'" @click="emit('go', 'plan')">用例与计划<span v-if="!planAvailable" class="nav-menu-count">0</span></button>
      <button class="nav-icon" :class="{active: view==='run'}" @click="emit('go', 'run')">执行过程</button>
      <button class="nav-icon" :class="{active: view==='report'}" @click="emit('go', 'report')">测试报告</button>
      <button class="nav-icon" :class="{active: view==='suites'}" @click="emit('go', 'suites')">回归套件</button>
      <button class="nav-icon" :class="{active: view==='scenarios'}" @click="emit('go', 'scenarios')">场景文件</button>
      <button class="nav-icon" :class="{active: view==='dashboard'}" @click="emit('openDashboard')">质量看板</button>
      <button class="nav-icon" :class="{active: view==='history'}" @click="emit('go', 'history')">历史任务</button>
      <button class="nav-icon" :class="{active: view==='settings'}" @click="emit('go', 'settings')">设置</button>
    </div>
  </aside>
</template>
