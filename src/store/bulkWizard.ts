import { defineStore } from 'pinia';
import { tauriApi, type BulkResultItem, type IssueDto, type JiraConnectionParams, type RecentIssue, type WizardTemplate } from '../lib/tauriApi';
import { DATE_RANGE_PRESETS, DEFAULT_WEEKDAY_FILTER, RU_HOLIDAYS_FALLBACK_2026, WEEKDAY_RU_SHORT, buildWorkingDates, toIsoDate, type WeekdayFilter } from '../utils/dateRange';
import { getIsoWeek, renderWorklogText } from '../utils/worklogText';

export interface IssueOption { key: string; summary?: string | null; source: 'recent' | 'search'; isFavorite?: boolean; }
export interface PreviewRow { id: string; date: string; weekday: string; hours: number; description: string; startedAt: string; issueKey: string; conflict: boolean; skipped?: boolean; status?: 'pending' | 'success' | 'error' | 'retry'; error?: string | null; }
export interface BulkWizardConfigSnapshot { issueKey: string; issueSummary?: string | null; periodFrom: string; periodTo: string; presetId: string; weekdayFilter: WeekdayFilter; excludeHolidays: boolean; hoursPerDay: number; descriptionTemplate: string; startTime: string; }
let searchTimer: number | null = null;

