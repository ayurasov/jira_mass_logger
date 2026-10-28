<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Пропуски за 30 дней</span>
      <span class="dash-badge" :data-variant="days.length === 0 ? 'success' : 'warning'">
        <template v-if="days.length === 0"><ActionIcon name="check-circle" :size="12" /> Всё заполнено</template>
        <template v-else>{{ days.length }} дн. · не хватает {{ fmtH(totalDeficit) }} ч</template>
      </span>
    </div>

    <div v-if="days.length === 0" class="missing-empty">
      <span class="missing-empty__inner"><ActionIcon name="sparkles" :size="14" /> За последние 30 дней все рабочие дни заполнены.</span>
    </div>

    <template v-else>
      <ul class="missing-list">
        <li
          v-for="d in days" :key="d.date" class="missing-item missing-item--clickable"
          title="Открыть день в «Собрать день»" @click="goToCompose(d.date)"
        >
          <span class="missing-date">{{ formatDate(d.date) }}</span>
          <span class="missing-hours">{{ d.hours > 0 ? fmtH(d.hours) + ' ч' : 'нет записей' }}</span>
          <span class="missing-deficit">−{{ fmtH(d.deficit) }} ч</span>
          <button class="dash-quick-btn" title="Открыть день в «Собрать день»" @click.stop="goToCompose(d.date)">Собрать</button>
        </li>
      </ul>
      <OneClickFill
        :dates="days.map((d) => d.date)" compact
        :label="`Заполнить все · ${days.length} дн. одним нажатием`"
        @open-day="goToCompose"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { parseIsoDate } from '../../utils/time';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import ActionIcon from '../ActionIcon.vue';
import OneClickFill from '../OneClickFill.vue';
import { useAnalyticsStore } from '../../store/analytics';

const store = useAnalyticsStore();
const router = useRouter();

// Новые сверху — свежие пропуски важнее.
const days = computed(() => [...store.missingDays].reverse());
const totalDeficit = computed(() => days.value.reduce((s, d) => s + d.deficit, 0));
const fmtH = (h: number) => (Math.round(h * 10) / 10).toLocaleString('ru-RU');

function formatDate(d: string) {
  return parseIsoDate(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
}

function goToCompose(date: string) {
  router.push({ name: 'compose', query: { date } });
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
  max-height: 15rem;
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
.missing-item--clickable { cursor: pointer; transition: background 0.15s, transform 0.05s; }
.missing-item--clickable:hover { background: color-mix(in srgb, var(--primary) 14%, var(--chip)); }
.missing-item--clickable:active { transform: translateY(1px); }
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
