<script setup lang="ts">
/**
 * P4-1-b：写场景直跑面板（首页一等入口）。
 *
 * 用户贴 JSON 场景 → 一键反射执行 → 秒级看结果（不调 LLM）。
 * 复用已有 IPC：saveScenario 落盘 + rerunLocal 本地 spawn mvn 跑反射引擎。
 */
import { ref } from 'vue'
import ScenarioEditor from './ScenarioEditor.vue'

const props = defineProps<{
  /** 已选项目目录（来自 App.vue form.projectPath） */
  projectPath: string
}>()

const emit = defineEmits<{
  close: []
}>()

const caseId = ref('')
const scenarioJson = ref('')
const running = ref(false)
const result = ref<{ ok: boolean; output: string; error?: string } | null>(null)
const jsonError = ref('')
const saveError = ref('')
const idHint = ref('')

const POJO_TEMPLATE = `{
  "id": "TC001",
  "title": "POJO 方法测试",
  "target": {
    "className": "com.example.MyService",
    "method": "doSomething"
  },
  "setup": { "springContext": false },
  "params": [
    { "name": "input", "type": "java.lang.String", "value": "hello" }
  ],
  "assertion": {
    "type": "return",
    "expected": "HELLO",
    "expectedType": "java.lang.String"
  }
}`

const SPRING_TEMPLATE = `{
  "id": "TC001",
  "title": "Spring Service 测试",
  "target": {
    "className": "com.example.OrderService",
    "method": "createOrder"
  },
  "setup": { "springContext": true },
  "params": [
    { "name": "request", "type": "com.example.dto.OrderRequest", "value": { "productId": "P001", "quantity": 2 } }
  ],
  "assertion": {
    "type": "return",
    "expected": { "orderId": "auto-generated" },
    "expectedType": "com.example.dto.OrderResponse"
  }
}`

const SPRING_FIXTURE_MOCK_TEMPLATE = `{
  "id": "TC001",
  "title": "Spring Service 测试（带 DB fixture）",
  "target": {
    "className": "com.cimdev.testagent.ControlService",
    "method": "tasks"
  },
  "setup": {
    "springContext": true,
    "fixtures": [
      {
        "table": "projects",
        "rows": [
          { "id": "p1", "name": "demo", "project_path": "/demo", "default_version": "main", "default_test_types": "unit" }
        ]
      },
      {
        "table": "test_tasks",
        "rows": [
          { "id": "t1", "project_id": "p1", "input_json": "{}", "status": "COMPLETED", "trigger_type": "manual" }
        ]
      }
    ]
  },
  "params": [
    { "name": "limit", "type": "int", "value": 10 }
  ],
  "assertion": {
    "type": "exception",
    "expectedException": "java.lang.IllegalArgumentException",
    "expectedMessage": "项目不存在"
  }
}`

/** 异常断言写法示例（填充时追加到 JSON 末尾注释区，供用户参考） */
const EXCEPTION_EXAMPLE = `// 异常断言写法（将 assertion 替换为）：
// "assertion": {
//   "type": "exception",
//   "expectedException": "java.lang.IllegalArgumentException",
//   "expectedMessage": "参数不能为空"
// }`

function fillTemplate(kind: 'pojo' | 'spring' | 'spring-fixture-mock'): void {
  const template = kind === 'pojo' ? POJO_TEMPLATE : kind === 'spring' ? SPRING_TEMPLATE : SPRING_FIXTURE_MOCK_TEMPLATE
  scenarioJson.value = template
  // 从模板提取 id 设到 caseId
  try {
    const parsed = JSON.parse(template)
    caseId.value = parsed.id || ''
  } catch { /* 模板格式固定，不会失败 */ }
  jsonError.value = ''
  idHint.value = ''
  result.value = null
}

