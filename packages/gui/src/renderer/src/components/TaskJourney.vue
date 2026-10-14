<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { JourneyStep } from '../task-journey'

const props = defineProps<{ steps: JourneyStep[] }>()

const advancingStepId = ref<string | null>(null)
let transitionTimer: ReturnType<typeof setTimeout> | undefined

watch(() => props.steps.map((step) => ({ id: step.id, status: step.status })), (next, previous) => {
  if (!previous) return
  const completed = next.find((step, index) => step.status === 'done' && previous[index]?.id === step.id && previous[index]?.status === 'active')
  if (!completed) return
  if (transitionTimer) clearTimeout(transitionTimer)
  advancingStepId.value = completed.id
  transitionTimer = setTimeout(() => { advancingStepId.value = null }, 720)
})

onBeforeUnmount(() => { if (transitionTimer) clearTimeout(transitionTimer) })

const labels = { done: '已完成', active: '进行中', attention: '待确认', waiting: '未开始', skipped: '已跳过', blocked: '已中断' }
</script>

<template>
  <section class="task-journey card" aria-label="任务路线">
    <div class="journey-heading"><div><span class="eyebrow">任务路线</span><h2>测试任务进度</h2></div><span class="journey-hint">按可核验的任务事件实时更新</span></div>
    <ol class="journey-list">
      <li v-for="(step, index) in steps" :key="step.id" class="journey-step" :class="[`journey-${step.status}`, { 'journey-advance': advancingStepId === step.id }]" :aria-current="step.status === 'active' || step.status === 'attention' ? 'step' : undefined">
        <span class="journey-node">{{ step.status === 'done' ? '✓' : index + 1 }}</span>
        <div class="journey-copy"><strong>{{ step.title }}</strong><span>{{ step.detail }}</span></div>
        <span class="journey-status">{{ labels[step.status] }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.task-journey { padding: 20px 22px; margin: 18px 0; }
.journey-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.journey-heading h2 { margin: 5px 0 0; font-size: 18px; }
.journey-hint { color: var(--muted); font-size: 11px; text-align: right; }
.journey-list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0; list-style: none; padding: 0; margin: 0; }
.journey-step { position: relative; min-width: 0; padding: 0 12px 0 0; }
.journey-step:not(:last-child)::after { content: ''; position: absolute; top: 15px; left: 34px; right: 6px; height: 2px; background: var(--line); }
.journey-node { position: relative; z-index: 1; display: grid; place-items: center; width: 30px; height: 30px; border: 2px solid var(--line); border-radius: 50%; background: #fff; color: var(--muted); font-size: 12px; font-weight: 800; }
.journey-copy { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.journey-copy strong { color: var(--text); font-size: 12px; }
.journey-copy span { color: var(--muted); font-size: 11px; line-height: 1.35; }
.journey-status { display: inline-block; margin-top: 8px; color: var(--muted); font-size: 11px; font-weight: 700; }
.journey-done .journey-node { border-color: #50b878; background: var(--green-bg); color: #137a37; }
.journey-done:not(:last-child)::after { background: #50b878; }
.journey-active .journey-node { border-color: var(--blue); background: var(--blue-bg); color: var(--blue); }
.journey-active .journey-status { color: var(--blue); }
.journey-active .journey-node { animation: journey-breathe 2.6s ease-in-out infinite; }
.journey-advance:not(:last-child)::before { content: ''; position: absolute; top: 15px; left: 34px; right: 6px; z-index: 1; height: 2px; background: var(--blue); transform-origin: left center; animation: journey-forward .7s ease-out both; }
.journey-attention .journey-node, .journey-blocked .journey-node { border-color: #e9a03d; background: var(--amber-bg); color: #875014; }
.journey-attention .journey-status, .journey-blocked .journey-status { color: #875014; }
.journey-skipped { opacity: .55; }
@keyframes journey-breathe { 0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, .08); } 50% { box-shadow: 0 0 0 5px rgba(37, 99, 235, .13); } }
@keyframes journey-forward { from { transform: scaleX(0); opacity: .35; } to { transform: scaleX(1); opacity: 1; } }
@media (max-width: 900px) { .journey-list { grid-template-columns: 1fr; } .journey-step { min-height: 76px; padding: 0 0 16px 48px; } .journey-node { position: absolute; left: 0; top: 0; } .journey-step:not(:last-child)::after, .journey-advance:not(:last-child)::before { top: 30px; bottom: 0; left: 14px; right: auto; width: 2px; height: auto; } .journey-copy { margin-top: 0; } .journey-status { margin-top: 5px; } }
@media (max-width: 680px) { .journey-heading { align-items: start; flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { .journey-active .journey-node, .journey-advance:not(:last-child)::before { animation: none; } }
</style>
