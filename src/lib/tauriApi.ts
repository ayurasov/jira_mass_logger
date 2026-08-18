import { invoke } from '@tauri-apps/api/core';

export type JiraInstanceType = 'cloud' | 'server';
export type ExchangeAuthMode = 'graph' | 'ews';
export type EwsAuthType = 'basic' | 'ntlm';

export interface ProxyConfig {
  url?: string | null;
  username?: string | null;
  password?: string | null;
}

export interface JiraConnectionParams {
  baseUrl: string;
  email: string;
  secretRef: string;
  instanceType: JiraInstanceType;
  extraRootCaPemPath?: string | null;
  proxy?: ProxyConfig | null;
  userTimezone?: string | null;
}

export interface ExchangeConnectionParams {
  authMode: ExchangeAuthMode;
  ewsUrl?: string | null;
  username: string;
  secretRef: string;
  tenantId?: string | null;
  clientId?: string | null;
  refreshTokenSecretRef?: string | null;
  minEventMinutes?: number | null;
  excludeFreeBusy?: boolean | null;
  excludeDeclined?: boolean | null;
  ewsAuthType?: EwsAuthType | null;
}

export interface ExchangeProfileDto {
  id?: number | null;
  name: string;
  authMode: ExchangeAuthMode;
  ewsUrl?: string | null;
  ewsAuthType?: EwsAuthType | null;
  username: string;
  secretRef: string;
  tenantId?: string | null;
  clientId?: string | null;
  refreshTokenSecretRef?: string | null;
  minEventMinutes?: number | null;
  excludeFreeBusy?: boolean | null;
  excludeDeclined?: boolean | null;
  isActive?: boolean | null;
}

export function profileToConnectionParams(p: ExchangeProfileDto): ExchangeConnectionParams {
  return {
    authMode: p.authMode, ewsUrl: p.ewsUrl, username: p.username, secretRef: p.secretRef,
    tenantId: p.tenantId, clientId: p.clientId, refreshTokenSecretRef: p.refreshTokenSecretRef,
    minEventMinutes: p.minEventMinutes, excludeFreeBusy: p.excludeFreeBusy,
    excludeDeclined: p.excludeDeclined, ewsAuthType: p.ewsAuthType,
  };
}

export interface CalendarEventDto {
  id: string; subject: string; startAt: string; endAt: string;
  durationMinutes: number; attendees: string[];
  category?: string | null; color?: string | null;
  onlineMeetingUrl?: string | null; responseStatus?: string | null; showAs?: string | null;
  seriesMasterId?: string | null;
}

export interface GraphAuthStartResult { authUrl: string; state: string; redirectUrl: string; windowLabel: string; mode: string; }
export interface GraphAuthCompleteResult { ok: boolean; message: string; }

export interface ProjectDto { id: string; key: string; name: string; }
export interface IssueDto { id: string; key: string; summary?: string | null; }
export interface WorklogDto {
  id: string; issueKey?: string | null; started: string;
  timeSpentSeconds: number; comment?: string | null;
  author?: string | null; updated?: string | null;
}
export interface NewWorklogEntry { issueKey: string; startedAt: string; timeSpentSeconds: number; comment?: string | null; }
export interface BulkResultItem { issueKey: string; success: boolean; worklogId?: string | null; error?: string | null; attempts: number; }
export interface RecentIssue { issueKey: string; summary?: string | null; isFavorite: boolean; lastUsedAt: string; }
export interface WizardTemplate { id?: number; name: string; configJson: string; createdAt?: string | null; }

export interface SyncQueueItem {
  id: number; rowKey: string;
  operation: 'update' | 'delete' | 'create' | 'duplicate';
  payloadJson: string; attempts: number; lastError?: string | null;
  createdAt: string; updatedAt: string;
}

export interface CachedWorklogRow {
  rowKey: string; worklogId?: string | null; issueKey: string;
  issueSummary?: string | null; projectKey?: string | null;
  started: string; timeSpentSeconds: number; comment?: string | null;
  updated?: string | null; syncedAt?: string | null;
}

// ─── Meeting rules ────────────────────────────────────────────────────
export interface MeetingMatchRule {
  id?: number | null; name: string; kind: string;
  pattern: string; issueKey: string; priority: number; isActive: boolean;
}
export interface MeetingIssueHistoryEntry {
  seriesKey: string; issueKey: string; issueSummary?: string | null;
  lastUsedAt: string; useCount: number;
}
export interface MatchSuggestion {
  issueKey?: string | null; issueSummary?: string | null;
  source: 'history' | 'rule' | 'prefix' | 'none';
  matchedRuleName?: string | null;
}

