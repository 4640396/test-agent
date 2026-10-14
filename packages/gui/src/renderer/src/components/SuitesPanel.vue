<script setup lang="ts">
import type { Suite, SuiteRunResult } from '../../../types.js'

defineProps<{
  suites: Suite[]
  suiteRunning: string | null
  suiteRunResults: Record<string, SuiteRunResult | undefined>
  expandedSuiteResults: Set<string>
  projectPath: string
}>()

const emit = defineEmits<{
  back: []
  run: [suite: Suite]
  toggleResult: [suiteId: string]
  delete: [suite: Suite]
}>()

function suiteCaseCount(suite: Suite): number {
  return suite.caseIds.length
}

function suiteLastRunText(suite: Suite): string {
  if (!suite.lastRunAt) return '从未运行'
  const r = suite.lastRunResult
  if (!r) return `上次运行 ${suite.lastRunAt}`
  const timeText = r.fail === 0 ? '全过' : `${r.fail} 条失败`
  return `上次运行 ${suite.lastRunAt} · ${timeText} · ✅${r.pass} ❌${r.fail}${r.skipped ? ` ⏭${r.skipped}` : ''}`
}

function truncError(err: string, n = 120): string {
  if (!err) return ''
  return err.length > n ? err.slice(0, n) + '…' : err
}
</script>

<template>
  <div class="detail-view">
    <button class="back" @click="emit('back')">← 返回首页</button>
    <div class="head-row">
      <div><h1 class="detail-title">📦 回归套件</h1><p class="detail-sub" style="margin:0">命名保存用例集，一键回归不调 LLM</p></div>
    </div>

    <div v-if="!projectPath" class="card panel muted" style="text-align:center;padding:40px">
      请先选择项目目录
    </div>

    <div v-else-if="!suites.length" class="card panel muted" style="text-align:center;padding:40px">
      暂无套件。先在用例集页面规划用例，再「保存为回归套件」。
    </div>

    <div v-else class="suite-list">
      <div v-for="s in suites" :key="s.id" class="card suite-card">
        <div class="suite-card-head">
          <span class="suite-name">{{ s.name }}</span>
          <span class="suite-strategy">{{ s.testStrategy === 'reflect' ? '反射场景' : 'JUnit' }}</span>
          <span class="suite-count">{{ suiteCaseCount(s) }} 用例</span>
        </div>
        <div class="suite-card-meta">{{ suiteLastRunText(s) }}</div>
        <div class="suite-card-actions">
          <button class="btn btn-primary btn-sm" :disabled="suiteRunning === s.id" @click="emit('run', s)">{{ suiteRunning === s.id ? '回归中…' : '▶ 一键回归' }}</button>
          <button class="btn btn-soft btn-sm" @click="emit('toggleResult', s.id)" v-if="suiteRunResults[s.id]">{{ expandedSuiteResults.has(s.id) ? '收起结果' : '查看结果' }}</button>
          <button class="btn btn-dark btn-sm" @click="emit('delete', s)">🗑 删除</button>
        </div>
        <div v-if="expandedSuiteResults.has(s.id) && suiteRunResults[s.id]" class="suite-results">
          <div class="suite-results-summary">
            <span>总数 {{ suiteRunResults[s.id]!.summary.total }}</span>
            <span class="green">✅{{ suiteRunResults[s.id]!.summary.pass }}</span>
            <span :class="{ red: suiteRunResults[s.id]!.summary.fail }">❌{{ suiteRunResults[s.id]!.summary.fail }}</span>
            <span v-if="suiteRunResults[s.id]!.summary.skipped">⏭{{ suiteRunResults[s.id]!.summary.skipped }}</span>
            <span v-if="suiteRunResults[s.id]!.summary.time" class="muted">⏱{{ suiteRunResults[s.id]!.summary.time }}s</span>
            <span v-if="suiteRunResults[s.id]!.error" class="error">{{ suiteRunResults[s.id]!.error }}</span>
          </div>
          <div v-for="(r, i) in suiteRunResults[s.id]!.results" :key="i" class="suite-result-row" :class="{ 'suite-result-fail': !r.ok && !r.skipped }">
            <span :class="r.ok ? 'green' : (r.skipped ? 'muted' : 'red')">{{ r.ok ? '✅' : (r.skipped ? '⏭' : '❌') }}</span>
            <span class="suite-result-name">{{ r.name }}</span>
            <details v-if="r.error" class="suite-result-error-wrap">
              <summary class="suite-result-error">{{ truncError(r.error) }}</summary>
              <pre class="suite-result-error-full">{{ r.error }}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
