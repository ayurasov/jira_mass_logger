<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Заполненность worklog &mdash; 3 месяца</span>
      <div class="heatmap-header-right">
        <div class="heatmap-legend">
          <span class="legend-label">проблема</span>
          <span v-for="l in [0,1,2,3,4]" :key="l" class="legend-cell" :data-level="l"></span>
          <span class="legend-label">норма</span>
        </div>
        <button
          class="heatmap-refresh-btn"
          :disabled="analyticsStore.syncing"
          :title="analyticsStore.syncing ? 'Синхронизация…' : 'Обновить данные из Jira'"
          @click="handleRefresh"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="{ 'spin': analyticsStore.syncing }"
          >
            <path d="M21 2v6h-6"/>
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
            <path d="M3 22v-6h6"/>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          </svg>
          {{ analyticsStore.syncing ? 'Обновление…' : 'Обновить' }}
        </button>
      </div>
    </div>
    <div class="heatmap-scroll-wrap">
      <div class="heatmap-grid">
        <!-- заголовки дней недели -->
        <div class="heatmap-weekdays">
          <span class="weekday-spacer"></span>
          <span v-for="d in weekdayLabels" :key="d">{{ d }}</span>
        </div>
        <!-- колонки по неделям + шапка с номером недели и месяцами сверху -->
        <div class="heatmap-weeks-wrap">
          <div class="heatmap-months">
            <button
              v-for="(m, mi) in months"
              :key="mi"
              class="heatmap-month"
              :class="'heatmap-month--' + m.level"
              :style="{ '--mw': m.weeks }"
              :title="`${m.label}: ${m.hours.toFixed(1)} ч из ${m.target} ч — открыть в worklog`"
              @click="goToWeek(m.from, m.to)"
            >{{ m.label }}</button>
          </div>
          <div class="heatmap-weeks">
            <div v-for="(week, wi) in weeks" :key="wi" class="heatmap-week">
              <button
                v-if="weekMeta[wi]"
                class="heatmap-week-num"
                :class="'heatmap-week-num--' + weekMeta[wi].level"
                :title="`Неделя ${weekMeta[wi].label} (${weekMeta[wi].from} … ${weekMeta[wi].to}): ${weekMeta[wi].hours.toFixed(1)} ч — открыть в worklog`"
                @click="goToWeek(weekMeta[wi].from, weekMeta[wi].to)"
              >{{ weekMeta[wi].short }}</button>
              <div
                v-for="(cell, ci) in week"
                :key="cell ? cell.date : wi + '-' + ci"
                class="heatmap-cell"
                :class="{
                  'heatmap-cell--clickable': !!cell,
                  'heatmap-cell--weekend': cell && isWeekend(cell.date) && !holidayTitle(cell.date),
                  'heatmap-cell--holiday': cell && !!holidayTitle(cell.date),
                }"
                :data-level="cell ? cell.level : -1"
                :title="cell ? cellTitle(cell) : ''"
                @click="cell ? goToWorklog(cell.date) : null"
              >{{ cell && cell.hours > 0 ? cell.hours.toFixed(1) : '' }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAnalyticsStore, type HeatmapCell } from '../../store/analytics';
import { useSettingsStore } from '../../store/settings';

// Парсим 'YYYY-MM-DD' как ЛОКАЛЬНУЮ дату (а не UTC через new Date(str)),
// чтобы избежать сдвига дня в часовых поясах западнее UTC.
function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const analyticsStore = useAnalyticsStore();
const store = analyticsStore; // алиас для обратной совместимости вычисляемых свойств
const settings = useSettingsStore();
const router = useRouter();

async function handleRefresh() {
  await analyticsStore.syncFromJira(true);
}

function goToWorklog(date: string) {
  router.push({ name: 'worklog', query: { from: date, to: date } });
}

function goToWeek(from: string, to: string) {
  router.push({ name: 'worklog', query: { from, to } });
}

const weekdayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function isWeekend(dateIso: string): boolean {
  const d = parseIsoLocal(dateIso).getDay();
  return d === 0 || d === 6;
}

// Рабочий день = не выходной и не праздник (по производственному календарю РФ)
function isWorkingDay(dateIso: string): boolean {
  return !isWeekend(dateIso) && !settings.isHoliday(dateIso);
}

function holidayTitle(dateIso: string): string | null {
  return settings.holidaysMap.get(dateIso) ?? null;
}

function cellTitle(cell: HeatmapCell): string {
  const holiday = holidayTitle(cell.date);
  const base = `${cell.date}: ${cell.hours} ч`;
  if (holiday) return `${base} — ${holiday} (нерабочий день)`;
  if (isWeekend(cell.date)) return `${base} — выходной`;
  return `${base} — открыть в worklog`;
}

