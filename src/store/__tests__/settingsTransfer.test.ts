// Перенос настроек: файл без секретов, импорт без дублей, подключения — к добавлению.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeBackend, type FakeBackend } from '../../test/fakeBackend';

const h = vi.hoisted(() => ({
  backend: null as null | { invoke: (cmd: string, args?: any) => Promise<unknown> },
  savePath: '/home/ivan/JiraTime-настройки.json' as string | null,
  openPath: '/home/ivan/JiraTime-настройки.json' as string | null,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: any) => h.backend!.invoke(cmd, args) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.12' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: async () => h.savePath, open: async () => h.openPath }));

import { useSettingsTransferStore, loadPending } from '../settingsTransfer';
import { parseSettingsFile, planImport, summarize, SECTION_PREF_KEYS, type SectionId, type SettingsFile } from '../../utils/settingsTransfer';

const ALL = new Set<SectionId>(Object.keys(SECTION_PREF_KEYS) as SectionId[]);
let backend: FakeBackend;

/** «Старый компьютер»: настройки, шаблоны, правила, избранное, подключения с секретами. */
function oldComputer() {
  backend = createFakeBackend();
  h.backend = backend;
  localStorage.clear();
  localStorage.setItem('jiratime-work-schedule', JSON.stringify({ workdayHours: 7, workdays: [1, 2, 3, 4], timezone: 'Asia/Yekaterinburg' }));
  localStorage.setItem('jiratime-digest-prefs', JSON.stringify({ savedJql: [{ id: 'q1', name: 'Мои', jql: 'assignee = currentUser()' }] }));
  localStorage.setItem('jiratime-teams', JSON.stringify([{ id: 't1', name: 'Бэкенд', members: [] }]));
  localStorage.setItem('jiratime-favorite-tasks', JSON.stringify([{ issueKey: 'SRM-101', issueSummary: 'API' }]));
  localStorage.setItem('jiratime-theme', 'dark');
  localStorage.setItem('jiratime-bitrix', JSON.stringify({ enabled: true, user: { id: '17', name: 'Иван', portal: 'https://corp.bitrix24.ru' }, role: 'auditor', status: 'all' }));
  // Временное — не переносится.
  localStorage.setItem('jiratime-worklog-filters', JSON.stringify({ issueKey: 'X' }));
  localStorage.setItem('jiratime-calendar-date', '2026-10-01');
  backend.state.exchangeProfiles = [{ id: 1, name: 'Почта', authMode: 'ews', ewsUrl: 'https://mail.corp.ru/EWS/Exchange.asmx', ewsAuthType: 'ntlm', username: 'CORP\\ivan', secretRef: 'exchange_CORP\\ivan', isActive: true }];
  backend.state.textTemplates = [{ id: 1, name: 'Разработка', text: 'Работа по {issue}', issueKey: null, isPinned: true }];
  backend.state.wizardTemplates = [{ id: 1, name: 'Неделя SRM', configJson: '{"issueKey":"SRM-1"}' }];
  backend.state.meetingRules = [{ id: 1, name: 'Стендап', kind: 'keyword', pattern: 'daily', issueKey: 'OPS-12', priority: 10, isActive: true }];
  backend.state.customHolidays = ['2026-12-31'];
  backend.state.recentIssues = [{ issueKey: 'SRM-101', summary: 'API', isFavorite: true, lastUsedAt: '' }, { issueKey: 'X-1', summary: null, isFavorite: false, lastUsedAt: '' }];
  backend.state.scheduler = { ...backend.state.scheduler, reminderEnabled: true, reminderTime: '18:15' };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.savePath = '/home/ivan/JiraTime-настройки.json';
  h.openPath = '/home/ivan/JiraTime-настройки.json';
});

describe('экспорт', () => {
  it('собирает настройки без паролей, токенов и временных данных', async () => {
    oldComputer();
    const path = await useSettingsTransferStore().exportToFile();
    expect(path).toBe(h.savePath);
    const text = backend.state.files[path!];
    const file = JSON.parse(text) as SettingsFile;

    expect(file).toMatchObject({ format: 'jiratime-settings', version: 1, appVersion: '1.0.12' });
    expect(Object.keys(file.prefs).sort()).toEqual([
      'jiratime-digest-prefs', 'jiratime-favorite-tasks', 'jiratime-teams', 'jiratime-theme', 'jiratime-work-schedule',
    ]);
    expect(file.bitrix).toEqual({ role: 'auditor', status: 'all' });
    expect(file.jiraProfiles).toEqual([{ name: 'Test Jira', instanceType: 'server', authType: 'pat', baseUrl: 'https://jira.example.com', email: 'ivan', isActive: true, acceptInvalidCerts: false }]);
    expect(file.favoriteIssues).toEqual([{ issueKey: 'SRM-101', summary: 'API' }]);
    expect(file.customHolidays).toEqual(['2026-12-31']);
    // Ни ссылок на секреты, ни данных пользователя Битрикс24, ни временного.
    expect(text).not.toMatch(/secretRef|jira-1|exchange_CORP|corp\.bitrix24|worklog-filters|calendar-date/);
  });

  it('пользователь закрыл диалог — файл не пишется', async () => {
    oldComputer();
    h.savePath = null;
    expect(await useSettingsTransferStore().exportToFile()).toBeNull();
    expect(Object.keys(backend.state.files)).toEqual([]);
  });
});

describe('импорт на другом компьютере', () => {
  async function exportedFile(): Promise<string> {
    oldComputer();
    const path = await useSettingsTransferStore().exportToFile();
    return backend.state.files[path!];
  }

  /** «Новый компьютер»: пустое приложение, файл лежит на диске. */
  function newComputer(text: string) {
    backend = createFakeBackend();
    backend.state.jiraProfiles = [];
    backend.state.files[h.openPath!] = text;
    h.backend = backend;
    localStorage.clear();
    setActivePinia(createPinia());
  }

  it('переносит всё, а подключения предлагает добавить', async () => {
    newComputer(await exportedFile());
    const store = useSettingsTransferStore();
    const file = (await store.pickFile())!;
    const lines = await store.apply(file, ALL);

    expect(JSON.parse(localStorage.getItem('jiratime-work-schedule')!).workdayHours).toBe(7);
    expect(localStorage.getItem('jiratime-theme')).toBe('dark');
    expect(JSON.parse(localStorage.getItem('jiratime-bitrix')!)).toEqual({ role: 'auditor', status: 'all' });
    expect(backend.state.textTemplates.map((t) => t.name)).toEqual(['Разработка']);
    expect(backend.state.wizardTemplates.map((t) => t.name)).toEqual(['Неделя SRM']);
    expect(backend.state.meetingRules.map((r) => r.pattern)).toEqual(['daily']);
    expect(backend.state.customHolidays).toEqual(['2026-12-31']);
    expect(backend.state.recentIssues).toMatchObject([{ issueKey: 'SRM-101', isFavorite: true }]);
    expect(backend.state.scheduler).toMatchObject({ reminderEnabled: true, reminderTime: '18:15' });
    // Профили без токена не создаются — ждут пароля/токена.
    expect(backend.state.jiraProfiles).toEqual([]);
    expect(loadPending().jira.map((p) => p.baseUrl)).toEqual(['https://jira.example.com']);
    expect(loadPending().exchange.map((p) => p.username)).toEqual(['CORP\\ivan']);
    expect(lines).toContain('подключения к добавлению: 2');
  });

  it('повторный импорт не создаёт дублей', async () => {
    newComputer(await exportedFile());
    const store = useSettingsTransferStore();
    const file = (await store.pickFile())!;
    await store.apply(file, ALL);
    await store.apply(file, ALL);
    expect(backend.state.textTemplates).toHaveLength(1);
    expect(backend.state.wizardTemplates).toHaveLength(1);
    expect(backend.state.meetingRules).toHaveLength(1);
    expect(loadPending().jira).toHaveLength(1);
  });

  it('только выбранные разделы', async () => {
    newComputer(await exportedFile());
    const store = useSettingsTransferStore();
    await store.apply((await store.pickFile())!, new Set<SectionId>(['templates']));
    expect(backend.state.textTemplates).toHaveLength(1);
    expect(localStorage.getItem('jiratime-work-schedule')).toBeNull();
    expect(backend.state.meetingRules).toHaveLength(0);
    expect(loadPending().jira).toHaveLength(0);
  });

  it('добавленное подключение уходит из списка ожидающих', async () => {
    newComputer(await exportedFile());
    const store = useSettingsTransferStore();
    await store.apply((await store.pickFile())!, ALL);
    store.resolveJira('https://jira.example.com/', 'ivan');
    expect(store.pending.jira).toEqual([]);
    store.dismissPending('exchange', 0);
    expect(loadPending()).toEqual({ jira: [], exchange: [] });
    expect(localStorage.getItem('jiratime-pending-connections')).toBeNull();
  });
});

describe('разбор файла', () => {
  it('понятные ошибки для чужого, битого и более нового файла', () => {
    expect(() => parseSettingsFile('не json')).toThrow('Файл повреждён');
    expect(() => parseSettingsFile('{"a":1}')).toThrow('Это не файл настроек JiraTime.');
    expect(() => parseSettingsFile('{"format":"jiratime-settings","version":99}')).toThrow('более новой версией');
  });

  it('в localStorage попадают только известные ключи-строки', () => {
    const f = parseSettingsFile(JSON.stringify({
      format: 'jiratime-settings', version: 1,
      prefs: { 'jiratime-theme': 'dark', 'jiratime-license': 'hack', evil: 'x', 'jiratime-teams': 42 },
      customHolidays: ['2026-12-31', 'завтра'],
    }));
    expect(f.prefs).toEqual({ 'jiratime-theme': 'dark' });
    expect(f.customHolidays).toEqual(['2026-12-31']);
  });

  it('сводка по разделам и план без дублей', () => {
    const file = parseSettingsFile(JSON.stringify({
      format: 'jiratime-settings', version: 1, prefs: { 'jiratime-teams': '[{"id":"t1"},{"id":"t2"}]' },
      textTemplates: [{ name: 'A', text: 'x', isPinned: false }, { name: 'B', text: 'y', isPinned: false }],
      jiraProfiles: [{ name: 'J', instanceType: 'cloud', authType: 'token', baseUrl: 'https://a.atlassian.net', email: 'me@a.ru', isActive: true, acceptInvalidCerts: false }],
      customHolidays: ['2026-12-31'],
    }));
    const s = Object.fromEntries(summarize(file).map((x) => [x.id, x]));
    expect(s.teams.detail).toBe('2 команды');
    expect(s.templates.detail).toBe('2 шаблона описания, 0 шаблонов мастера');
    expect(s.rules.empty).toBe(true);

    const plan = planImport(file, {
      textTemplates: [{ name: 'a', text: 'X', issueKey: null, isPinned: false }], wizardTemplateNames: [], meetingRules: [],
      customHolidays: ['2026-12-31'], favoriteIssueKeys: [], jiraProfiles: [{ baseUrl: 'https://A.atlassian.net/', email: 'ME@a.ru' }], exchangeProfiles: [],
    }, ALL);
    expect(plan.textTemplates.map((t) => t.name)).toEqual(['B']);
    expect(plan.pendingJira).toEqual([]);
    expect(plan.customHolidays).toBeNull();
  });
});

describe('итог импорта', () => {
  it('перечисляет разделы человеческими словами', async () => {
    const { describePlan } = await import('../../utils/settingsTransfer');
    const lines = describePlan({
      prefs: { 'jiratime-work-schedule': '{}', 'jiratime-teams': '[]' }, bitrix: null, textTemplates: [{ name: 'a', text: 'b', issueKey: null, isPinned: false }],
      wizardTemplates: [], meetingRules: [], customHolidays: null, favoriteIssues: [], scheduler: { autoSyncEnabled: true, syncIntervalMinutes: 15, reminderEnabled: true, reminderTime: '17:30', reminderWorkdaysOnly: true, dailyHoursNorm: 8 },
      pendingJira: [], pendingExchange: [],
    });
    expect(lines).toEqual(['рабочий график и праздники', 'команды', 'шаблоны: +1', 'напоминание и автосинхронизация']);
  });
});
