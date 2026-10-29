// Перенос настроек между компьютерами: файл JSON без паролей и токенов.
// Модуль чистый — сборка файла, разбор, сводка по разделам и план импорта без дублей;
// чтение/запись данных приложения — в store/settingsTransfer.ts.
import type { MeetingMatchRule, SchedulerSettings, TextTemplate } from '../lib/tauriApi';

export const SETTINGS_FILE_FORMAT = 'jiratime-settings';
export const SETTINGS_FILE_VERSION = 1;

/** Подключение к Jira без токена/пароля. */
export interface TransferJiraProfile {
  name: string;
  instanceType: string;
  authType: string | null;
  baseUrl: string;
  email: string;
  isActive: boolean;
  acceptInvalidCerts: boolean;
}

/** Подключение к Exchange/Outlook без пароля и OAuth-токенов. */
export interface TransferExchangeProfile {
  name: string;
  authMode: string;
  ewsUrl: string | null;
  ewsAuthType: string | null;
  username: string;
  tenantId: string | null;
  clientId: string | null;
  minEventMinutes: number;
  excludeFreeBusy: boolean;
  excludeDeclined: boolean;
  isActive: boolean;
}

export type TransferTemplate = Pick<TextTemplate, 'name' | 'text' | 'issueKey' | 'isPinned'>;
export type TransferRule = Omit<MeetingMatchRule, 'id'>;

export interface SettingsFile {
  format: typeof SETTINGS_FILE_FORMAT;
  version: number;
  exportedAt: string;
  appVersion: string;
  /** Сырые значения localStorage по ключам из TRANSFER_PREF_KEYS. */
  prefs: Record<string, string>;
  /** Битрикс24: только фильтры — вебхук хранится в системном хранилище и не переносится. */
  bitrix: { role?: string; status?: string } | null;
  jiraProfiles: TransferJiraProfile[];
  exchangeProfiles: TransferExchangeProfile[];
  textTemplates: TransferTemplate[];
  wizardTemplates: { name: string; configJson: string }[];
  meetingRules: TransferRule[];
  customHolidays: string[];
  favoriteIssues: { issueKey: string; summary: string | null }[];
  scheduler: SchedulerSettings | null;
}

export type SectionId = 'schedule' | 'templates' | 'rules' | 'favorites' | 'teams' | 'screens' | 'connections';

/** Ключи localStorage по разделам. Временные данные (фильтры, даты, кэш, счётчики) не переносятся. */
export const SECTION_PREF_KEYS: Record<SectionId, string[]> = {
  schedule: ['jiratime-work-schedule', 'jiratime-holidays-overrides'],
  templates: [],
  rules: [],
  favorites: ['jiratime-favorite-tasks', 'jiratime-favorite-tasks-dismissed'],
  teams: ['jiratime-teams', 'jiratime-team-active', 'jiratime-team-period'],
  screens: [
    'jiratime-compose-prefs', 'jiratime-digest-prefs', 'jiratime-theme', 'jiratime-sidebar-collapsed',
    'jiratime-rounding-step', 'jiratime-auto-sync-enabled', 'jiratime-auto-sync-interval',
  ],
  connections: [],
};
export const TRANSFER_PREF_KEYS = Object.values(SECTION_PREF_KEYS).flat();

export const SECTION_TITLES: Record<SectionId, string> = {
  schedule: 'Рабочий график, праздники и напоминание',
  templates: 'Шаблоны описаний и шаблоны мастера',
  rules: 'Правила «встреча → задача»',
  favorites: 'Избранные задачи',
  teams: 'Команды',
  screens: 'Параметры экранов: «Собрать день», дайджест и сохранённые JQL, тема',
  connections: 'Подключения Jira и Exchange (без паролей и токенов)',
};

export interface SectionSummary { id: SectionId; title: string; detail: string; empty: boolean }

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};