// Группируем ячейки по неделям (вертикальные колонки), как в GitHub contribution graph
// Неделя начинается с понедельника (индекс 0 = Пн)
const weeks = computed(() => {
  const cells = store.heatmapCells;
  if (!cells.length) return [];

  // находим день недели первой ячейки (индекс 1 = Пн в getDay())
  const firstDate = parseIsoLocal(cells[0].date);
  const startDow = firstDate.getDay(); // 0=Вс, 1=Пн ...
  // преобразуем: 0=Пн..6=Вс
  const offset = startDow === 0 ? 6 : startDow - 1;

  // заполняем пустыми в начале
  const flat: (HeatmapCell | null)[] = [
    ...Array(offset).fill(null),
    ...cells,
  ];

  // бьём по 7 элементов в колонку
  const result: (HeatmapCell | null)[][] = [];
  for (let i = 0; i < flat.length; i += 7) {
    const col = flat.slice(i, i + 7);
    while (col.length < 7) col.push(null);
    result.push(col);
  }
  return result;
});

// Метаданные по каждой колонке-неделе: номер недели (ISO), диапазон дат,
// суммарные часы и уровень заполнения (0..4) для окраски шапки.
const normPerDay = 8;

// Целевые часы недели/месяца считаем только по видимой части и только по
// фактическим рабочим дням (не выходные, не праздники производственного
// календаря РФ) — так индикация цветом всегда отталкивается от того, что
// реально видно в виджете, без «недозаполненности» за праздники.
const weekMeta = computed(() => {
  return weeks.value.map((week) => {
    const present = week.filter(Boolean) as HeatmapCell[];
    const first = present[0];
    if (!first) return null;
    const from = first.date;
    const last = present[present.length - 1];
    const to = last ? last.date : from;
    const hours = present.reduce((s, c) => s + c.hours, 0);
    const target = present.filter((c) => isWorkingDay(c.date)).length * normPerDay;
    // ISO-номер недели из первой ячейки
    const iso = first.date.slice(0, 4) + '-W' + isoWeekNum(first.date);
    const ratio = target > 0 ? hours / target : (hours > 0 ? 1 : 0);
    const level: 0 | 1 | 2 | 3 | 4 = target <= 0 ? (hours > 0 ? 4 : 0) : hours <= 0 ? 0 : ratio < 0.5 ? 1 : ratio < 0.8 ? 2 : ratio < 1.0 ? 3 : 4;
    return { label: iso, short: 'w' + iso.split('-W')[1], from, to, hours, level };
  });
});

// Месяцы над неделями: группируем последовательные колонки-недели по месяцу.
// Каждый месяц — кнопка шириной во все свои недели, окрашенная по качеству
// заполнения (проблема → норма), кликабельная → переход в worklog на диапазон.
const months = computed(() => {
  const out: { label: string; weeks: number; from: string; to: string; hours: number; target: number; level: 0 | 1 | 2 | 3 | 4 }[] = [];
  const meta = weekMeta.value;
  const cells = weeks.value;
  let cur: { label: string; weeks: number; from: string; to: string; hours: number; target: number } | null = null;
  const fmt = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
  for (let i = 0; i < meta.length; i++) {
    const w = meta[i];
    if (!w) continue;
    const monthKey = parseIsoLocal(w.from).getMonth();
    if (!cur || parseIsoLocal(cur.from).getMonth() !== monthKey) {
      if (cur) out.push(finalizeMonth(cur));
      cur = { label: fmt.format(parseIsoLocal(w.from)).replace('.', ''), weeks: 0, from: w.from, to: w.to, hours: 0, target: 0 };
    }
    // считаем целевые часы месяца только по видимым в этой неделе рабочим дням
    const present = (cells[i] ?? []).filter(Boolean) as HeatmapCell[];
    const weekTarget = present.filter((c) => isWorkingDay(c.date)).length * normPerDay;
    cur.weeks++;
    cur.to = w.to;
    cur.hours += w.hours;
    cur.target += weekTarget;
  }
  if (cur) out.push(finalizeMonth(cur));
  return out;
});

function finalizeMonth(m: { label: string; weeks: number; from: string; to: string; hours: number; target: number }) {
  const ratio = m.target > 0 ? m.hours / m.target : (m.hours > 0 ? 1 : 0);
  const level: 0 | 1 | 2 | 3 | 4 = m.target <= 0 ? (m.hours > 0 ? 4 : 0) : m.hours <= 0 ? 0 : ratio < 0.5 ? 1 : ratio < 0.8 ? 2 : ratio < 1.0 ? 3 : 4;
  return { ...m, level };
}

function isoWeekNum(dateIso: string): string {
  const date = parseIsoLocal(dateIso);
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return String(Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)).padStart(2, '0');
}
</script>

