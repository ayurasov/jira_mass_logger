<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useAnalyticsStore } from '../store/analytics';
import { useComposeStore } from '../store/compose';
import TodayCard from '../components/dashboard/TodayCard.vue';
import KpiTiles from '../components/dashboard/KpiTiles.vue';
import WeekHoursChart from '../components/dashboard/WeekHoursChart.vue';
import BreakdownChart from '../components/dashboard/BreakdownChart.vue';
import WorklogHeatmap from '../components/dashboard/WorklogHeatmap.vue';
import MissingDaysList from '../components/dashboard/MissingDaysList.vue';
import BulkSavingMetric from '../components/dashboard/BulkSavingMetric.vue';
import TopTasksList from '../components/dashboard/TopTasksList.vue';
import ActionIcon from '../components/ActionIcon.vue';

const store = useAnalyticsStore();
const compose = useComposeStore();

const lastRefresh = computed(() => {
  if (!store.lastFetched) return 'никогда';
  return new Date(store.lastFetched).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
});

async function refresh() {
  // Принудительная синхронизация с Jira + обновление кэша
  await store.syncFromJira(true);
}

onMounted(async () => {
  // Кэш показывается сразу, свежие данные из Jira подтягиваются не чаще раза в 10 минут.
  await store.syncFromJira();
});

// Заполнили «одним нажатием» или отменили — цифры дашборда обновляются из кэша сразу.
watch(() => [compose.batch.running, compose.undoing], ([running, undoing], prev) => {
  if (!running && !undoing && (prev?.[0] || prev?.[1])) store.fetchAll();
});
</script>

<template>
  <div class="analytics-page">
    <!-- ─── Header ─── -->
    <div class="analytics-header">
      <h1>Дашборд</h1>
      <span class="muted-text">Обновлено: {{ lastRefresh }}</span>
      <span v-if="store.syncing" class="muted-text sync-hint">
        <ActionIcon name="refresh" :size="12" class="spin" /> Синхронизация с Jira…
      </span>
      <button class="ghost-btn" :disabled="store.loading || store.syncing" title="Обновить данные из Jira" @click="refresh">
        <ActionIcon name="refresh" :size="14" /> Обновить
      </button>
    </div>

    <!-- ─── Skeleton (первичная загрузка кэша) ─── -->
    <template v-if="store.loading && !store.lastFetched">
      <div class="analytics-skeleton">
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
        <div class="skeleton skeleton-card" />
      </div>
    </template>

    <template v-else>
      <div class="analytics-grid">
        <!-- 1. Сегодня + пропуски: главное действие дня -->
        <TodayCard class="span-2" />
        <MissingDaysList class="span-2" />

        <!-- 2. Итоги периода -->
        <KpiTiles />

        <!-- 3. Неделя по дням и разбивка по проектам/задачам -->
        <WeekHoursChart class="span-2" />
        <BreakdownChart class="span-2" />

        <!-- 4. Заполненность за 3 месяца -->
        <WorklogHeatmap class="span-full" />

        <!-- 5. Топ задач и экономия времени -->
        <TopTasksList class="span-2" />
        <BulkSavingMetric class="span-2" />
      </div>
    </template>

    <!-- ─── Ошибка синхронизации с Jira (не блокирует дашборд) ─── -->
    <div v-if="store.syncError" class="global-error sync-error-banner">
      <span class="err-inline"><ActionIcon name="warning" :size="14" /> {{ store.syncError }}</span>
      <button class="ghost-btn" @click="refresh">Повторить</button>
    </div>

    <!-- ─── Глобальная ошибка кэша ─── -->
    <div v-else-if="store.error" class="global-error">
      <span class="err-inline"><ActionIcon name="warning" :size="14" /> {{ store.error }}</span>
      <button class="ghost-btn" @click="refresh">Повторить</button>
    </div>
  </div>
</template>

<!--
  @import взят из-под scoped: правила в dashboard.css должны быть
  глобальными — они описывают .analytics-grid, .dash-card и т.д.,
  которые рендерятся внутри дочерних компонентов.
  scoped блок сохранён только для правил, уникальных для этого view.
-->
<style>
@import '../styles/dashboard.css';
</style>

<style scoped>
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

.sync-error-banner {
  background: color-mix(in srgb, var(--warning) 8%, var(--card));
}

.sync-hint {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8rem;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
  display: inline-block;
}
</style>
