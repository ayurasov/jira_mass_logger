import { invoke } from '@tauri-apps/api/core';

export type JiraInstanceType = 'cloud' | 'server';

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

export interface IssueDto { id: string; key: string; summary?: string | null; }
export interface WorklogDto { id: string; issueKey?: string | null; started: string; timeSpentSeconds: number; comment?: string | null; author?: string | null; }
export interface NewWorklogEntry { issueKey: string; startedAt: string; timeSpentSeconds: number; comment?: string | null; }
export interface BulkResultItem { issueKey: string; success: boolean; worklogId?: string | null; error?: string | null; attempts: number; }
export interface RecentIssue { issueKey: string; summary?: string | null; isFavorite: boolean; lastUsedAt: string; }
export interface WizardTemplate { id?: number; name: string; configJson: string; createdAt?: string | null; }

export const tauriApi = {
  getIssuesByJql(params: JiraConnectionParams, jql: string) { return invoke<IssueDto[]>('get_issues_by_jql', { params, jql }); },
  getWorklog(params: JiraConnectionParams, issueKey: string) { return invoke<WorklogDto[]>('get_worklog', { params, issueKey }); },
  bulkAddWorklogs(params: JiraConnectionParams, entries: NewWorklogEntry[]) { return invoke<BulkResultItem[]>('bulk_add_worklogs', { params, entries }); },
  getRecentIssues() { return invoke<RecentIssue[]>('get_recent_issues'); },
  touchRecentIssue(issueKey: string, summary?: string | null) { return invoke<void>('touch_recent_issue', { issueKey, summary }); },
  setIssueFavorite(issueKey: string, isFavorite: boolean) { return invoke<void>('set_issue_favorite', { issueKey, isFavorite }); },
  listWizardTemplates() { return invoke<WizardTemplate[]>('list_wizard_templates'); },
  saveWizardTemplate(name: string, configJson: string) { return invoke<number>('save_wizard_template', { name, configJson }); },
  deleteWizardTemplate(id: number) { return invoke<void>('delete_wizard_template', { id }); },
  getCustomHolidays() { return invoke<string[]>('get_custom_holidays'); },
  importHolidays(json: string) { return invoke<number>('import_holidays', { json }); },
  writeExportFile(path: string, content: string) { return invoke<void>('write_export_file', { path, content }); },
};
