// Поддельный бэкенд для тестов сторов: Jira и локальный кэш worklog в памяти.
// Подключается через vi.mock('@tauri-apps/api/core') — сторы работают с ним так же,
// как с настоящими командами Tauri (list_cached_worklogs, bulk_add_worklogs, …).
import type { CachedWorklogRow } from '../lib/tauriApi';

export interface JiraWorklog {
  id: string;
  issueKey: string;
  issueSummary?: string | null;
  /** Jira started: "2026-11-09T09:00:00.000+0300". */
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
}

export interface FakeBackendOptions {
  /** Задачи, по которым Jira отвечает ошибкой при создании записи. */
  failIssues?: string[];
}

type Args = Record<string, any>;

export function createFakeBackend(seed: JiraWorklog[] = [], opts: FakeBackendOptions = {}) {
  let nextId = 1000;
  const state = {
    jira: [...seed] as JiraWorklog[],
    cache: [] as CachedWorklogRow[],
    calls: [] as { cmd: string; args: Args }[],
    failIssues: new Set(opts.failIssues ?? []),
    jiraProfiles: [{
      id: 1, name: 'Test Jira', instanceType: 'server', authType: 'pat', baseUrl: 'https://jira.example.com',
      email: 'ivan', secretRef: 'jira-1', isActive: true, acceptInvalidCerts: false,
    }] as Args[],
    exchangeProfiles: [] as Args[],
    textTemplates: [] as Args[],
    wizardTemplates: [] as Args[],
    meetingRules: [] as Args[],
    customHolidays: [] as string[],
    recentIssues: [] as Args[],
    scheduler: { autoSyncEnabled: true, syncIntervalMinutes: 15, reminderEnabled: false, reminderTime: '17:30', reminderWorkdaysOnly: true, dailyHoursNorm: 8 } as Args,
    /** «Файловая система» для диалогов сохранения/открытия. */
    files: {} as Record<string, string>,
    secrets: {} as Record<string, string>,
  };
  const day = (s: string) => s.slice(0, 10);
  const inRange = (s: string, from: string, to: string) => day(s) >= from && day(s) <= to;
  const toRow = (w: JiraWorklog): CachedWorklogRow => ({
    rowKey: `wl:${w.id}`, worklogId: w.id, issueKey: w.issueKey, issueSummary: w.issueSummary ?? null,
    projectKey: w.issueKey.split('-')[0], started: w.started, timeSpentSeconds: w.timeSpentSeconds,
    comment: w.comment ?? null, updated: null, syncedAt: null,
  });

  const handlers: Record<string, (a: Args) => unknown> = {
    list_jira_profiles: () => state.jiraProfiles.map((p) => ({ ...p })),
    list_exchange_profiles: () => state.exchangeProfiles.map((p) => ({ ...p })),
    list_templates: () => state.textTemplates.map((t) => ({ ...t })),
    save_template: (a) => { state.textTemplates.push({ ...a.template, id: state.textTemplates.length + 1 }); return state.textTemplates.length; },
    list_wizard_templates: () => state.wizardTemplates.map((t) => ({ ...t })),
    save_wizard_template: (a) => { state.wizardTemplates.push({ id: state.wizardTemplates.length + 1, name: a.name, configJson: a.configJson }); return state.wizardTemplates.length; },
    list_meeting_match_rules: () => state.meetingRules.map((r) => ({ ...r })),
    save_meeting_match_rule: (a) => { state.meetingRules.push({ ...a.rule, id: state.meetingRules.length + 1 }); return state.meetingRules.length; },
    get_custom_holidays: () => [...state.customHolidays],
    import_holidays: (a) => {
      if (!Array.isArray(a.dates)) throw new Error('invalid args: missing dates');
      state.customHolidays = [...a.dates];
      return a.dates.length;
    },
    get_recent_issues: () => state.recentIssues.map((r) => ({ ...r })),
    touch_recent_issue: (a) => {
      if (!state.recentIssues.some((r) => r.issueKey === a.issueKey)) state.recentIssues.push({ issueKey: a.issueKey, summary: a.summary ?? null, isFavorite: false, lastUsedAt: '' });
    },
    set_issue_favorite: (a) => { const r = state.recentIssues.find((x) => x.issueKey === a.issueKey); if (r) r.isFavorite = a.isFavorite; },
    get_scheduler_settings: () => ({ ...state.scheduler }),
    save_scheduler_settings: (a) => { state.scheduler = { ...a.settings }; },
    write_export_file: (a) => { state.files[a.path] = a.content; },
    read_text_file: (a) => {
      if (!(a.path in state.files)) throw new Error('Не удалось открыть файл: not found');
      return state.files[a.path];
    },
    get_meeting_issue_history: () => [],
    get_worklogs_since: (a) => state.jira
      .filter((w) => !a.dateRange || inRange(w.started, a.dateRange.dateFrom, a.dateRange.dateTo))
      .map((w) => ({ id: w.id, issueKey: w.issueKey, issueSummary: w.issueSummary, started: w.started, timeSpentSeconds: w.timeSpentSeconds, comment: w.comment, updated: null })),
    replace_cached_worklogs_range: (a) => {
      state.cache = [...state.cache.filter((r) => !inRange(r.started, a.fromDate, a.toDate)), ...a.rows];
    },
    list_cached_worklogs: (a) => state.cache.filter((r) => inRange(r.started, a.fromDate, a.toDate)).map((r) => ({ ...r })),
    upsert_cached_worklog: (a) => {
      state.cache = [...state.cache.filter((r) => r.rowKey !== a.row.rowKey), { ...a.row }];
    },
    delete_cached_worklog: (a) => { state.cache = state.cache.filter((r) => r.rowKey !== a.rowKey); },
    bulk_add_worklogs: (a) => a.entries.map((e: Args) => {
      if (state.failIssues.has(e.issueKey)) return { issueKey: e.issueKey, success: false, worklogId: null, error: 'Issue does not exist', attempts: 1 };
      const id = String(++nextId);
      state.jira.push({ id, issueKey: e.issueKey, started: e.startedAt, timeSpentSeconds: e.timeSpentSeconds, comment: e.comment });
      return { issueKey: e.issueKey, success: true, worklogId: id, error: null, attempts: 1 };
    }),
    delete_worklog: (a) => {
      const before = state.jira.length;
      state.jira = state.jira.filter((w) => !(w.id === a.worklogId && w.issueKey === a.issueKey));
      if (state.jira.length === before) throw new Error('Worklog not found');
    },
    get_my_worklogs_for_issue: (a) => state.jira.filter((w) => w.issueKey === a.issueKey).map((w) => ({ id: w.id, started: w.started, timeSpentSeconds: w.timeSpentSeconds })),
  };

  return {
    state,
    /** Все записи Jira за день, минут. */
    minutesOn(date: string): number {
      return Math.round(state.jira.filter((w) => day(w.started) === date).reduce((s, w) => s + w.timeSpentSeconds, 0) / 60);
    },
    jiraOn(date: string): JiraWorklog[] {
      return state.jira.filter((w) => day(w.started) === date).sort((a, b) => a.started.localeCompare(b.started));
    },
    /** Заполняет кэш из «Jira», как это делает синхронизация. */
    syncCache() { state.cache = state.jira.map(toRow); },
    async invoke(cmd: string, args: Args = {}): Promise<unknown> {
      state.calls.push({ cmd, args });
      const h = handlers[cmd];
      return h ? h(args) : undefined;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

/** История привычной работы: рабочие дни периода, одна и та же раскладка. */
export function seedHistory(dates: string[], tz = '+0300'): JiraWorklog[] {
  const out: JiraWorklog[] = [];
  let id = 1;
  dates.forEach((d, i) => {
    out.push({ id: String(id++), issueKey: 'SRM-101', issueSummary: 'Разработка API', started: `${d}T09:00:00.000${tz}`, timeSpentSeconds: 4 * 3600, comment: 'Разработка API' });
    out.push({ id: String(id++), issueKey: 'OPS-12', issueSummary: 'Совещания', started: `${d}T14:00:00.000${tz}`, timeSpentSeconds: 2 * 3600, comment: 'Планирование' });
    // Документация — через день: «привычная», но реже.
    if (i % 2 === 0) out.push({ id: String(id++), issueKey: 'DOC-7', issueSummary: 'Документация', started: `${d}T16:00:00.000${tz}`, timeSpentSeconds: 2 * 3600, comment: 'Документация' });
    else out.push({ id: String(id++), issueKey: 'SRM-204', issueSummary: 'Код-ревью', started: `${d}T16:00:00.000${tz}`, timeSpentSeconds: 2 * 3600, comment: 'Ревью' });
  });
  return out;
}