export const useBulkWizardStore = defineStore('bulkWizard', {
  state: () => ({
    step: 1, totalSteps: 4, loading: false, query: '', issueKey: '', issueSummary: '', recentIssues: [] as RecentIssue[], issueOptions: [] as IssueOption[],
    selectedPresetId: 'this_week', periodFrom: DATE_RANGE_PRESETS[0].range().from, periodTo: DATE_RANGE_PRESETS[0].range().to,
    weekdayFilter: { ...DEFAULT_WEEKDAY_FILTER } as WeekdayFilter, excludeHolidays: true, holidays: [...RU_HOLIDAYS_FALLBACK_2026] as string[],
    hoursPerDay: 8, descriptionTemplate: 'Работа по задаче {issue} за {date}', savedTextTemplates: ['Работа по задаче {issue} за {date}','Плановые работы по {issue}, неделя {week}','Разработка/поддержка {issue} ({date})'] as string[], startTime: '09:00',
    previewRows: [] as PreviewRow[], existingWorklogs: [] as { startedDate: string; issueKey: string }[], sending: false, results: [] as BulkResultItem[], templates: [] as WizardTemplate[], statusLogLines: [] as string[],
  }),
  getters: {
    progressPercent(state): number { return Math.round((state.step / state.totalSteps) * 100); },
    totalHours(state): number { return state.previewRows.filter((row) => !row.skipped).reduce((sum, row) => sum + row.hours, 0); },
    conflictsCount(state): number { return state.previewRows.filter((row) => row.conflict && !row.skipped).length; },
  },
  actions: {
    applyPreset(presetId: string) { const preset = DATE_RANGE_PRESETS.find((p) => p.id === presetId); if (!preset) return; const range = preset.range(); this.selectedPresetId = presetId; this.periodFrom = range.from; this.periodTo = range.to; },
    async bootstrap() { this.templates = await tauriApi.listWizardTemplates().catch(() => []); this.recentIssues = await tauriApi.getRecentIssues().catch(() => []); const custom = await tauriApi.getCustomHolidays().catch(() => []); if (custom.length > 0) this.holidays = custom; this.issueOptions = this.recentIssues.map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent', isFavorite: item.isFavorite })); },
    async searchIssues(params: JiraConnectionParams, query: string) {
      this.query = query; if (searchTimer) window.clearTimeout(searchTimer); if (!query.trim()) { this.issueOptions = this.recentIssues.map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent', isFavorite: item.isFavorite })); return; }
      this.loading = true;
      await new Promise<void>((resolve) => {
        searchTimer = window.setTimeout(async () => {
          try {
            const safeQuery = query.replaceAll('"', '\\"');
            const jql = `text ~ "${safeQuery}*" ORDER BY updated DESC`;
            const found = await tauriApi.getIssuesByJql(params, jql);
            const mergedRecent = this.recentIssues.filter((item) => item.issueKey.toLowerCase().includes(query.toLowerCase()) || item.summary?.toLowerCase().includes(query.toLowerCase())).map((item) => ({ key: item.issueKey, summary: item.summary, source: 'recent' as const, isFavorite: item.isFavorite }));
            const seen = new Set<string>(); const searchOptions: IssueOption[] = [];
            for (const row of [...mergedRecent, ...found.map((issue: IssueDto) => ({ key: issue.key, summary: issue.summary, source: 'search' as const }))]) {
              if (!seen.has(row.key)) { seen.add(row.key); searchOptions.push(row); }
            }
            this.issueOptions = searchOptions;
          } finally { this.loading = false; resolve(); }
        }, 300);
      });
    },
    selectIssue(option: IssueOption | string) { if (typeof option === 'string') { const match = option.match(/[A-Z][A-Z0-9_]+-\d+/); this.issueKey = match?.[0] ?? option.trim().toUpperCase(); this.issueSummary = ''; return; } this.issueKey = option.key; this.issueSummary = option.summary ?? ''; },
    async generatePreview(params: JiraConnectionParams) {
      if (!this.issueKey || !this.periodFrom || !this.periodTo) return; this.loading = true;
      try {
        const workingDates = buildWorkingDates(this.periodFrom, this.periodTo, this.weekdayFilter, this.excludeHolidays, this.holidays);
        const existing = await tauriApi.getWorklog(params, this.issueKey).catch(() => []);
        this.existingWorklogs = existing.map((item) => ({ startedDate: item.started.slice(0, 10), issueKey: this.issueKey }));
        const existingSet = new Set(this.existingWorklogs.map((item) => `${item.issueKey}|${item.startedDate}`));
        this.previewRows = workingDates.map((date) => {
          const dateIso = toIsoDate(date); const week = getIsoWeek(dateIso); const description = renderWorklogText(this.descriptionTemplate, { date: dateIso, week, issue: this.issueKey }); const startedAt = `${dateIso}T${this.startTime}:00.000Z`;
          return { id: `${this.issueKey}-${dateIso}`, date: dateIso, weekday: WEEKDAY_RU_SHORT[date.getDay()], hours: this.hoursPerDay, description, startedAt, issueKey: this.issueKey, conflict: existingSet.has(`${this.issueKey}|${dateIso}`), status: 'pending' as const, skipped: false };
        });
      } finally { this.loading = false; }
    },
    updatePreviewRow(id: string, patch: Partial<PreviewRow>) { const row = this.previewRows.find((item) => item.id === id); if (row) Object.assign(row, patch); },
    removePreviewRow(id: string) { const row = this.previewRows.find((item) => item.id === id); if (row) row.skipped = true; },
    restorePreviewRow(id: string) { const row = this.previewRows.find((item) => item.id === id); if (row) row.skipped = false; },
    async submit(params: JiraConnectionParams) {
      this.sending = true; this.statusLogLines = [];
      try {
        const entries = this.previewRows.filter((row) => !row.skipped).map((row) => ({ issueKey: row.issueKey, startedAt: row.startedAt, timeSpentSeconds: Math.round(row.hours * 3600), comment: row.description }));
        this.results = await tauriApi.bulkAddWorklogs(params, entries);
        let successCount = 0;
        for (let i = 0; i < this.results.length; i++) {
          const result = this.results[i]; const row = this.previewRows.filter((r) => !r.skipped)[i]; if (!row) continue;
          row.status = result.success ? 'success' : (result.attempts > 1 ? 'retry' : 'error'); row.error = result.error;
          if (result.success) successCount++;
          this.statusLogLines.push(`${row.date} | ${row.issueKey} | ${result.success ? 'Успех' : 'Ошибка'} | попыток: ${result.attempts}${result.error ? ` | ${result.error}` : ''}`);
        }
        // ─── Трекинг bulk-метрики (виджет 5 дашборда) ───
        if (successCount > 0) {
          const prev = Number(localStorage.getItem('jiratime-bulk-entries-created') ?? '0');
          localStorage.setItem('jiratime-bulk-entries-created', String(prev + successCount));
        }
        await tauriApi.touchRecentIssue(this.issueKey, this.issueSummary || undefined).catch(() => undefined);
      } finally { this.sending = false; }
    },
    async saveCurrentAsTemplate(name: string) { const snapshot: BulkWizardConfigSnapshot = { issueKey: this.issueKey, issueSummary: this.issueSummary, periodFrom: this.periodFrom, periodTo: this.periodTo, presetId: this.selectedPresetId, weekdayFilter: this.weekdayFilter, excludeHolidays: this.excludeHolidays, hoursPerDay: this.hoursPerDay, descriptionTemplate: this.descriptionTemplate, startTime: this.startTime }; await tauriApi.saveWizardTemplate(name, JSON.stringify(snapshot)); this.templates = await tauriApi.listWizardTemplates(); },
    applyTemplate(template: WizardTemplate) { const parsed = JSON.parse(template.configJson) as BulkWizardConfigSnapshot; this.issueKey = parsed.issueKey; this.issueSummary = parsed.issueSummary ?? ''; this.periodFrom = parsed.periodFrom; this.periodTo = parsed.periodTo; this.selectedPresetId = parsed.presetId; this.weekdayFilter = parsed.weekdayFilter; this.excludeHolidays = parsed.excludeHolidays; this.hoursPerDay = parsed.hoursPerDay; this.descriptionTemplate = parsed.descriptionTemplate; this.startTime = parsed.startTime; },
    buildExportLog(): string { const header = ['JiraTime — экспорт лога операции Bulk Log Wizard', `Задача: ${this.issueKey}${this.issueSummary ? ` — ${this.issueSummary}` : ''}`, `Период: ${this.periodFrom} .. ${this.periodTo}`, `Всего часов: ${this.totalHours}`, `Конфликтов: ${this.conflictsCount}`, '', 'Построчный статус:']; return [...header, ...this.statusLogLines].join('\n'); },
    nextStep() { if (this.step < this.totalSteps) this.step += 1; }, prevStep() { if (this.step > 1) this.step -= 1; }, goToStep(step: number) { this.step = Math.max(1, Math.min(this.totalSteps, step)); },
  },
});
