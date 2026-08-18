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

export interface CalendarEventDto {
  id: string;
  subject: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  attendees: string[];
  category?: string | null;
  color?: string | null;
  onlineMeetingUrl?: string | null;
  responseStatus?: string | null;
  showAs?: string | null;
}

export interface GraphAuthStartResult {
  authUrl: string;
  state: string;
  redirectUrl: string;
  windowLabel: string;
  mode: string;
}

export interface GraphAuthCompleteResult {
  ok: boolean;
  message: string;
}

export interface ProjectDto { id: string; key: string; name: string; }
export interface IssueDto { id: string; key: string; summary?: string | null; }
export interface WorklogDto {
  id: string;
  issueKey?: string | null;
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
  author?: string | null;
  /** Метка последнего изменения записи в Jira, используется для optimistic concurrency. */
  updated?: string | null;
}
export interface NewWorklogEntry { issueKey: string; startedAt: string; timeSpentSeconds: number; comment?: string | null; }
export interface BulkResultItem { issueKey: string; success: boolean; worklogId?: string | null; error?: string | null; attempts: number; }
export interface RecentIssue { issueKey: string; summary?: string | null; isFavorite: boolean; lastUsedAt: string; }
export interface WizardTemplate { id?: number; name: string; configJson: string; createdAt?: string | null; }

export interface SyncQueueItem {
  id: number;
  rowKey: string;
  operation: 'update' | 'delete' | 'create' | 'duplicate';
  payloadJson: string;
  attempts: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CachedWorklogRow {
  rowKey: string;
  worklogId?: string | null;
  issueKey: string;
  issueSummary?: string | null;
  projectKey?: string | null;
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
  updated?: string | null;
  syncedAt?: string | null;
}

/** Ошибка конфликта версий: приходит из Rust как "CONFLICT:<json WorklogDto>". */
export function parseConflictError(error: unknown): WorklogDto | null {
  if (typeof error !== 'string' || !error.startsWith('CONFLICT:')) return null;
  try {
    return JSON.parse(error.slice('CONFLICT:'.length)) as WorklogDto;
  } catch {
    return null;
  }
}

export const tauriApi = {
  // --- Jira: справочники и поиск ---
  getProjects(params: JiraConnectionParams) { return invoke<ProjectDto[]>('get_projects', { params }); },
  getIssuesByJql(params: JiraConnectionParams, jql: string) { return invoke<IssueDto[]>('get_issues_by_jql', { params, jql }); },

  // --- Exchange / Outlook calendar ---
  testExchangeConnection(params: ExchangeConnectionParams) {
    return invoke<boolean>('test_exchange_connection', { params });
  },
  getCalendarEvents(params: ExchangeConnectionParams, dateFrom: string, dateTo: string, forceRefresh = false) {
    return invoke<CalendarEventDto[]>('get_calendar_events', { params, dateFrom, dateTo, forceRefresh });
  },
  startGraphOauthEmbedded(params: ExchangeConnectionParams) {
    return invoke<GraphAuthStartResult>('start_graph_oauth_embedded', { params });
  },
  completeGraphOauthLoopback() {
    return invoke<GraphAuthCompleteResult>('complete_graph_oauth_loopback');
  },

  // --- Jira: worklog CRUD + инкрементальный sync ---
  getWorklog(params: JiraConnectionParams, issueKey: string) { return invoke<WorklogDto[]>('get_worklog', { params, issueKey }); },
  getWorklogById(params: JiraConnectionParams, issueKey: string, worklogId: string) {
    return invoke<WorklogDto>('get_worklog_by_id', { params, issueKey, worklogId });
  },
  getWorklogsSince(params: JiraConnectionParams, sinceEpochMillis: number, issueKeysForFallback?: string[]) {
    return invoke<WorklogDto[]>('get_worklogs_since', { params, sinceEpochMillis, issueKeysForFallback });
  },
  addWorklog(params: JiraConnectionParams, issueKey: string, startedAt: string, timeSpentSeconds: number, comment?: string | null) {
    return invoke<string>('add_worklog', { params, issueKey, startedAt, timeSpentSeconds, comment });
  },
  updateWorklog(
    params: JiraConnectionParams,
    issueKey: string,
    worklogId: string,
    opts: { startedAt?: string | null; timeSpentSeconds?: number | null; comment?: string | null; expectedUpdated?: string | null },
  ) {
    return invoke<void>('update_worklog', {
      params,
      issueKey,
      worklogId,
      startedAt: opts.startedAt ?? null,
      timeSpentSeconds: opts.timeSpentSeconds ?? null,
      comment: opts.comment ?? null,
      expectedUpdated: opts.expectedUpdated ?? null,
    });
  },
  deleteWorklog(params: JiraConnectionParams, issueKey: string, worklogId: string, expectedUpdated?: string | null) {
    return invoke<void>('delete_worklog', { params, issueKey, worklogId, expectedUpdated: expectedUpdated ?? null });
  },
  bulkAddWorklogs(params: JiraConnectionParams, entries: NewWorklogEntry[]) { return invoke<BulkResultItem[]>('bulk_add_worklogs', { params, entries }); },

  // --- Bulk wizard вспомогательные ---
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

  // --- Локальный кэш и очередь несинхронизированных изменений (экран "Мой worklog") ---
  listCachedWorklogs(fromDate: string, toDate: string) { return invoke<CachedWorklogRow[]>('list_cached_worklogs', { fromDate, toDate }); },
  upsertCachedWorklog(row: CachedWorklogRow) { return invoke<void>('upsert_cached_worklog', { row }); },
  deleteCachedWorklog(rowKey: string) { return invoke<void>('delete_cached_worklog', { rowKey }); },
  enqueueSyncOperation(rowKey: string, operation: SyncQueueItem['operation'], payloadJson: string) {
    return invoke<number>('enqueue_sync_operation', { rowKey, operation, payloadJson });
  },
  listSyncQueue() { return invoke<SyncQueueItem[]>('list_sync_queue'); },
  markSyncAttemptFailed(id: number, error: string) { return invoke<void>('mark_sync_attempt_failed', { id, error }); },
  removeSyncQueueItem(id: number) { return invoke<void>('remove_sync_queue_item', { id }); },
  clearSyncQueue() { return invoke<void>('clear_sync_queue'); },
};
