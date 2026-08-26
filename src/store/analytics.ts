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
// ВАЖНО: используем локальные компоненты даты, а не toISOString() —
// toISOString() конвертирует в UTC, и для часовых поясов восточнее UTC
// (например, MSK, UTC+3) локальная полночь понедельника превращалась
// в 21:00 предыдущего дня по UTC, из-за чего вся неделя съезжала
// на день назад (понедельник показывался как предыдущее воскресенье).
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

// Парсим 'YYYY-MM-DD' как ЛОКАЛЬНУЮ дату (не через new Date(str), которая
// трактует такую строку как UTC-полночь и может сдвинуть день недели
// в часовых поясах западнее UTC).
function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isWorkday(date: string): boolean {
  const day = parseIsoLocal(date).getDay();
  if (day === 0 || day === 6) return false;
  const settings = useSettingsStore();
  return !settings.isHoliday(date);
}

// ────────────────────────────────────────────
// Типы
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

export interface BulkSavingMetricData {
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

// Вычислитель баров недели (вынесен из стора, так как вызывается из getters,
// где `this._weekBars(...)` как вызов action из getter не типизируется Pinia'ой).
function computeWeekBars(rows: CachedWorklogRow[], monday: Date): DayBar[] {
  const settings = useSettingsStore();
  const norm = settings.workHoursPerDay ?? 8;
  const dates = weekDates(monday);
  const hoursByDate = new Map<string, number>();
  for (const r of rows) {
    const d = r.started.slice(0, 10);
    if (dates.includes(d)) {
      hoursByDate.set(d, (hoursByDate.get(d) ?? 0) + (r.timeSpentSeconds ?? 0) / 3600);
    }
  }
  return dates.map((date) => {
    const wd = isWorkday(date);
    const dayOfWeek = parseIsoLocal(date).getDay();
    return {
      date,
      label: DAY_LABELS[dayOfWeek],
      plan: wd ? norm : 0,
      fact: Math.round((hoursByDate.get(date) ?? 0) * 100) / 100,
    };
  });
}

// ────────────────────────────────────────────
// Store
export const useAnalyticsStore = defineStore('analytics', {
  state: () => ({
    loading: false,
    error: null as string | null,
    lastFetched: null as number | null,
    // raw rows за последние 3 месяца + текущий месяц
    _rows: [] as CachedWorklogRow[],

    // период для «разбивки по проектам» (управляется из UI)
    breakdownFrom: '' as string,
    breakdownTo: '' as string,
    breakdownMode: 'project' as 'project' | 'issue',

    // статистика bulk-мастера из localStorage
    bulkEntriesCreated: 0,

    // map projectKey → projectName, для подписей в разбивке по проектам
    _projectNames: new Map<string, string>(),

    // флаг и статус синхронизации с Jira
    syncing: false,
    syncError: null as string | null,
    lastSynced: null as number | null,
  }),

  getters: {
    // ── Виджет 1: текущая и прошлая неделя ────────────────────
    currentWeekBars(): DayBar[] {
      return computeWeekBars(this._rows, startOfWeek(new Date()));
    },
    prevWeekBars(): DayBar[] {
      return computeWeekBars(this._rows, addDays(startOfWeek(new Date()), -7));
    },

    // ── Виджет 2: разбивка за выбранный период ─────────────────
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
          ? (this._projectNames.get(key) || r.projectKey || r.issueKey.split('-')[0] || '?')
          : `${r.issueKey}${r.issueSummary ? ' — ' + r.issueSummary.slice(0, 50) : ''}`;
        const h = (r.timeSpentSeconds ?? 0) / 3600;
        const prev = map.get(key) ?? { label, hours: 0 };
        map.set(key, { label, hours: prev.hours + h });
      }
      return Array.from(map.entries())
        .map(([key, v]) => ({ key, label: v.label, hours: Math.round(v.hours * 100) / 100 }))
        .sort((a, b) => b.hours - a.hours);
    },

    // ── Виджет «Топ задач за период» (не зависит от режима разбивки) ───
    topIssues(): { issueKey: string; summary: string | null; hours: number }[] {
      const from = this.breakdownFrom || toIsoDate(addDays(new Date(), -30));
      const to = this.breakdownTo || toIsoDate(new Date());
      const m = new Map<string, { summary: string | null; hours: number }>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (d < from || d > to) continue;
        const prev = m.get(r.issueKey) ?? { summary: r.issueSummary ?? null, hours: 0 };
        prev.hours += (r.timeSpentSeconds ?? 0) / 3600;
        if (!prev.summary && r.issueSummary) prev.summary = r.issueSummary;
        m.set(r.issueKey, prev);
      }
      return Array.from(m.entries())
        .map(([issueKey, v]) => ({ issueKey, summary: v.summary, hours: Math.round(v.hours * 100) / 100 }))
        .sort((a, b) => b.hours - a.hours)
        .slice(0, 5);
    },

