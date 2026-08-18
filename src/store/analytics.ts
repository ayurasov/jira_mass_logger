// Pinia-стор аналитики дашборда.
// Агрегирует данные из кэша worklog'ов и вычисляет метрики для 5 виджетов:
//  1. Диаграмма часов по дням за текущую/прошлую неделю (план vs факт)
//  2. Разбивка по задачам/проектам за выбранный период (donut / stacked bar)
//  3. Calendar heatmap за последние 3 месяца
//  4. Список дней с недозаполненным worklog в текущем месяце
//  5. Метрика «экономия времени» через bulk-мастер
import { defineStore } from 'pinia';
import { tauriApi, type CachedWorklogRow } from '../lib/tauriApi';
import { useSettingsStore } from './settings';

// ────────────────────────────────────────────
// Утилиты дат
// ────────────────────────────────────────────
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date, weekStartsMonday = true): Date {
  const day = d.getDay();
  const diff = weekStartsMonday ? (day === 0 ? -6 : 1 - day) : -day;
  const result = new Date(d);
  result.setDate(d.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function weekDates(monday: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => toIsoDate(addDays(monday, i)));
}

function isWorkday(date: string): boolean {
  const day = new Date(date).getDay();
  return day !== 0 && day !== 6;
}

// ────────────────────────────────────────────
// Типы
// ────────────────────────────────────────────
export interface DayBar {
  date: string;   // YYYY-MM-DD
  label: string;  // «Пн», «Вт» …
  plan: number;   // норма часов (0 для вых.)
  fact: number;   // фактические часы
}

export interface ProjectSlice {
  key: string;   // projectKey или issueKey
  label: string;
  hours: number;
}

export interface HeatmapCell {
  date: string;  // YYYY-MM-DD
  hours: number;
  level: 0 | 1 | 2 | 3 | 4; // 0 = пусто/выходной, 1..4 = заполнение
}

export interface MissingDay {
  date: string;
  hours: number;   // фактические (может быть 0)
  deficit: number; // сколько не хватает
}

export interface BulkSavingMetric {
  totalBulkEntries: number;
  estimatedManualMinutes: number; // ~2 мин на ручной ввод каждой записи
  bulkMinutes: number;            // ~0.2 мин (bulk-мастер)
  savedMinutes: number;
}

// Уровни заполнения heatmap
function toLevel(hours: number, isWD: boolean): 0 | 1 | 2 | 3 | 4 {
  if (!isWD) return 0;
  if (hours <= 0) return 0;
  if (hours < 4) return 1;
  if (hours < 6) return 2;
  if (hours < 8) return 3;
  return 4;
}

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// ────────────────────────────────────────────
// Store
// ────────────────────────────────────────────
export const useAnalyticsStore = defineStore('analytics', {
  state: () => ({
    loading: false,
    // raw rows за последние 3 месяца + текущий месяц
    _rows: [] as CachedWorklogRow[],

    // период для «разбивки по проектам» (управляется из UI)
    breakdownFrom: '' as string,
    breakdownTo: '' as string,
    breakdownMode: 'project' as 'project' | 'issue',

    // статистика bulk-мастера из localStorage
    bulkEntriesCreated: 0,
  }),

  getters: {
    // ── Виджет 1: текущая и прошлая неделя ──────────────────────────
    currentWeekBars(): DayBar[] {
      return this._weekBars(startOfWeek(new Date()));
    },
    prevWeekBars(): DayBar[] {
      return this._weekBars(addDays(startOfWeek(new Date()), -7));
    },

    // ── Виджет 2: разбивка за выбранный период ────────────────────────
    breakdownSlices(): ProjectSlice[] {
      const from = this.breakdownFrom || toIsoDate(addDays(new Date(), -30));
      const to   = this.breakdownTo   || toIsoDate(new Date());
      const map = new Map<string, { label: string; hours: number }>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (d < from || d > to) continue;
        const key = this.breakdownMode === 'project'
          ? (r.projectKey || r.issueKey.split('-')[0] || '?')
          : r.issueKey;
        const label = this.breakdownMode === 'project'
          ? (r.projectKey || r.issueKey.split('-')[0] || '?')
          : `${r.issueKey}${r.issueSummary ? ' ' + r.issueSummary.slice(0, 40) : ''}`;
        const h = (r.timeSpentSeconds ?? 0) / 3600;
        const prev = map.get(key) ?? { label, hours: 0 };
        map.set(key, { label, hours: prev.hours + h });
      }
      return Array.from(map.entries())
        .map(([key, v]) => ({ key, label: v.label, hours: Math.round(v.hours * 100) / 100 }))
        .sort((a, b) => b.hours - a.hours);
    },

    // ── Виджет 3: heatmap за 3 месяца ────────────────────────────────
    heatmapCells(): HeatmapCell[] {
      const today = new Date();
      const start = addDays(today, -90);
      const hoursByDate = new Map<string, number>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (d < toIsoDate(start) || d > toIsoDate(today)) continue;
        hoursByDate.set(d, (hoursByDate.get(d) ?? 0) + (r.timeSpentSeconds ?? 0) / 3600);
      }
      const cells: HeatmapCell[] = [];
      for (let i = 0; i <= 90; i++) {
        const d = toIsoDate(addDays(start, i));
        const h = hoursByDate.get(d) ?? 0;
        const wd = isWorkday(d);
        cells.push({ date: d, hours: Math.round(h * 100) / 100, level: toLevel(h, wd) });
      }
      return cells;
    },

    // ── Виджет 4: дни с недозаполненным worklog в текущем месяце ─────
    missingDays(): MissingDay[] {
      const settings = useSettingsStore();
      const norm = settings.workHoursPerDay ?? 8;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const today = toIsoDate(now);

      const hoursByDate = new Map<string, number>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (d < toIsoDate(monthStart) || d > today) continue;
        hoursByDate.set(d, (hoursByDate.get(d) ?? 0) + (r.timeSpentSeconds ?? 0) / 3600);
      }

      const result: MissingDay[] = [];
      for (let d = new Date(monthStart); toIsoDate(d) <= today; d = addDays(d, 1)) {
        const dateStr = toIsoDate(d);
        if (!isWorkday(dateStr)) continue;
        const hours = hoursByDate.get(dateStr) ?? 0;
        if (hours < norm - 0.01) {
          result.push({ date: dateStr, hours: Math.round(hours * 100) / 100, deficit: Math.round((norm - hours) * 100) / 100 });
        }
      }
      return result.sort((a, b) => a.date.localeCompare(b.date));
    },

    // ── Виджет 5: метрика экономии через bulk-мастер ─────────────────
    bulkSavingMetric(): BulkSavingMetric {
      const n = this.bulkEntriesCreated;
      const manualMins = n * 2.0;
      const bulkMins   = n * 0.2;
      return {
        totalBulkEntries: n,
        estimatedManualMinutes: manualMins,
        bulkMinutes: bulkMins,
        savedMinutes: Math.round(manualMins - bulkMins),
      };
    },
  },

  actions: {
    // внутренний вычислитель баров недели
    _weekBars(monday: Date): DayBar[] {
      const settings = useSettingsStore();
      const norm = settings.workHoursPerDay ?? 8;
      const dates = weekDates(monday);
      const hoursByDate = new Map<string, number>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (dates.includes(d)) {
          hoursByDate.set(d, (hoursByDate.get(d) ?? 0) + (r.timeSpentSeconds ?? 0) / 3600);
        }
      }
      return dates.map((date) => {
        const wd = isWorkday(date);
        const dayOfWeek = new Date(date).getDay();
        return {
          date,
          label: DAY_LABELS[dayOfWeek],
          plan: wd ? norm : 0,
          fact: Math.round((hoursByDate.get(date) ?? 0) * 100) / 100,
        };
      });
    },

    async loadData() {
      this.loading = true;
      try {
        const today = new Date();
        const from = toIsoDate(addDays(today, -95));
        const to   = toIsoDate(today);
        this._rows = await tauriApi.listCachedWorklogs(from, to);
        // читаем счётчик bulk-записей из localStorage
        this.bulkEntriesCreated = Number(localStorage.getItem('jiratime-bulk-entries-created') ?? '0');
      } finally {
        this.loading = false;
      }
    },

    /** Вызывается из BulkLogWizard после каждого успешного создания записей */
    trackBulkEntries(count: number) {
      this.bulkEntriesCreated += count;
      localStorage.setItem('jiratime-bulk-entries-created', String(this.bulkEntriesCreated));
    },

    setBreakdownPeriod(from: string, to: string) {
      this.breakdownFrom = from;
      this.breakdownTo   = to;
    },

    setBreakdownMode(mode: 'project' | 'issue') {
      this.breakdownMode = mode;
    },
  },
});
