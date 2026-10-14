<script setup lang="ts">
import { ref } from 'vue'
import ScenarioEditor from './ScenarioEditor.vue'

const props = defineProps<{
  scenarioFiles: Array<{ caseId: string; title?: string }>
  projectPath: string
  loadScenario: (caseId: string) => Promise<string>
}>()

const emit = defineEmits<{
  back: []
  save: [caseId: string, json: string]
  delete: [caseId: string]
  exportAll: []
  importScenarios: [jsonText: string]
  refresh: []
}>()

const showImport = ref(false)
const importText = ref('')
const editingId = ref<string | null>(null)
const editJson = ref('')
const editError = ref('')

/** 哨兵值，标识"新建场景"编辑模式。 */
const NEW_SCENARIO_ID = '__new__'

function toggleImport(): void {
  showImport.value = !showImport.value
  if (!showImport.value) importText.value = ''
  // 切换导入模式时关闭编辑
  editingId.value = null
  editJson.value = ''
  editError.value = ''
}

function confirmImport(): void {
  emit('importScenarios', importText.value)
  importText.value = ''
  showImport.value = false
}

async function toggleView(caseId: string): Promise<void> {
  if (editingId.value === caseId) {
    editingId.value = null
    editJson.value = ''
  } else {
    editingId.value = caseId
    editJson.value = await props.loadScenario(caseId)
  }
  editError.value = ''
}

/** 开始新建场景：设哨兵值 + 空编辑内容。 */
function startNewScenario(): void {
  editingId.value = NEW_SCENARIO_ID
  editJson.value = ''
  editError.value = ''
}

/** 保存编辑。新建场景从 JSON 解析 id 作为 caseId（R2 修复）；已有场景用列表 caseId。 */
function saveEdit(caseId: string): void {
  if (editingId.value === NEW_SCENARIO_ID) {
    // 新建场景：从 JSON 解析 id
    try {
      const parsed = JSON.parse(editJson.value)
      const newId = parsed.id
      if (!newId || typeof newId !== 'string') {
        editError.value = '场景 JSON 缺少 id 字段或 id 非字符串'
        return
      }
      emit('save', newId, editJson.value)
    } catch (e) {
      editError.value = `JSON 解析失败：${(e as Error).message}`
      return
    }
  } else {
    emit('save', caseId, editJson.value)
  }
  editingId.value = null
  editJson.value = ''
  editError.value = ''
}

function cancelEdit(): void {
  editingId.value = null
  editJson.value = ''
  editError.value = ''
}
</script>

<template>
  <div class="detail-view">
    <button class="back" @click="emit('back')">← 返回首页</button>
    <div class="head-row">
      <div><h1 class="detail-title">🎯 场景文件管理</h1><p class="detail-sub" style="margin:0">浏览/编辑/删除/导入导出 .test-agent/scenarios/ 下的 JSON 场景</p></div>
      <div class="head-row-actions">
        <button class="btn btn-primary btn-sm" @click="startNewScenario" :disabled="editingId === NEW_SCENARIO_ID">✏ 新建场景</button>
        <button class="btn btn-soft btn-sm" @click="emit('exportAll')" :disabled="!scenarioFiles.length">导出全部</button>
        <button class="btn btn-soft btn-sm" @click="toggleImport">{{ showImport ? '取消导入' : '导入' }}</button>
        <button class="btn btn-soft btn-sm" @click="emit('refresh')">刷新</button>
      </div>
    </div>

    <div v-if="!projectPath" class="card panel muted" style="text-align:center;padding:40px">
      请先选择项目目录
    </div>

    <div v-else-if="showImport" class="card panel" style="padding:16px">
      <h3 style="margin:0 0 8px">导入场景</h3>
      <p class="detail-sub" style="margin:0 0 8px">粘贴 JSON 数组，格式：<code>[{ "caseId": "TC001", "scenario": { ... } }]</code></p>
      <textarea v-model="importText" class="scenario-import-textarea" rows="8" placeholder='[{ "caseId": "TC001", "scenario": { "id": "TC001", "target": { ... } } }]'></textarea>
      <div style="margin-top:8px">
        <button class="btn btn-primary btn-sm" @click="confirmImport">确认导入</button>
        <button class="btn btn-soft btn-sm" @click="toggleImport">取消</button>
      </div>
    </div>

    <template v-else>
      <!-- 新建场景编辑卡（editingId === __new__ 时展示） -->
      <div v-if="editingId === NEW_SCENARIO_ID" class="card scenario-file-card" style="margin-bottom:12px">
        <div class="scenario-file-head">
          <span class="scenario-file-id">✏ 新建场景</span>
          <div class="scenario-file-actions">
            <button class="btn btn-primary btn-sm" @click="saveEdit(NEW_SCENARIO_ID)">保存</button>
            <button class="btn btn-soft btn-sm" @click="cancelEdit">取消</button>
          </div>
        </div>
        <div class="scenario-file-edit">
          <p class="detail-sub" style="margin:0 0 4px">编辑 JSON 场景，保存时从 <code>id</code> 字段取场景 ID。</p>
          <ScenarioEditor v-model="editJson" :error="editError" />
        </div>
      </div>

      <div v-if="!scenarioFiles.length && editingId !== NEW_SCENARIO_ID" class="card panel muted" style="text-align:center;padding:40px">
        暂无场景文件。点击上方"新建场景"手动创建，或先在用例集页面展开反射用例生成 JSON 场景。
      </div>

      <div v-if="scenarioFiles.length" class="scenario-file-list">
        <div v-for="sf in scenarioFiles" :key="sf.caseId" class="card scenario-file-card">
          <div class="scenario-file-head">
            <span class="scenario-file-id">🎯 {{ sf.caseId }}</span>
            <span v-if="sf.title" class="scenario-file-title">{{ sf.title }}</span>
            <div class="scenario-file-actions">
              <button class="btn btn-soft btn-sm" @click="toggleView(sf.caseId)">{{ editingId === sf.caseId ? '收起' : '查看' }}</button>
              <button class="btn btn-dark btn-sm" @click="emit('delete', sf.caseId)">🗑 删除</button>
            </div>
          </div>
          <div v-if="editingId === sf.caseId" class="scenario-file-edit">
            <ScenarioEditor v-model="editJson" />
            <div style="margin-top:4px">
              <button class="btn btn-primary btn-sm" @click="saveEdit(sf.caseId)">保存</button>
              <button class="btn btn-soft btn-sm" @click="cancelEdit">取消</button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
