<script setup lang="ts">
/**
 * P4-1-c：JSON 场景轻量编辑器（共用子组件）。
 *
 * 原生 textarea + 外部传入校验错误文案，不引代码编辑器库（硬约束）。
 * 被 QuickReflectRun（P4-1-b）和 ScenariosPanel（P4-1-c 改造）共用，避免两份 textarea。
 */
defineProps<{
  /** JSON 字符串（v-model） */
  modelValue: string
  /** 外部传入的校验错误文案，显示在 textarea 下方 */
  error?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="scenario-editor">
    <textarea
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      class="scenario-json-textarea"
      rows="12"
      placeholder='粘贴或编辑 JSON 场景...&#10;{ "id": "TC001", "target": { ... }, "params": [...], "assertion": { "type": "return", "expected": ... } }'
      spellcheck="false"
    ></textarea>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>