<style scoped>
.heatmap-scroll-wrap {
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
.heatmap-grid {
  display: flex;
  gap: 0.375rem;
  min-width: max-content;
}
.heatmap-weeks-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.heatmap-months {
  display: flex;
  gap: 3px;
}
.heatmap-month {
  width: calc(var(--mw) * (2.5rem + 3px) - 3px);
  height: 18px;
  border: none;
  border-radius: 3px;
  font-size: 0.65rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  text-transform: capitalize;
  line-height: 18px;
  padding: 0;
}
.heatmap-month:hover { opacity: 0.85; }
.heatmap-month--0 { background: var(--heatmap-0); }
.heatmap-month--1 { background: var(--heatmap-1); }
.heatmap-month--2 { background: var(--heatmap-2); color: #4a3d00; }
.heatmap-month--3 { background: var(--heatmap-3); color: #234015; }
.heatmap-month--4 { background: var(--heatmap-4); }
.heatmap-weekdays {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: calc(18px + 3px + 2px);
}
.weekday-spacer { height: 22px; }
.heatmap-weekdays span {
  font-size: 0.7rem;
  color: var(--muted);
  width: 2.5rem;
  height: 22px;
  line-height: 22px;
  text-align: right;
}
.heatmap-weeks {
  display: flex;
  gap: 3px;
}
.heatmap-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: stretch;
}
.heatmap-week-num {
  height: 20px;
  border: none;
  border-radius: 3px;
  font-size: 0.62rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  margin-bottom: 1px;
  line-height: 20px;
  padding: 0;
}
.heatmap-week-num:hover { opacity: 0.8; }
.heatmap-week-num--0 { background: var(--heatmap-0); color: #fff; }
.heatmap-week-num--1 { background: var(--heatmap-1); }
.heatmap-week-num--2 { background: var(--heatmap-2); }
.heatmap-week-num--3 { background: var(--heatmap-3); }
.heatmap-week-num--4 { background: var(--heatmap-4); }
.heatmap-cell {
  width: 2.5rem;
  height: 22px;
  border-radius: 3px;
  background: var(--heatmap-0);
  transition: background 0.15s;
  cursor: default;
  font-size: 0.6rem;
  line-height: 22px;
  text-align: center;
  color: rgba(0, 0, 0, 0.55);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}
.heatmap-cell--weekend { opacity: 0.65; }
.heatmap-cell[data-level="-1"] { background: transparent; }
/* Пустой выходной — нейтральный, не «проблема». Выходной с часами — приглушённый факт. */
.heatmap-cell--weekend[data-level="0"] { background: var(--heatmap-neutral); opacity: 1; }
.heatmap-cell--weekend[data-level="1"],
.heatmap-cell--weekend[data-level="2"],
.heatmap-cell--weekend[data-level="3"],
.heatmap-cell--weekend[data-level="4"] { background: var(--heatmap-weekend-fill); opacity: 1; }
/* Праздничный будний день — отдельный акцентный цвет, отличный от обычных Сб/Вс. */
.heatmap-cell--holiday { opacity: 1; }
.heatmap-cell--holiday[data-level="0"] { background: var(--heatmap-holiday, #f6cf6b); }
.heatmap-cell--holiday[data-level="1"],
.heatmap-cell--holiday[data-level="2"],
.heatmap-cell--holiday[data-level="3"],
.heatmap-cell--holiday[data-level="4"] { background: var(--heatmap-holiday-fill, #f0b429); color: #4a3400; }
.heatmap-cell[data-level="0"]  { background: var(--heatmap-0); }
.heatmap-cell[data-level="1"]  { background: var(--heatmap-1); }
.heatmap-cell[data-level="2"]  { background: var(--heatmap-2); }
.heatmap-cell[data-level="3"]  { background: var(--heatmap-3); }
.heatmap-cell[data-level="4"]  { background: var(--heatmap-4); }
.heatmap-cell:hover { opacity: 0.75; }
.heatmap-cell--clickable { cursor: pointer; }
.heatmap-cell--clickable:hover { outline: 1.5px solid var(--primary); outline-offset: 1px; opacity: 1; }

/* Правая часть заголовка: легенда + кнопка обновить */
.heatmap-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.heatmap-refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted, var(--muted));
  background: transparent;
  border: 1px solid var(--border, rgba(0,0,0,0.12));
  border-radius: 4px;
  padding: 0.2rem 0.55rem;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.heatmap-refresh-btn:hover:not(:disabled) {
  color: var(--primary, #01696f);
  border-color: var(--primary, #01696f);
  background: color-mix(in srgb, var(--primary, #01696f) 6%, transparent);
}

.heatmap-refresh-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 3px;
}
.legend-label {
  font-size: 0.7rem;
  color: var(--muted);
  padding: 0 0.25rem;
}
.legend-cell {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
.legend-cell[data-level="0"] { background: var(--heatmap-0); }
.legend-cell[data-level="1"] { background: var(--heatmap-1); }
.legend-cell[data-level="2"] { background: var(--heatmap-2); }
.legend-cell[data-level="3"] { background: var(--heatmap-3); }
.legend-cell[data-level="4"] { background: var(--heatmap-4); }

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.spin {
  animation: spin 1s linear infinite;
  display: inline-block;
}
</style>
