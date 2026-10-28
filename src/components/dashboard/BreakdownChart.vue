<template>
  <div class="dash-card bdc">
    <div class="dash-card-header">
      <span class="dash-card-title">Разбивка часов</span>
      <div class="dash-tab-group">
        <button :class="['dash-tab', mode === 'project' && 'active']" @click="store.setBreakdownMode('project')">Проекты</button>
        <button :class="['dash-tab', mode === 'issue' && 'active']" @click="store.setBreakdownMode('issue')">Задачи</button>
      </div>
    </div>
    <div class="bdc__period">
      <div class="dash-tab-group">
        <button v-for="p in PRESETS" :key="p.id" :class="['dash-tab', preset === p.id && 'active']" @click="applyPreset(p.id)">{{ p.label }}</button>
      </div>
      <div class="dash-date-range">
        <DatePicker v-model="from" @update:model-value="preset = 'custom'" />
        <span class="dash-date-range__sep">—</span>
        <DatePicker v-model="to" @update:model-value="preset = 'custom'" />
      </div>
    </div>

    <div v-if="!rows.length" class="bdc__empty">За период списаний нет.</div>
    <ul v-else class="bdc__list">
      <li v-for="r in rows" :key="r.key" class="bdc__row" :title="`${r.label}: ${fmtH(r.hours)} ч (${r.share}%)`">
        <div class="bdc__name">
          <b>{{ r.key === OTHER ? 'Другие' : mode === 'project' ? r.key : r.key }}</b>
          <span v-if="r.key !== OTHER && r.title" class="bdc__title">{{ r.title }}</span>
          <span v-if="r.key === OTHER" class="bdc__title">{{ r.count }} {{ mode === 'project' ? 'проектов' : 'задач' }}</span>
        </div>
        <div class="bdc__track"><span class="bdc__fill" :class="{ 'is-other': r.key === OTHER }" :style="{ width: (r.hours / maxHours) * 100 + '%' }"></span></div>
        <span class="bdc__val">{{ fmtH(r.hours) }} ч</span>
        <span class="bdc__share">{{ r.share }}%</span>
      </li>
    </ul>
    <div v-if="rows.length" class="bdc__foot">Всего {{ fmtH(total) }} ч за период</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DatePicker from '../DatePicker.vue';
import { useAnalyticsStore } from '../../store/analytics';
import { addDaysIso, localIsoDate } from '../../utils/time';

const store = useAnalyticsStore();
const OTHER = '__other__';
const TOP = 7;

const PRESETS = [
  { id: 'week', label: 'Неделя', days: 7 },
  { id: 'month', label: 'Месяц', days: 0 },
  { id: '30', label: '30 дней', days: 30 },
  { id: '90', label: '3 мес.', days: 90 },
] as const;

const today = localIsoDate();
const preset = ref<string>('30');
const from = ref(addDaysIso(today, -29));
const to = ref(today);
function applyPreset(id: string) {
  preset.value = id;
  const p = PRESETS.find((x) => x.id === id)!;
  to.value = today;
  from.value = p.id === 'month' ? `${today.slice(0, 8)}01` : addDaysIso(today, -(p.days - 1));
}
watch([from, to], () => store.setBreakdownPeriod(from.value, to.value), { immediate: true });

const mode = computed(() => store.breakdownMode);
const total = computed(() => store.breakdownSlices.reduce((s, x) => s + x.hours, 0));
// Топ-7 + «Другие» — длинный хвост в одну строку, чтобы список оставался читаемым.
const rows = computed(() => {
  const all = store.breakdownSlices;
  const top = all.slice(0, TOP);
  const rest = all.slice(TOP);
  const share = (h: number) => (total.value ? Math.round((h / total.value) * 100) : 0);
  const out = top.map((s) => ({
    key: s.key, label: s.label, hours: s.hours, share: share(s.hours), count: 1,
    // Подпись: для проекта — название, для задачи — её summary (label = «KEY — summary»).
    title: mode.value === 'project' ? (s.label !== s.key ? s.label : '') : s.label.replace(/^[^\s]+ — /, '').replace(s.key, ''),
  }));
  if (rest.length) {
    const h = Math.round(rest.reduce((s, x) => s + x.hours, 0) * 100) / 100;
    out.push({ key: OTHER, label: 'Другие', hours: h, share: share(h), count: rest.length, title: '' });
  }
  return out;
});
const maxHours = computed(() => Math.max(0.01, ...rows.value.map((r) => r.hours)));
const fmtH = (h: number) => (Math.round(h * 10) / 10).toLocaleString('ru-RU');
</script>

<style scoped>
.bdc__period { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
/* Компактный однострочный диапазон дат: «от» и «до» рядом, без растягивания. */
.dash-date-range { display: flex; align-items: center; gap: 0.35rem; flex: 0 0 auto; white-space: nowrap; }
.dash-date-range :deep(.dp) { flex: 0 0 auto; width: 7.25rem; min-width: 7.25rem; }
.dash-date-range :deep(.dp-trigger) { padding: 0.3rem 0.5rem; font-size: 0.82rem; }
.dash-date-range__sep { font-size: 0.8rem; opacity: 0.6; flex: 0 0 auto; }
.bdc__empty { color: var(--muted); font-size: 0.875rem; padding: 1.5rem 0; text-align: center; }
.bdc__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.bdc__row { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr) 3.75rem 2.5rem; gap: 0.625rem; align-items: center; font-size: 0.8125rem; }
.bdc__name { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.bdc__name b { font-weight: 600; }
.bdc__title { font-size: 0.6875rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bdc__track { height: 0.75rem; border-radius: 4px; background: color-mix(in srgb, var(--chip) 70%, transparent); overflow: hidden; }
.bdc__fill { display: block; height: 100%; border-radius: 0 4px 4px 0; background: var(--primary); transition: width 220ms ease; }
.bdc__fill.is-other { background: color-mix(in srgb, var(--muted) 55%, transparent); }
.bdc__val { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.bdc__share { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.bdc__foot { font-size: 0.75rem; color: var(--muted); }
</style>
