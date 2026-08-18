<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAnalyticsStore } from '../store/analytics';
import WeekHoursChart from '../components/dashboard/WeekHoursChart.vue';
import BreakdownChart from '../components/dashboard/BreakdownChart.vue';
import WorklogHeatmap from '../components/dashboard/WorklogHeatmap.vue';
import MissingDaysList from '../components/dashboard/MissingDaysList.vue';
import BulkSavingMetric from '../components/dashboard/BulkSavingMetric.vue';

const store = useAnalyticsStore();

const lastRefresh = computed(() => {
  if (!store.lastFetched) return 'никогда';
  return new Date(store.lastFetched).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
});

const weekMode = ref<'current' | 'previous'>('current');

async function refresh() {
  await store.fetchAll();
}

onMounted(async () => {
  await store.fetchAll();
});
</script>

<template>
  <div class="analytics-page">
    <!-- ─── Header ─── -->
    <div class="analytics-header">
      <h1>Аналитика</h1>
      <span class="muted-text">Обновлено: {{ lastRefresh }}</span>
      <button class="ghost-btn" title="Обновить" @click="refresh">↻ Обновить</button>
    </div>

    <!-- ─── Skeleton ─── -->
    <template v-if="store.loading">
      <div class="analytics-skeleton">
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
      </div>
    </template>

    <!-- ─── Bento-сетка ─── -->
    <template v-else>
      <div class="analytics-grid">
        <!-- 1. Диаграмма часов по дням, сравнение план/факт -->
        <WeekHoursChart
          class="span-2"
          :mode="weekMode"
          @update:mode="weekMode = $event"
        />

        <!-- 2. Разбивка часов по задачам/проектам -->
        <BreakdownChart class="span-2" />

        <!-- 3. Calendar heatmap — последние 3 месяца -->
        <WorklogHeatmap class="span-full" />

        <!-- 4. Дни с недозаполненным worklog -->
        <MissingDaysList />

        <!-- 5. Метрика экономии времени -->
        <BulkSavingMetric />
      </div>
    </template>

    <!-- ─── Глобальная ошибка ─── -->
    <div v-if="store.error" class="global-error">
      <span>⚠️ {{ store.error }}</span>
      <button class="ghost-btn" @click="refresh">Повторить</button>
    </div>
  </div>
</template>

<style scoped>
@import '../styles/dashboard.css';

.global-error {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--warning) 12%, var(--card));
  color: var(--warning);
  font-size: 0.9rem;
  margin-top: 0.5rem;
}
</style>