// ─── Prompt 7: Settings types ────────────────────────────────────────
export interface AppSettings {
  workHoursPerDay: number;
  /** 1=Mon..7=Sun (ISO) */
  workDays: number[];
  timezone: string;
  notifyEndOfDay: boolean;
  notifyEndOfDayTime: string;
  notifyEndOfWeek: boolean;
  notifyEndOfWeekTime: string;
  closeToTray: boolean;
  autostart: boolean;
  holidayCountry: string;
}

export interface DescriptionTemplate {
  id?: number | null;
  name: string;
  /** Переменные: {date}, {issue}, {week_number}, {meeting_title} */
  body: string;
  useCount: number;
}

export interface FavoriteIssue {
  issueKey: string;
  summary?: string | null;
  lastUsedAt: string;
}

export interface JiraProfileDto {
  id?: number | null;
  name: string;
  baseUrl: string;
  email: string;
  secretRef: string;
  instanceType: JiraInstanceType;
  extraRootCaPemPath?: string | null;
  proxyUrl?: string | null;
  proxyUsername?: string | null;
  proxySecretRef?: string | null;
  userTimezone?: string | null;
  isActive: boolean;
}

export function parseConflictError(error: unknown): WorklogDto | null {
  if (typeof error !== 'string' || !error.startsWith('CONFLICT:')) return null;
  try { return JSON.parse(error.slice('CONFLICT:'.length)) as WorklogDto; } catch { return null; }
}

