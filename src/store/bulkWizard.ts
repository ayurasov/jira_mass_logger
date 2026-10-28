import { defineStore } from 'pinia';
import { tauriApi, type BulkResultItem, type CachedWorklogRow, type IssueDto, type JiraConnectionParams, type RecentIssue, type TextTemplate, type WizardTemplate } from '../lib/tauriApi';
import { DATE_RANGE_PRESETS, DEFAULT_WEEKDAY_FILTER, WEEKDAY_RU_SHORT, buildWorkingDates, toIsoDate, type WeekdayFilter } from '../utils/dateRange';
import { getIsoWeek, renderWorklogText } from '../utils/worklogText';
import { useSettingsStore } from './settings';
import { getTimezoneOffsetMs } from '../utils/time';
import { useDayFromCalendarStore } from './dayFromCalendar';
import { firstFreeStart, hhmmToMinutes, minutesToHHMM, startMinutesOf } from '../utils/dayComposer';

const WEEKDAY_KEYS: (keyof WeekdayFilter)[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Фильтр дней недели и норма часов — из рабочего графика в настройках. */
function scheduleDefaults(): { weekdayFilter: WeekdayFilter; hoursPerDay: number } {
  const settings = useSettingsStore();
  const days = settings.workdays?.length ? settings.workdays : [1, 2, 3, 4, 5];
  const weekdayFilter = Object.fromEntries(WEEKDAY_KEYS.map((k, i) => [k, days.includes(i)])) as unknown as WeekdayFilter;
  return { weekdayFilter, hoursPerDay: settings.workdayHours || 8 };
}

export interface IssueOption { key: string; summary?: string | null; source: 'recent' | 'search'; isFavorite?: boolean; }
export interface PreviewRow {
  id: string; date: string; weekday: string; hours: number; description: string; startedAt: string; issueKey: string; conflict: boolean;
  skipped?: boolean; status?: 'pending' | 'success' | 'error' | 'retry'; error?: string | null;
  /** Уже залогировано в этот день (все задачи), ч. */
  dayHours?: number;
  /** Пояснение к строке: урезано до нормы, день заполнен, время сдвинуто. */
  note?: string;
}

/** Не дальше этого периода подтягиваем свежие данные дней из Jira перед предпросмотром. */
const MAX_REFRESH_DAYS = 92;
export interface BulkWizardConfigSnapshot { issueKey: string; issueSummary?: string | null; periodFrom: string; periodTo: string; presetId: string; weekdayFilter: WeekdayFilter; excludeHolidays: boolean; hoursPerDay: number; descriptionTemplate: string; startTime: string; fillToNorm?: boolean; }
let searchTimer: number | null = null;
/** resolve отложенного поиска: при новом вводе предыдущий await должен завершиться, а не висеть. */
let searchResolve: (() => void) | null = null;

/** Собирает Jira-строку started из даты+времени, как они буквально введены пользователем
 *  (локальное время в таймзоне из настроек), без двойного сдвига:
 *  часы/минуты из timeHHMM подставляются в итоовую строку как есть (09:00 → "09:00"),
 *  а сама таймзона только поставляется рядом как offset (+HH:MM), без пересчёта самого времени.
 *  Раньше тут была ошибка: введённое время сначала трактовалось как UTC, а потом к нему
 *  ещё раз добавлялся сдвиг таймзоны, из-за чего 09:00 в параметрах становилось 12:00 в предпросмотре (при MSK, UTC+3). */
function toJiraStartedLocal(dateIso: string, timeHHMM: string, timezone: string): string {
  const [year, month, day] = dateIso.split('-').map(Number);
  const [hours, minutes] = timeHHMM.split(':').map(Number);
  // Приблизительная метка для расчёта смещения таймзоны на эту дату (DST учитывается корректно,
  // т.к. offset считается для конкретного календарного дня, а не "сейчас").
  const approxUtcForOffset = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1, hours ?? 0, minutes ?? 0, 0));
  const offsetMs = getTimezoneOffsetMs(approxUtcForOffset, timezone);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const sign = offsetMs >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMs) / 60000;
  const hh = pad(Math.floor(absMin / 60));
  const mm = pad(absMin % 60);
  return (
    `${pad(year, 4)}-${pad(month ?? 1)}-${pad(day ?? 1)}` +
    `T${pad(hours ?? 0)}:${pad(minutes ?? 0)}:00.000` +
    `${sign}${hh}${mm}`
  );
}