async function runNow(): Promise<void> {
  jsonError.value = ''
  saveError.value = ''
  idHint.value = ''
  result.value = null

  if (!props.projectPath) {
    saveError.value = '请先选择项目目录'
    return
  }
  if (!caseId.value.trim()) {
    saveError.value = '请填写场景 ID'
    return
  }
  if (!scenarioJson.value.trim()) {
    jsonError.value = '请填写 JSON 场景内容'
    return
  }

  // 1. JSON 校验
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(scenarioJson.value)
  } catch (e) {
    jsonError.value = `JSON 解析失败：${(e as Error).message}`
    return
  }

  // 2. caseId 一致性（宽松处理：parsed.id 存在时自动覆盖 + 提示）
  let effectiveCaseId = caseId.value.trim()
  const parsedId = parsed.id
  if (typeof parsedId === 'string' && parsedId && parsedId !== effectiveCaseId) {
    idHint.value = `已用场景内 id "${parsedId}" 覆盖填写的 "${effectiveCaseId}"`
    effectiveCaseId = parsedId
    caseId.value = parsedId
  }

  // 3. 落盘
  try {
    const ok = await window.testAgent.saveScenario(props.projectPath, effectiveCaseId, parsed)
    if (!ok) {
      saveError.value = '场景保存失败（saveScenario 返回 false）'
      return
    }
  } catch (e) {
    saveError.value = `场景保存失败：${(e as Error).message}`
    return
  }

  // 4. 执行
  running.value = true
  try {
    const r = await window.testAgent.rerunLocal(props.projectPath, effectiveCaseId)
    result.value = r
  } catch (e) {
    result.value = { ok: false, output: '', error: `执行失败：${(e as Error).message}` }
  } finally {
    running.value = false
  }
}
</script>

<template>
  <section class="card quick-reflect-panel">
    <div class="quick-reflect-head">
      <h2>⚡ 写场景直跑</h2>
      <button class="btn btn-soft btn-sm" @click="emit('close')">收起</button>
    </div>

    <div class="quick-reflect-project">
      <span class="hint">项目：{{ projectPath || '未选择' }}</span>
    </div>

    <!-- 场景 ID -->
    <div class="field">
      <label>场景 ID</label>
      <input v-model="caseId" placeholder="如 TC001" />
    </div>
    <p v-if="idHint" class="hint" style="margin:0 0 8px;color:var(--amber,#f59e0b)">{{ idHint }}</p>

    <!-- 模板填充按钮 -->
    <div class="quick-reflect-templates">
      <button class="btn btn-soft btn-sm" @click="fillTemplate('pojo')">填充 POJO 模板</button>
      <button class="btn btn-soft btn-sm" @click="fillTemplate('spring')">填充 Spring 模板</button>
      <button class="btn btn-soft btn-sm" @click="fillTemplate('spring-fixture-mock')">填充 Spring+Fixture+Mock 模板</button>
    </div>
    <p class="hint" style="margin:4px 0 8px;font-size:11px;white-space:pre-line">{{ EXCEPTION_EXAMPLE }}</p>

    <!-- JSON 编辑器（textarea） -->
    <ScenarioEditor v-model="scenarioJson" :error="jsonError" />

    <!-- 操作按钮 -->
    <div class="quick-reflect-actions">
      <button class="btn btn-primary" :disabled="!caseId || !scenarioJson || running || !projectPath" @click="runNow">
        {{ running ? '执行中…' : '⚡ 立即跑' }}
      </button>
    </div>

    <!-- 错误提示 -->
    <p v-if="saveError" class="error">{{ saveError }}</p>

    <!-- 结果内联显示 -->
    <div v-if="result" class="quick-reflect-result" :class="{ pass: result.ok, fail: !result.ok }">
      <div class="result-head">
        <span>{{ result.ok ? '✅ 通过' : '❌ 失败' }}</span>
      </div>
      <pre v-if="result.output" class="result-output">{{ result.output }}</pre>
      <p v-if="result.error" class="error">{{ result.error }}</p>
    </div>
  </section>
</template>

<style scoped>
.quick-reflect-panel {
  padding: 16px;
  margin-bottom: 16px;
}
.quick-reflect-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.quick-reflect-head h2 {
  margin: 0;
  font-size: 16px;
}
.quick-reflect-project {
  margin-bottom: 12px;
}
.quick-reflect-templates {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.quick-reflect-actions {
  margin-top: 12px;
}
.quick-reflect-result {
  margin-top: 12px;
  padding: 12px;
  border-radius: 6px;
}
.quick-reflect-result.pass {
  background: var(--green-bg, #f0fdf4);
  border-left: 4px solid var(--green, #22c55e);
}
.quick-reflect-result.fail {
  background: var(--red-bg, #fef2f2);
  border-left: 4px solid var(--red, #ef4444);
}
.result-head {
  font-weight: 600;
  margin-bottom: 8px;
}
.result-output {
  margin: 0;
  padding: 8px;
  background: rgba(0,0,0,0.04);
  border-radius: 4px;
  font-size: 12px;
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