export const tauriApi = {
  // --- Jira: справочники ---
  getProjects(params: JiraConnectionParams) { return invoke<ProjectDto[]>('get_projects', { params }); },
  getIssuesByJql(params: JiraConnectionParams, jql: string) { return invoke<IssueDto[]>('get_issues_by_jql', { params, jql }); },
  testConnection(params: JiraConnectionParams) { return invoke<boolean>('test_connection', { params }); },

  // --- Jira profiles (DB) ---
  listJiraProfiles() { return invoke<JiraProfileDto[]>('list_jira_profiles'); },
  saveJiraProfile(profile: JiraProfileDto) { return invoke<number>('save_jira_profile', { profile }); },
  deleteJiraProfile(id: number) { return invoke<boolean>('delete_jira_profile', { id }); },
  setActiveJiraProfile(id: number) { return invoke<void>('set_active_jira_profile', { id }); },

  // --- Exchange / Outlook ---
  listExchangeProfiles() { return invoke<ExchangeProfileDto[]>('list_exchange_profiles'); },
  saveExchangeProfile(profile: ExchangeProfileDto) { return invoke<number>('save_exchange_profile', { profile }); },
  deleteExchangeProfile(id: number) { return invoke<boolean>('delete_exchange_profile', { id }); },
  testExchangeConnection(params: ExchangeConnectionParams) { return invoke<boolean>('test_exchange_connection', { params }); },
  getCalendarEvents(params: ExchangeConnectionParams, dateFrom: string, dateTo: string, forceRefresh = false) {
    return invoke<CalendarEventDto[]>('get_calendar_events', { params, dateFrom, dateTo, forceRefresh });
  },
  startGraphOauthEmbedded(params: ExchangeConnectionParams) { return invoke<GraphAuthStartResult>('start_graph_oauth_embedded', { params }); },
  completeGraphOauthLoopback() { return invoke<GraphAuthCompleteResult>('complete_graph_oauth_loopback'); },

  // --- Jira: worklog CRUD ---
  getWorklog(params: JiraConnectionParams, issueKey: string) { return invoke<WorklogDto[]>('get_worklog', { params, issueKey }); },
  getWorklogById(params: JiraConnectionParams, issueKey: string, worklogId: string) { return invoke<WorklogDto>('get_worklog_by_id', { params, issueKey, worklogId }); },
  getWorklogsSince(params: JiraConnectionParams, sinceEpochMillis: number, issueKeysForFallback?: string[]) {
    return invoke<WorklogDto[]>('get_worklogs_since', { params, sinceEpochMillis, issueKeysForFallback });
  },
  addWorklog(params: JiraConnectionParams, issueKey: string, startedAt: string, timeSpentSeconds: number, comment?: string | null) {
    return invoke<string>('add_worklog', { params, issueKey, startedAt, timeSpentSeconds, comment });
  },
  updateWorklog(params: JiraConnectionParams, issueKey: string, worklogId: string, opts: { startedAt?: string | null; timeSpentSeconds?: number | null; comment?: string | null; expectedUpdated?: string | null }) {
    return invoke<void>('update_worklog', { params, issueKey, worklogId, ...opts });
  },
  deleteWorklog(params: JiraConnectionParams, issueKey: string, worklogId: string, expectedUpdated?: string | null) {
    return invoke<void>('delete_worklog', { params, issueKey, worklogId, expectedUpdated: expectedUpdated ?? null });
  },
  bulkAddWorklogs(params: JiraConnectionParams, entries: NewWorklogEntry[]) { return invoke<BulkResultItem[]>('bulk_add_worklogs', { params, entries }); },

  // --- Bulk wizard ---
  getRecentIssues() { return invoke<RecentIssue[]>('get_recent_issues'); },
  touchRecentIssue(issueKey: string, summary?: string | null) { return invoke<void>('touch_recent_issue', { issueKey, summary }); },
  setIssueFavorite(issueKey: string, isFavorite: boolean) { return invoke<void>('set_issue_favorite', { issueKey, isFavorite }); },
  listWizardTemplates() { return invoke<WizardTemplate[]>('list_wizard_templates'); },
  saveWizardTemplate(name: string, configJson: string) { return invoke<number>('save_wizard_template', { name, configJson }); },
  deleteWizardTemplate(id: number) { return invoke<void>('delete_wizard_template', { id }); },
  getCustomHolidays() { return invoke<string[]>('get_custom_holidays'); },
  importHolidays(json: string) { return invoke<number>('import_holidays', { json }); },
  writeExportFile(path: string, content: string) { return invoke<void>('write_export_file', { path, content }); },
  writeExportFileUtf8Bom(path: string, content: string) { return invoke<void>('write_export_file_utf8_bom', { path, content }); },

  // --- Local cache ---
  listCachedWorklogs(fromDate: string, toDate: string) { return invoke<CachedWorklogRow[]>('list_cached_worklogs', { fromDate, toDate }); },
  upsertCachedWorklog(row: CachedWorklogRow) { return invoke<void>('upsert_cached_worklog', { row }); },
  deleteCachedWorklog(rowKey: string) { return invoke<void>('delete_cached_worklog', { rowKey }); },
  enqueueSyncOperation(rowKey: string, operation: SyncQueueItem['operation'], payloadJson: string) { return invoke<number>('enqueue_sync_operation', { rowKey, operation, payloadJson }); },
  listSyncQueue() { return invoke<SyncQueueItem[]>('list_sync_queue'); },
  markSyncAttemptFailed(id: number, error: string) { return invoke<void>('mark_sync_attempt_failed', { id, error }); },
  removeSyncQueueItem(id: number) { return invoke<void>('remove_sync_queue_item', { id }); },
  clearSyncQueue() { return invoke<void>('clear_sync_queue'); },

  // --- Meeting rules ---
  suggestIssueForMeeting(subject: string, seriesMasterId: string | null) { return invoke<MatchSuggestion>('suggest_issue_for_meeting', { subject, seriesMasterId }); },
  rememberMeetingIssueMatch(subject: string, seriesMasterId: string | null, issueKey: string, issueSummary: string | null) { return invoke<void>('remember_meeting_issue_match', { subject, seriesMasterId, issueKey, issueSummary }); },
  listMeetingMatchRules() { return invoke<MeetingMatchRule[]>('list_meeting_match_rules'); },
  saveMeetingMatchRule(rule: MeetingMatchRule) { return invoke<number>('save_meeting_match_rule', { rule }); },
  deleteMeetingMatchRule(id: number) { return invoke<void>('delete_meeting_match_rule', { id }); },
  getMeetingIssueHistory() { return invoke<MeetingIssueHistoryEntry[]>('get_meeting_issue_history'); },

  // --- Prompt 7: App settings ---
  getAppSettings() { return invoke<AppSettings>('get_app_settings'); },
  setAppSettings(settings: AppSettings) { return invoke<void>('set_app_settings', { settings }); },
  openDataFolder() { return invoke<void>('open_data_folder'); },
  exportSettingsDialog() { return invoke<boolean>('export_settings_dialog'); },
  importSettingsDialog() { return invoke<boolean>('import_settings_dialog'); },

  // --- Description templates ---
  listDescriptionTemplates() { return invoke<DescriptionTemplate[]>('list_description_templates'); },
  saveDescriptionTemplate(template: DescriptionTemplate) { return invoke<number>('save_description_template', { template }); },
  deleteDescriptionTemplate(id: number) { return invoke<void>('delete_description_template', { id }); },
  useDescriptionTemplate(id: number) { return invoke<string>('use_description_template', { id }); },
  renderDescriptionTemplate(body: string, date?: string | null, issue?: string | null, meetingTitle?: string | null) {
    return invoke<string>('render_description_template', { body, date: date ?? null, issue: issue ?? null, meetingTitle: meetingTitle ?? null });
  },

  // --- Favorite issues ---
  listFavoriteIssues() { return invoke<FavoriteIssue[]>('list_favorite_issues'); },

  // --- Secrets ---
  saveSecret(secretRef: string, value: string) { return invoke<void>('save_secret', { secretRef, value }); },
  deleteSecret(secretRef: string) { return invoke<void>('delete_secret', { secretRef }); },

  profileToConnectionParams,
};