function parseJsonArray(raw: string | undefined): unknown[] {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Что есть в файле — по разделам, для предпросмотра импорта. */
export function summarize(file: SettingsFile): SectionSummary[] {
  const has = (keys: string[]) => keys.filter((k) => file.prefs[k] !== undefined).length;
  const teams = parseJsonArray(file.prefs['jiratime-teams']).length;
  const favs = Math.max(parseJsonArray(file.prefs['jiratime-favorite-tasks']).length, file.favoriteIssues.length);
  let savedJql = 0;
  try { savedJql = (JSON.parse(file.prefs['jiratime-digest-prefs'] ?? '{}').savedJql ?? []).length; } catch { /* битое значение */ }
  const items: [SectionId, string, boolean][] = [
    ['schedule', [
      has(SECTION_PREF_KEYS.schedule) ? 'норма и рабочие дни' : '',
      file.customHolidays.length ? plural(file.customHolidays.length, 'доп. выходной', 'доп. выходных', 'доп. выходных') : '',
      file.scheduler ? 'напоминание' : '',
    ].filter(Boolean).join(', '), !has(SECTION_PREF_KEYS.schedule) && !file.customHolidays.length && !file.scheduler],
    ['templates', `${plural(file.textTemplates.length, 'шаблон описания', 'шаблона описания', 'шаблонов описания')}, ${plural(file.wizardTemplates.length, 'шаблон мастера', 'шаблона мастера', 'шаблонов мастера')}`,
      !file.textTemplates.length && !file.wizardTemplates.length],
    ['rules', plural(file.meetingRules.length, 'правило', 'правила', 'правил'), !file.meetingRules.length],
    ['favorites', plural(favs, 'задача', 'задачи', 'задач'), !favs],
    ['teams', plural(teams, 'команда', 'команды', 'команд'), !teams],
    ['screens', [has(SECTION_PREF_KEYS.screens) ? 'параметры экранов' : '', savedJql ? plural(savedJql, 'сохранённый JQL', 'сохранённых JQL', 'сохранённых JQL') : ''].filter(Boolean).join(', '),
      !has(SECTION_PREF_KEYS.screens) && !file.bitrix],
    ['connections', `Jira: ${file.jiraProfiles.length}, Exchange: ${file.exchangeProfiles.length}`, !file.jiraProfiles.length && !file.exchangeProfiles.length],
  ];
  return items.map(([id, detail, empty]) => ({ id, title: SECTION_TITLES[id], detail: detail || 'нет данных', empty }));
}

/** Разбор файла с понятными ошибками. */
export function parseSettingsFile(text: string): SettingsFile {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('Файл повреждён или это не файл настроек JiraTime (не JSON).'); }
  if (!raw || raw.format !== SETTINGS_FILE_FORMAT) throw new Error('Это не файл настроек JiraTime.');
  if (typeof raw.version !== 'number' || raw.version > SETTINGS_FILE_VERSION) {
    throw new Error('Файл сохранён более новой версией JiraTime — обновите приложение и повторите импорт.');
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const prefs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.prefs ?? {})) {
    // Только известные ключи и только строки — в localStorage ничего постороннего не попадёт.
    if (TRANSFER_PREF_KEYS.includes(k) && typeof v === 'string') prefs[k] = v;
  }
  return {
    format: SETTINGS_FILE_FORMAT,
    version: raw.version,
    exportedAt: String(raw.exportedAt ?? ''),
    appVersion: String(raw.appVersion ?? ''),
    prefs,
    bitrix: raw.bitrix && typeof raw.bitrix === 'object' ? { role: raw.bitrix.role, status: raw.bitrix.status } : null,
    jiraProfiles: arr<TransferJiraProfile>(raw.jiraProfiles).filter((p) => p && p.baseUrl && p.name),
    exchangeProfiles: arr<TransferExchangeProfile>(raw.exchangeProfiles).filter((p) => p && p.username && p.name),
    textTemplates: arr<TransferTemplate>(raw.textTemplates).filter((t) => t && t.name && t.text),
    wizardTemplates: arr<{ name: string; configJson: string }>(raw.wizardTemplates).filter((t) => t && t.name && typeof t.configJson === 'string'),
    meetingRules: arr<TransferRule>(raw.meetingRules).filter((r) => r && r.pattern && r.issueKey),
    customHolidays: arr<string>(raw.customHolidays).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    favoriteIssues: arr<{ issueKey: string; summary: string | null }>(raw.favoriteIssues).filter((f) => f && f.issueKey),
    scheduler: raw.scheduler && typeof raw.scheduler === 'object' ? raw.scheduler as SchedulerSettings : null,
  };
}

/** Текущее состояние приложения — чтобы при импорте не создавать дублей. */
export interface CurrentState {
  textTemplates: TransferTemplate[];
  wizardTemplateNames: string[];
  meetingRules: TransferRule[];
  customHolidays: string[];
  favoriteIssueKeys: string[];
  jiraProfiles: { baseUrl: string; email: string }[];
  exchangeProfiles: { username: string; authMode: string }[];
}

