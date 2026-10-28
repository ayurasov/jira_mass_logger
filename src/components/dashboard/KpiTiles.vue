<template>
  <!-- Плитки-итоги: неделя, месяц, среднее в рабочий день, серия дней по норме. -->
  <div class="kpi">
    <div class="kpi__tile">
      <span class="kpi__label">Неделя</span>
      <span class="kpi__value">{{ fmtH(week.fact) }} <small>/ {{ fmtH(week.planTotal) }} ч</small></span>
      <div class="kpi__bar"><span :class="{ 'is-done': week.fact >= week.planToDate - 0.01 }" :style="{ width: pct(week.fact, week.planTotal) + '%' }"></span><i :style="{ left: pct(week.planToDate, week.planTotal) + '%' }" title="Норма на сегодня"></i></div>
      <span class="kpi__hint" :class="hintClass(week)">{{ hint(week) }}</span>
    </div>
    <div class="kpi__tile">
      <span class="kpi__label">{{ monthName }}</span>
      <span class="kpi__value">{{ fmtH(month.fact) }} <small>/ {{ fmtH(month.planTotal) }} ч</small></span>
      <div class="kpi__bar"><span :class="{ 'is-done': month.fact >= month.planToDate - 0.01 }" :style="{ width: pct(month.fact, month.planTotal) + '%' }"></span><i :style="{ left: pct(month.planToDate, month.planTotal) + '%' }" title="Норма на сегодня"></i></div>
      <span class="kpi__hint" :class="hintClass(month)">{{ hint(month) }}</span>
    </div>
    <div class="kpi__tile">
      <span class="kpi__label">В среднем за рабочий день</span>
      <span class="kpi__value">{{ fmtH(avg) }} <small>ч</small></span>
      <span class="kpi__hint">норма {{ fmtH(norm) }} ч · {{ month.workdaysPassed }} {{ plural(month.workdaysPassed, 'рабочий день', 'рабочих дня', 'рабочих дней') }} в месяце</span>
    </div>
    <div class="kpi__tile">
      <span class="kpi__label">Серия по норме</span>
      <span class="kpi__value">{{ streak }} <small>{{ plural(streak, 'день', 'дня', 'дней') }}</small></span>
      <span class="kpi__hint">{{ streak ? 'рабочих дней подряд заполнено полностью' : 'заполните день до нормы, чтобы начать серию' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAnalyticsStore, type PeriodStat } from '../../store/analytics';
import { useSettingsStore } from '../../store/settings';

const store = useAnalyticsStore();
const settings = useSettingsStore();
const week = computed(() => store.weekStat);
const month = computed(() => store.monthStat);
const streak = computed(() => store.streakDays);
const norm = computed(() => settings.workHoursPerDay ?? 8);
const avg = computed(() => (month.value.workdaysPassed ? month.value.fact / month.value.workdaysPassed : 0));
const monthName = computed(() => {
  const m = new Date().toLocaleDateString('ru-RU', { month: 'long' });
  return m.charAt(0).toUpperCase() + m.slice(1);
});

const fmtH = (h: number) => (Math.round(h * 10) / 10).toLocaleString('ru-RU');
const pct = (v: number, of: number) => (of > 0 ? Math.min(100, (v / of) * 100) : 0);
function hint(p: PeriodStat): string {
  const diff = Math.round((p.fact - p.planToDate) * 10) / 10;
  if (Math.abs(diff) < 0.05) return 'ровно по норме на сегодня';
  return diff < 0 ? `отставание ${fmtH(-diff)} ч от нормы на сегодня` : `опережение ${fmtH(diff)} ч`;
}
const hintClass = (p: PeriodStat) => (p.fact < p.planToDate - 0.05 ? 'is-warn' : 'is-ok');
function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
</script>

<style scoped>
.kpi { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; }
.kpi__tile { display: flex; flex-direction: column; gap: 0.3rem; background: var(--card); border: 1px solid var(--border); border-radius: 1rem; box-shadow: var(--shadow); padding: 0.875rem 1rem; min-width: 0; }
.kpi__label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.kpi__value { font-size: 1.625rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.15; }
.kpi__value small { font-size: 0.875rem; font-weight: 500; color: var(--muted); }
.kpi__bar { position: relative; height: 0.375rem; border-radius: 999px; background: color-mix(in srgb, var(--chip) 80%, transparent); margin: 0.2rem 0; }
.kpi__bar span { display: block; height: 100%; border-radius: 999px; background: var(--warning); }
.kpi__bar span.is-done { background: var(--success); }
.kpi__bar i { position: absolute; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: var(--fg); opacity: 0.6; transform: translateX(-1px); }
.kpi__hint { font-size: 0.75rem; color: var(--muted); }
.kpi__hint.is-warn { color: var(--amber-fg); }
.kpi__hint.is-ok { color: var(--success); }
@media (max-width: 64rem) { .kpi { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
