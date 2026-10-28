<template>
  <!-- «Сегодня»: сколько залогировано к норме и главное действие — заполнить день одним нажатием. -->
  <div class="dash-card today">
    <div class="dash-card-header">
      <span class="dash-card-title">Сегодня · {{ dateTitle }}</span>
      <span v-if="!t.workday" class="dash-badge">выходной</span>
      <span v-else-if="done" class="dash-badge" data-variant="success"><ActionIcon name="check-circle" :size="12" /> день заполнен</span>
      <span v-else class="dash-badge" data-variant="warning">не хватает {{ fmtH(t.norm - t.hours) }} ч</span>
    </div>

    <div class="today__main">
      <div class="today__nums">
        <span class="today__value">{{ fmtH(t.hours) }}</span>
        <span class="today__of">из {{ fmtH(t.norm) }} ч</span>
      </div>
      <div class="today__bar" role="progressbar" :aria-valuenow="t.hours" :aria-valuemax="t.norm" :title="`${fmtH(t.hours)} из ${fmtH(t.norm)} ч`">
        <span class="today__fill" :class="{ 'is-done': done }" :style="{ width: Math.min(100, (t.hours / (t.norm || 8)) * 100) + '%' }"></span>
      </div>
      <p class="today__hint">
        <template v-if="!t.workday">Нерабочий день по графику — заполнять не нужно.</template>
        <template v-else-if="done">Все часы на сегодня списаны. Отличная работа!</template>
        <template v-else>Одно нажатие: встречи из календаря и привычные задачи с обычными описаниями — ровно до нормы.</template>
      </p>
    </div>

    <div class="today__actions">
      <!-- После заполнения кнопка скрывается, но итог с «Отменить заполнение» остаётся. -->
      <OneClickFill v-if="t.workday && (!done || compose.batch.results.length)" :dates="done ? [] : [t.date]" label="Заполнить сегодня" @open-day="openCompose" />
      <button class="today__link" @click="openCompose(t.date)">
        <ActionIcon name="arrow-right" :size="14" /> {{ t.workday && !done ? 'Проверить и поправить вручную' : 'Открыть «Собрать день»' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import ActionIcon from '../ActionIcon.vue';
import OneClickFill from '../OneClickFill.vue';
import { useAnalyticsStore } from '../../store/analytics';
import { useComposeStore } from '../../store/compose';
import { parseIsoDate } from '../../utils/time';

const store = useAnalyticsStore();
const compose = useComposeStore();
const router = useRouter();
const t = computed(() => store.todayStat);
const done = computed(() => t.value.hours >= t.value.norm - 0.01);
const dateTitle = computed(() => parseIsoDate(t.value.date).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
const fmtH = (h: number) => (Math.round(Math.max(0, h) * 10) / 10).toLocaleString('ru-RU');
const openCompose = (date: string) => router.push({ name: 'compose', query: { date } });
</script>

<style scoped>
.today { justify-content: space-between; }
.today .dash-card-title::first-letter { text-transform: uppercase; }
.today__main { display: flex; flex-direction: column; gap: 0.625rem; }
.today__nums { display: flex; align-items: baseline; gap: 0.5rem; }
.today__value { font-size: 2.75rem; font-weight: 750; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.today__of { font-size: 1rem; color: var(--muted); }
.today__bar { height: 0.625rem; border-radius: 999px; background: color-mix(in srgb, var(--chip) 80%, transparent); overflow: hidden; }
.today__fill { display: block; height: 100%; border-radius: 999px; background: var(--primary); transition: width 300ms ease; }
.today__fill.is-done { background: var(--success); }
.today__hint { margin: 0; font-size: 0.8125rem; color: var(--muted); }
.today__actions { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
.today__link { display: inline-flex; align-items: center; gap: 0.35rem; border: none; background: none; padding: 0; color: var(--primary); font-weight: 600; font-size: 0.8125rem; }
.today__link:hover { text-decoration: underline; }
</style>