    // ── Виджет 3: heatmap за ~3 месяца, только полными неделями ─────
    // Диапазон: от понедельника недели, начавшейся ~3 месяца назад, до
    // воскресенья текущей (уже идущей) недели — включая её ещё не
    // прошедший «остаток». Это гарантирует, что в гриде нет обрезанных
    // недель/месяцев и окраска месяца строится по видимой части.
    heatmapCells(): HeatmapCell[] {
      const today = new Date();
      const rangeStart = startOfWeek(addDays(today, -90));
      const rangeEnd = addDays(startOfWeek(today), 6); // воскресенье текущей недели
      const hoursByDate = new Map<string, number>();
      for (const r of this._rows) {
        const d = r.started.slice(0, 10);
        if (d < toIsoDate(rangeStart) || d > toIsoDate(rangeEnd)) continue;
        hoursByDate.set(d, (hoursByDate.get(d) ?? 0) + (r.timeSpentSeconds ?? 0) / 3600);
      }
      const cells: HeatmapCell[] = [];
      const totalDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000);
      const todayIso = toIsoDate(today);
      for (let i = 0; i <= totalDays; i++) {
        const d = toIsoDate(addDays(rangeStart, i));
        if (d > todayIso) break; // не показываем будущие дни ещё не начавшейся части недели
        const h = hoursByDate.get(d) ?? 0;
        const wd = isWorkday(d);
        cells.push({ date: d, hours: Math.round(h * 100) / 100, level: toLevel(h, wd) });
      }
      return cells;
    },

    // ── Виджет 4: дни с недозаполненным worklog в текущем месяце ───
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

    // ── Виджет 5: метрика экономии через bulk-мастер ───────────
    bulkSavingMetric(): BulkSavingMetricData {
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
    async fetchAll() {
      this.loading = true;
      this.error = null;
      try {
        const today = new Date();
        const from = toIsoDate(addDays(today, -95));
        const to   = toIsoDate(today);
        this._rows = await tauriApi.listCachedWorklogs(from, to);
        this.bulkEntriesCreated = Number(localStorage.getItem('jiratime-bulk-entries-created') ?? '0');
        // Названия проектов для разбивки (best-effort: не блокируем дашборд при ошибке).
        try {
          const profiles = (await import('./jiraProfiles')).useJiraProfilesStore();
          await profiles.ensureLoaded();
          const params = profiles.activeConnectionParams;
          if (params) {
            const projects = await tauriApi.getProjects(params);
            const m = new Map<string, string>();
            for (const p of projects) m.set(p.key, p.name);
            this._projectNames = m;
          }
        } catch { /* Jira недоступен — подписи будут просто ключами проектов */ }
        this.lastFetched = Date.now();
      } catch (e) {
        this.error = e instanceof Error ? e.message : 'Не удалось загрузить данные';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Запрашивает у Jira worklogs за последние 3 месяца, сохраняет в локальный
     * кэш, затем перечитывает кэш (`fetchAll`) — дашборд обновляется со свежими данными.
     *
     * @param force  true → всегда синхронизировать; false (по умолчанию) →
     *               пропустить если уже синхронизировали в этом сеансе (lastSynced != null).
     */
    async syncFromJira(force = false) {
      // Избегаем повторного запроса при навигации назад/вперёд по дашборду,
      // если данные уже были подгружены в текущем сеансе.
      if (!force && this.lastSynced !== null) return;

      this.syncing = true;
      this.syncError = null;
      try {
        const profiles = (await import('./jiraProfiles')).useJiraProfilesStore();
        await profiles.ensureLoaded();
        const params = profiles.activeConnectionParams;
        if (!params) {
          // Jira не настроена — тихо выходим, дашборд покажет кэш
          return;
        }

        const today = new Date();
        const from = toIsoDate(addDays(today, -95)); // ~3 месяца с запасом
        const to   = toIsoDate(today);

        // Получаем worklogs из Jira за нужный диапазон.
        // sinceEpochMillis = 0 означает «без ограничения по дате изменения»,
        // dateRange ограничивает диапазон полей started у worklog'а.
        const rawWorklogs = await tauriApi.getWorklogsSince(
          params,
          0,
          undefined,
          { dateFrom: from, dateTo: to },
          true, // allowEmptyRange
        );

        // Конвертируем WorklogDto → CachedWorklogRow и заменяем диапазон в кэше.
        const rows: CachedWorklogRow[] = rawWorklogs.map((w) => ({
          rowKey: `jira:${w.id}`,
          worklogId: w.id,
          issueKey: w.issueKey ?? '',
          issueSummary: null,
          projectKey: w.issueKey ? w.issueKey.split('-')[0] : null,
          started: w.started.slice(0, 10),
          timeSpentSeconds: w.timeSpentSeconds,
          comment: w.comment ?? null,
          updated: w.updated ?? null,
          syncedAt: new Date().toISOString(),
        }));

        await tauriApi.replaceCachedWorklogsRange(from, to, rows);
        this.lastSynced = Date.now();
      } catch (e) {
        // Ошибка синхронизации не блокирует дашборд — просто запоминаем
        this.syncError = e instanceof Error ? e.message : 'Ошибка синхронизации с Jira';
      } finally {
        this.syncing = false;
        // Перечитываем кэш независимо от результата синхронизации
        await this.fetchAll();
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
