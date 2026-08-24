<template>
  <div class="dash-card top-tasks">
    <div class="dash-card-header">
      <span class="dash-card-title">Топ задач за период</span>
      <span class="top-tasks__period">{{ periodLabel }}</span>
    </div>
    <div v-if="items.length === 0" class="top-tasks__empty">
      Нет данных за выбранный период.
    </div>
    <ul v-else class="top-tasks__list">
      <li v-for="t in items" :key="t.issueKey" class="top-tasks__item">
        <div class="top-tasks__head">
          <span class="top-tasks__key">{{ t.issueKey }}</span>
          <span class="top-tasks__hours">{{ t.hours.toFixed(1) }} ч</span>
        </div>
        <div class="top-tasks__summary" :title="t.summary ?? t.issueKey">
          {{ t.summary ?? '—' }}
        </div>
        <div class="top-tasks__bar">
          <span class="top-tasks__bar-fill" :style="{ width: pct(t.hours) + '%' }"></span>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAnalyticsStore } from '../../store/analytics';

const store = useAnalyticsStore();

// Период управляется исключительно виджетом «Разбивка часов»,
// чтобы не было рассинхрона между полями дат.
const items = computed(() => store.topIssues);

const periodLabel = computed(() => {
  const f = store.breakdownFrom || '—';
  const t = store.breakdownTo || '—';
  return `за ${f} — ${t}`;
});

function pct(hours: number): number {
  const max = items.value.length ? Math.max(...items.value.map((i) => i.hours)) : 1;
  return Math.max(6, Math.round((hours / (max || 1)) * 100));
}
</script>

<style scoped>
.top-tasks__period {
  font-size: 0.7rem;
  color: var(--muted);
  white-space: nowrap;
}
.top-tasks__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.top-tasks__item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.top-tasks__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
.top-tasks__key {
  font-weight: 600;
  font-size: 0.8125rem;
  white-space: nowrap;
}
.top-tasks__hours {
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
.top-tasks__summary {
  font-size: 0.75rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.top-tasks__bar {
  height: 5px;
  border-radius: 3px;
  background: var(--color-surface-alt, #eef1f6);
  overflow: hidden;
  margin-top: 0.1rem;
}
.top-tasks__bar-fill {
  display: block;
  height: 100%;
  background: var(--primary, #2a62ff);
  border-radius: 3px;
  transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.top-tasks__empty {
  font-size: 0.8125rem;
  color: var(--muted);
  padding: 0.5rem 0;
}
</style>
