<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Недозаполненные дни &mdash; {{ currentMonthLabel }}</span>
      <span class="dash-badge" :data-variant="days.length === 0 ? 'success' : 'warning'">
        {{ days.length === 0 ? 'Всё заполнено ✔' : days.length + ' дн. с дефицитом' }}
      </span>
    </div>

    <div v-if="days.length === 0" class="missing-empty">
      <span>🎉 У вас нет пропущенных дней в этом месяце!</span>
    </div>

    <ul v-else class="missing-list">
      <li v-for="d in days" :key="d.date" class="missing-item">
        <span class="missing-date">{{ formatDate(d.date) }}</span>
        <span class="missing-hours" :data-ok="d.hours > 0">
          {{ d.hours > 0 ? d.hours + ' ч' : 'Нет записей' }}
        </span>
        <span class="missing-deficit">-{{ d.deficit }} ч</span>
        <button class="dash-quick-btn" @click="goToWizard(d.date)" title="Быстрый переход в булк-мастер">
          ↗️ Создать
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAnalyticsStore } from '../../store/analytics';

const store = useAnalyticsStore();
const router = useRouter();

const days = computed(() => store.missingDays);

const currentMonthLabel = computed(() => {
  const now = new Date();
  return now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
});

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
}

function goToWizard(date: string) {
  // переходим в булк-мастер с предзаполненной датой
  router.push({ name: 'bulk-log', query: { date } });
}
</script>

<style scoped>
.missing-empty {
  padding: 1rem 0;
  color: var(--muted);
  font-size: 0.9rem;
  text-align: center;
}
.missing-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 18rem;
  overflow-y: auto;
}
.missing-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.5rem;
  border-radius: 0.6rem;
  background: var(--chip);
  font-size: 0.88rem;
}
.missing-date { flex: 1; min-width: 0; }
.missing-hours {
  color: var(--warning);
  font-variant-numeric: tabular-nums;
  min-width: 4.5rem;
  text-align: right;
}
.missing-hours[data-ok='true'] { color: var(--warning); }
.missing-deficit {
  color: var(--danger);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  min-width: 3.5rem;
  text-align: right;
}
.dash-quick-btn {
  padding: 0.3rem 0.7rem;
  border-radius: 0.5rem;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--primary);
  font-size: 0.82rem;
  white-space: nowrap;
  transition: background 0.15s;
}
.dash-quick-btn:hover { background: var(--chip); }
</style>
