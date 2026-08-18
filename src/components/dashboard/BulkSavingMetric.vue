<template>
  <div class="dash-card saving-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Экономия времени</span>
    </div>
    <div class="saving-body">
      <div class="saving-stat">
        <span class="saving-value animated-number" ref="totalEl">{{ displayTotal }}</span>
        <span class="saving-label">записей через bulk-мастер</span>
      </div>
      <div class="saving-stat highlight">
        <span class="saving-value" style="color:var(--success)">{{ displaySaved }} мин</span>
        <span class="saving-label">сэкономлено всего</span>
      </div>
      <div class="saving-compare">
        <div class="saving-compare-row">
          <span>Ручной ввод</span>
          <div class="compare-bar-wrap">
            <div class="compare-bar manual" :style="{ width: manualPct + '%' }"></div>
          </div>
          <span class="compare-val">~{{ Math.round(metric.estimatedManualMinutes) }} мин</span>
        </div>
        <div class="saving-compare-row">
          <span>Bulk-мастер</span>
          <div class="compare-bar-wrap">
            <div class="compare-bar bulk" :style="{ width: bulkPct + '%' }"></div>
          </div>
          <span class="compare-val">~{{ Math.round(metric.bulkMinutes) }} мин</span>
        </div>
      </div>
      <p v-if="metric.totalBulkEntries === 0" class="saving-hint">
        Данные появятся после первых созданных записей через bulk-мастер.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useAnalyticsStore } from '../../store/analytics';

const store = useAnalyticsStore();
const metric = computed(() => store.bulkSavingMetric);

// анимированный счётчик
const displayTotal = ref(0);
const displaySaved = ref(0);

function animateCount(target: number, setter: (v: number) => void, duration = 600) {
  const start = performance.now();
  const from = 0;
  function step(now: number) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    setter(Math.round(from + (target - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

watch(metric, (m) => {
  animateCount(m.totalBulkEntries, v => displayTotal.value = v);
  animateCount(m.savedMinutes,     v => displaySaved.value = v);
}, { immediate: true });

const maxMins = computed(() => Math.max(metric.value.estimatedManualMinutes, 1));
const manualPct = computed(() => Math.min(100, (metric.value.estimatedManualMinutes / maxMins.value) * 100));
const bulkPct   = computed(() => Math.min(100, (metric.value.bulkMinutes / maxMins.value) * 100));
</script>

<style scoped>
.saving-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.25rem;
}
.saving-stat { display: flex; flex-direction: column; gap: 0.2rem; }
.saving-value { font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.saving-label { font-size: 0.82rem; color: var(--muted); }
.saving-stat.highlight .saving-value { font-size: 1.6rem; }

.saving-compare { display: flex; flex-direction: column; gap: 0.5rem; }
.saving-compare-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; }
.saving-compare-row > span:first-child { width: 6rem; flex-shrink: 0; color: var(--muted); }
.compare-bar-wrap { flex: 1; height: 6px; background: var(--chip); border-radius: 999rem; overflow: hidden; }
.compare-bar { height: 100%; border-radius: 999rem; transition: width 0.6s cubic-bezier(0.16,1,0.3,1); }
.compare-bar.manual { background: var(--danger); }
.compare-bar.bulk   { background: var(--success); }
.compare-val { font-variant-numeric: tabular-nums; min-width: 4rem; text-align: right; }

.saving-hint { font-size: 0.8rem; color: var(--muted); margin: 0; }
</style>