export interface ImportPlan {
  prefs: Record<string, string>;
  bitrix: SettingsFile['bitrix'];
  textTemplates: TransferTemplate[];
  wizardTemplates: { name: string; configJson: string }[];
  meetingRules: TransferRule[];
  /** Итоговый список доп. выходных (объединение) или null — не менять. */
  customHolidays: string[] | null;
  favoriteIssues: { issueKey: string; summary: string | null }[];
  scheduler: SchedulerSettings | null;
  /** Подключения, которых ещё нет: их предложим добавить, введя только пароль/токен. */
  pendingJira: TransferJiraProfile[];
  pendingExchange: TransferExchangeProfile[];
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\/+$/, '');

export function planImport(file: SettingsFile, current: CurrentState, sections: Set<SectionId>): ImportPlan {
  const prefs: Record<string, string> = {};
  for (const id of sections) for (const k of SECTION_PREF_KEYS[id]) if (file.prefs[k] !== undefined) prefs[k] = file.prefs[k];

  const tplKey = (t: TransferTemplate) => `${norm(t.name)}|${norm(t.text)}`;
  const haveTpl = new Set(current.textTemplates.map(tplKey));
  const haveWizard = new Set(current.wizardTemplateNames.map(norm));
  const ruleKey = (r: TransferRule) => `${r.kind}|${norm(r.pattern)}|${norm(r.issueKey)}`;
  const haveRule = new Set(current.meetingRules.map(ruleKey));
  const haveFav = new Set(current.favoriteIssueKeys.map(norm));
  const haveJira = new Set(current.jiraProfiles.map((p) => `${norm(p.baseUrl)}|${norm(p.email)}`));
  const haveExch = new Set(current.exchangeProfiles.map((p) => `${p.authMode}|${norm(p.username)}`));

  const on = (id: SectionId) => sections.has(id);
  const holidays = on('schedule') && file.customHolidays.length
    ? [...new Set([...current.customHolidays, ...file.customHolidays])].sort()
    : null;
  return {
    prefs,
    bitrix: on('screens') ? file.bitrix : null,
    textTemplates: on('templates') ? file.textTemplates.filter((t) => !haveTpl.has(tplKey(t))) : [],
    wizardTemplates: on('templates') ? file.wizardTemplates.filter((t) => !haveWizard.has(norm(t.name))) : [],
    meetingRules: on('rules') ? file.meetingRules.filter((r) => !haveRule.has(ruleKey(r))) : [],
    customHolidays: holidays && holidays.length !== current.customHolidays.length ? holidays : null,
    favoriteIssues: on('favorites') ? file.favoriteIssues.filter((f) => !haveFav.has(norm(f.issueKey))) : [],
    scheduler: on('schedule') ? file.scheduler : null,
    pendingJira: on('connections') ? file.jiraProfiles.filter((p) => !haveJira.has(`${norm(p.baseUrl)}|${norm(p.email)}`)) : [],
    pendingExchange: on('connections') ? file.exchangeProfiles.filter((p) => !haveExch.has(`${p.authMode}|${norm(p.username)}`)) : [],
  };
}

/** Короткий отчёт об импорте для пользователя. */
const PREF_SECTION_LABELS: Partial<Record<SectionId, string>> = {
  schedule: 'рабочий график и праздники',
  favorites: 'избранные задачи',
  teams: 'команды',
  screens: 'параметры экранов и сохранённые JQL',
};

export function describePlan(plan: ImportPlan): string[] {
  const out: string[] = [];
  for (const [id, label] of Object.entries(PREF_SECTION_LABELS) as [SectionId, string][]) {
    if (SECTION_PREF_KEYS[id].some((k) => k in plan.prefs)) out.push(label);
  }
  if (plan.textTemplates.length || plan.wizardTemplates.length) out.push(`шаблоны: +${plan.textTemplates.length + plan.wizardTemplates.length}`);
  if (plan.meetingRules.length) out.push(`правила встреч: +${plan.meetingRules.length}`);
  if (plan.favoriteIssues.length) out.push(`избранное в мастере: +${plan.favoriteIssues.length}`);
  if (plan.customHolidays) out.push('дополнительные выходные');
  if (plan.scheduler) out.push('напоминание и автосинхронизация');
  const pending = plan.pendingJira.length + plan.pendingExchange.length;
  if (pending) out.push(`подключения к добавлению: ${pending}`);
  return out;
}