/** То же самое, но принимает значение поля <input type="datetime-local"> ("YYYY-MM-DDTHH:mm") —
 *  используется при ручной правке времени старта строки в предпросмотре (Шаг 4). */
function datetimeLocalToJiraStarted(value: string, timezone: string): string {
  const [datePart, timePart] = value.split('T');
  return toJiraStartedLocal(datePart, (timePart ?? '00:00').slice(0, 5), timezone);
}

/** Похоже ли на ключ задачи Jira (ABC-123) — тогда ищем точным JQL key=, иначе полнотекстовый text ~. */
function isIssueKeyLike(query: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(query.trim());
}

export const useBulkWizardStore = defineStore('bulkWizard', {
  state: () => ({
    step: 1, totalSteps: 4, loading: false, query: '', issueKey: '', issueSummary: '', recentIssues: [] as RecentIssue[], issueOptions: [] as IssueOption[],
    selectedPresetId: 'this_week', periodFrom: DATE_RANGE_PRESETS[0].range().from, periodTo: DATE_RANGE_PRESETS[0].range().to,
    weekdayFilter: { ...DEFAULT_WEEKDAY_FILTER } as WeekdayFilter, excludeHolidays: true, holidays: [] as string[],
    hoursPerDay: 8, descriptionTemplate: 'Работа по задаче {issue} за {date}',
    /** Не превышать норму дня: учитывать уже залогированное и не накладываться на него по времени. */
    fillToNorm: true,
    // Реальные шаблоны описаний (страница "Шаблоны", text_templates в БД) — раньше здесь был
    // статичный захардкоженный список, никак не связанный с тем, что пользователь сохраняет
    // на странице "Шаблоны", из-за чего шаблоны выглядели «неиспользуемыми».
    textTemplates: [] as TextTemplate[],
    startTime: '09:00',
    previewRows: [] as PreviewRow[], existingWorklogs: [] as { startedDate: string; issueKey: string }[], sending: false, results: [] as BulkResultItem[], templates: [] as WizardTemplate[], statusLogLines: [] as string[],
  }),
  getters: {
    progressPercent(state): number { return Math.round((state.step / state.totalSteps) * 100); },
    totalHours(state): number { return state.previewRows.filter((row) => !row.skipped).reduce((sum, row) => sum + row.hours, 0); },
    conflictsCount(state): number { return state.previewRows.filter((row) => row.conflict && !row.skipped).length; },
  },
  actions: {
    applyPreset(presetId: string) { const preset = DATE_RANGE_PRESETS.find((p) => p.id === presetId); if (!preset) return; const range = preset.range(); this.selectedPresetId = presetId; this.periodFrom = range.from; this.periodTo = range.to; },
    async bootstrap() {
      this.templates = await tauriApi.listWizardTemplates().catch(() => []);
      this.recentIssues = await tauriApi.getRecentIssues().catch(() => []);
      this.textTemplates = await tauriApi.listTemplates().catch(() => []);
      const custom = await tauriApi.getCustomHolidays().catch(() => []);
      if (custom.length > 0) this.holidays = custom;
      // Значения по умолчанию — из рабочего графика, пока пользователь ничего не начал вводить.
      if (this.step === 1 && !this.issueKey && this.previewRows.length === 0) {
        const defaults = scheduleDefaults();
        this.weekdayFilter = defaults.weekdayFilter;
        this.hoursPerDay = defaults.hoursPerDay;
      }
      this.issueOptions = this.recentIssues.map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent', isFavorite: item.isFavorite }));
    },
    /** Применяет сохранённый шаблон описания (страница "Шаблоны") к текущему мастеру:
     *  подставляет текст и, если в шаблоне указана задача, выбирает её тоже. */
    async applyTextTemplate(tpl: TextTemplate) {
      this.descriptionTemplate = tpl.text;
      if (tpl.issueKey && !this.issueKey) {
        this.selectIssue({ key: tpl.issueKey, summary: null, source: 'recent' });
      }
      if (tpl.id) {
        await tauriApi.incrementTemplateUsage(tpl.id).catch(() => undefined);
        this.textTemplates = await tauriApi.listTemplates().catch(() => this.textTemplates);
      }
    },
    async searchIssues(params: JiraConnectionParams, query: string) {
      this.query = query; if (searchTimer) window.clearTimeout(searchTimer); searchResolve?.(); searchResolve = null; if (!query.trim()) { this.loading = false; this.issueOptions = this.recentIssues.map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent', isFavorite: item.isFavorite })); return; }
      this.loading = true;
      await new Promise<void>((resolve) => {
        searchResolve = resolve;
        searchTimer = window.setTimeout(async () => {
          searchResolve = null;
          try {
            const trimmed = query.trim();
            // Экранируем сначала обратный слеш, затем кавычки — иначе «\» ломал JQL.
            const safeQuery = trimmed.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
            // Если запрос похож на ключ задачи (ABC-123) — точный поиск по key=,
            // иначе обычный полнотекстовый поиск по text (как в календарном логгере).
            const jql = isIssueKeyLike(trimmed)
              ? `key = "${trimmed.toUpperCase()}" ORDER BY updated DESC`
              : `text ~ "${safeQuery}*" ORDER BY updated DESC`;
            const found = await tauriApi.getIssuesByJql(params, jql);
            const mergedRecent = this.recentIssues.filter((item) => item.issueKey.toLowerCase().includes(query.toLowerCase()) || item.summary?.toLowerCase().includes(query.toLowerCase())).map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent' as const, isFavorite: item.isFavorite }));
            const seen = new Set<string>(); const searchOptions: IssueOption[] = [];
            for (const row of [...mergedRecent, ...found.map((issue: IssueDto) => ({ key: issue.key, summary: issue.summary, source: 'search' as const }))]) {
              if (!seen.has(row.key)) { seen.add(row.key); searchOptions.push(row); }
            }
            if (this.query === query) this.issueOptions = searchOptions;
          } catch {
            // Ошибка Jira при поиске — оставляем последние варианты, не роняем UI.
          } finally { this.loading = false; resolve(); }
        }, 300);
      });
    },
    selectIssue(option: IssueOption | string) {
      if (typeof option === 'string') {
        const text = option.trim();
        if (!text) { this.issueKey = ''; this.issueSummary = ''; return; }
        // Ключ ищем без учёта регистра (ссылка, «abc-123»). Произвольный текст поиска
        // ключом не считаем — иначе по blur в issueKey попадал бы сам запрос.
        const match = text.toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/);
        if (match && match[0] !== this.issueKey) { this.issueKey = match[0]; this.issueSummary = ''; }
        return;
      } this.issueKey = option.key; this.issueSummary = option.summary ?? ''; },
    async generatePreview(params: JiraConnectionParams) {
      if (!this.issueKey || !this.periodFrom || !this.periodTo) return; this.loading = true;
      try {
        const settings = useSettingsStore();
        // Праздники: производственный календарь из настроек (с учётом правок пользователя)
        // + импортированный пользователем список.
        const holidays = [...settings.holidays.map((h) => h.date), ...this.holidays];
        const workingDates = buildWorkingDates(this.periodFrom, this.periodTo, this.weekdayFilter, this.excludeHolidays, holidays);
        // Конфликт — только свои записи в этот день: чужие worklog в общих задачах (стендапы,
        // поддержка) раньше помечали почти каждый день и маскировали настоящие дубли.
        const existing = await tauriApi.getMyWorklogsForIssue(params, this.issueKey).catch(() => []);
        this.existingWorklogs = existing.map((item) => ({ startedDate: item.started.slice(0, 10), issueKey: this.issueKey }));
        const existingSet = new Set(this.existingWorklogs.map((item) => `${item.issueKey}|${item.startedDate}`));

        // Уже залогированное по дням (все задачи) — чтобы не превысить норму и не наложиться по времени.
        // Свежие данные периода из Jira (best-effort, только для разумного периода), затем кэш.
        const byDay = new Map<string, CachedWorklogRow[]>();
        if (this.fillToNorm) {
          const days = Math.round((Date.parse(this.periodTo) - Date.parse(this.periodFrom)) / 86_400_000) + 1;
          if (days <= MAX_REFRESH_DAYS) await useDayFromCalendarStore().refreshRangeFromJira(this.periodFrom, this.periodTo).catch(() => {});
          const cached = await tauriApi.listCachedWorklogs(this.periodFrom, this.periodTo).catch(() => [] as CachedWorklogRow[]);
          for (const w of cached) {
            const d = w.started.slice(0, 10);
            byDay.set(d, [...(byDay.get(d) ?? []), w]);
          }
        }
        const norm = settings.workdayHours || 8;
        const preferred = hhmmToMinutes(this.startTime);

        this.previewRows = workingDates.map((date) => {
          const dateIso = toIsoDate(date); const week = getIsoWeek(dateIso); const description = renderWorklogText(this.descriptionTemplate, { date: dateIso, week, issue: this.issueKey });
          const dayRows = byDay.get(dateIso) ?? [];
          const dayHours = Math.round(dayRows.reduce((s, w) => s + w.timeSpentSeconds, 0) / 36) / 100;
          let hours = this.hoursPerDay;
          let start = preferred;
          const notes: string[] = [];
          let skipped = false;
          if (this.fillToNorm) {
            const left = Math.round((norm - dayHours) * 4) / 4; // кратно 15 мин
            if (left <= 0) { skipped = true; notes.push(`день уже заполнен (${dayHours} ч)`); }
            else if (left < hours) { hours = left; notes.push(`до нормы: уже ${dayHours} ч`); }
            if (!skipped && dayRows.length) {
              const busy = dayRows.map((w) => ({ start: startMinutesOf(w.started), end: startMinutesOf(w.started) + Math.round(w.timeSpentSeconds / 60) }));
              start = firstFreeStart(busy, preferred, Math.round(hours * 60));
              if (start !== preferred) notes.push(`начало ${minutesToHHMM(start)} — после уже залогированного`);
            }
          }
          const startedAt = toJiraStartedLocal(dateIso, minutesToHHMM(start), settings.timezone);
          return {
            id: `${this.issueKey}-${dateIso}`, date: dateIso, weekday: WEEKDAY_RU_SHORT[date.getDay()], hours, description, startedAt, issueKey: this.issueKey,
            conflict: existingSet.has(`${this.issueKey}|${dateIso}`), status: 'pending' as const, skipped, dayHours, note: notes.join('; ') || undefined,
          };
        });
      } finally { this.loading = false; }
    },
    updatePreviewRow(id: string, patch: Partial<PreviewRow>) { const row = this.previewRows.find((item) => item.id === id); if (row) Object.assign(row, patch); },
    /** Правка времени старта строки предпросмотра из <input type="datetime-local">:
     *  собирает Jira-строку из введённого локального времени как есть (без пересчёта в UTC),
     *  добавляя только смещение таймзоны как offset. */
    setPreviewRowStartedAtLocal(id: string, datetimeLocalValue: string) {
      const row = this.previewRows.find((item) => item.id === id);
      if (!row || !datetimeLocalValue) return;
      const settings = useSettingsStore();
      row.startedAt = datetimeLocalToJiraStarted(datetimeLocalValue, settings.timezone);
    },
    removePreviewRow(id: string) { const row = this.previewRows.find((item) => item.id === id); if (row) row.skipped = true; },
    restorePreviewRow(id: string) { const row = this.previewRows.find((item) => item.id === id); if (row) row.skipped = false; },
    async submit(params: JiraConnectionParams) {
      this.sending = true; this.statusLogLines = [];
      try {
        // Уже успешно отправленные строки повторно не шлём — иначе повтор после
        // частичной ошибки создавал бы дубли в Jira.
        const toSend = this.previewRows.filter((row) => !row.skipped && row.status !== 'success');
        const entries = toSend.map((row) => ({ issueKey: row.issueKey, startedAt: row.startedAt, timeSpentSeconds: Math.round(row.hours * 3600), comment: row.description }));
        this.results = await tauriApi.bulkAddWorklogs(params, entries);
                for (let i = 0; i < this.results.length; i++) {
          const result = this.results[i]; const row = toSend[i]; if (!row) continue;
          row.status = result.success ? 'success' : (result.attempts > 1 ? 'retry' : 'error'); row.error = result.error;
          // Созданное сразу в локальный кэш — дашборд, «Мой worklog» и «Собрать день» видят его без синхронизации.
          if (result.success) {
            const e = entries[i];
            await tauriApi.upsertCachedWorklog({
              rowKey: result.worklogId ? `wl:${result.worklogId}` : `local:${e.issueKey}:${e.startedAt}`,
              worklogId: result.worklogId ?? null, issueKey: e.issueKey, issueSummary: this.issueSummary || null,
              projectKey: e.issueKey.split('-')[0] ?? null, started: e.startedAt, timeSpentSeconds: e.timeSpentSeconds,
              comment: e.comment ?? null, updated: null, syncedAt: new Date().toISOString(),
            }).catch(() => undefined);
          }
          this.statusLogLines.push(`${row.date} | ${row.issueKey} | ${result.success ? 'Успех' : 'Ошибка'} | попыток: ${result.attempts}${result.error ? ` | ${result.error}` : ''}`);
        }
        await tauriApi.touchRecentIssue(this.issueKey, this.issueSummary || undefined).catch(() => undefined);
      } finally { this.sending = false; }
    },
    async saveCurrentAsTemplate(name: string) { const snapshot: BulkWizardConfigSnapshot = { issueKey: this.issueKey, issueSummary: this.issueSummary, periodFrom: this.periodFrom, periodTo: this.periodTo, presetId: this.selectedPresetId, weekdayFilter: this.weekdayFilter, excludeHolidays: this.excludeHolidays, hoursPerDay: this.hoursPerDay, descriptionTemplate: this.descriptionTemplate, startTime: this.startTime, fillToNorm: this.fillToNorm }; await tauriApi.saveWizardTemplate(name, JSON.stringify(snapshot)); this.templates = await tauriApi.listWizardTemplates(); },
    applyTemplate(template: WizardTemplate) { const parsed = JSON.parse(template.configJson) as BulkWizardConfigSnapshot; this.issueKey = parsed.issueKey; this.issueSummary = parsed.issueSummary ?? ''; this.periodFrom = parsed.periodFrom; this.periodTo = parsed.periodTo; this.selectedPresetId = parsed.presetId; this.weekdayFilter = parsed.weekdayFilter; this.excludeHolidays = parsed.excludeHolidays; this.hoursPerDay = parsed.hoursPerDay; this.descriptionTemplate = parsed.descriptionTemplate; this.startTime = parsed.startTime; this.fillToNorm = parsed.fillToNorm ?? true; },
    buildExportLog(): string { const header = ['JiraTime — экспорт лога операции Bulk Log Wizard', `Задача: ${this.issueKey}${this.issueSummary ? ` — ${this.issueSummary}` : ''}`, `Период: ${this.periodFrom} .. ${this.periodTo}`, `Всего часов: ${this.totalHours}`, `Конфликтов: ${this.conflictsCount}`, '', 'Построчный статус:']; return [...header, ...this.statusLogLines].join('\n'); },
    nextStep() { if (this.step < this.totalSteps) this.step += 1; }, prevStep() { if (this.step > 1) this.step -= 1; }, goToStep(step: number) { this.step = Math.max(1, Math.min(this.totalSteps, step)); },
    /** "Новая сессия": полный сброс мастера к начальным значениям для заполнения с нуля,
     *  не трогая справочники (recentIssues/templates/textTemplates/holidays уже загружены). */
    resetWizard() {
      this.step = 1;
      this.query = '';
      this.issueKey = '';
      this.issueSummary = '';
      this.issueOptions = this.recentIssues.map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent', isFavorite: item.isFavorite }));
      this.selectedPresetId = 'this_week';
      const range = DATE_RANGE_PRESETS[0].range();
      this.periodFrom = range.from;
      this.periodTo = range.to;
      const defaults = scheduleDefaults();
      this.weekdayFilter = defaults.weekdayFilter;
      this.excludeHolidays = true;
      this.hoursPerDay = defaults.hoursPerDay;
      this.descriptionTemplate = 'Работа по задаче {issue} за {date}';
      this.startTime = '09:00';
      this.fillToNorm = true;
      this.previewRows = [];
      this.existingWorklogs = [];
      this.sending = false;
      this.results = [];
      this.statusLogLines = [];
    },
  },
});
