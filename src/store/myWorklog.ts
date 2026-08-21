// Pinia-стор экрана "Мой worklog": редактируемая таблица с оптимистичным UI,
// очередью несинхронизированных изменений и обработкой конфликтов версий.
//
// Стратегия синхронизации:
//  - локальный кэш (worklog_cache) — источник данных для UI, чтобы экран открывался
//    мгновенно даже без сети;
//  - `fetchFromJira` тянет `getWorklogsSince` с watermark в localStorage (не "since = now",
//    а с небольшим отступом назад, т.к. Jira `worklog/updated` может не включать
//    изменения за последнюю минуту);
//  - любая правка ячейки сначала меняет локальный кэш (optimistic), затем либо
//    сразу ушлёт в Jira (online), либо встаёт в sync_queue (offline/ошибка сети);
//  - при ошибке сети локальное изменение НЕ отменяется — оно остаётся в sync_queue
//    и повторяется автоматически; только реальная ошибка валидации/прав даёт rollback;
//  - конфликт версий (409-подобный случай через сравнение `updated`) не отменяет
//    правку автоматически, а кладёт зайчу (актуальная версия из Jira + локальная)
//    в `pendingConflict`, который показывает diff-диалог в UI.
import { defineStore } from 'pinia';
import { tauriApi, parseConflictError, type WorklogDto, type JiraConnectionParams, type CachedWorklogRow } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { getIsoWeek } from '../utils/worklogText';

export interface WorklogRow {
  rowKey: string;
  worklogId?: string | null;
  issueKey: string;
  issueSummary?: string | null;
  projectKey?: string | null;
  date: string; // YYYY-MM-DD, производное от started
  weekday: number; // 0..6, Date.getDay()
  isoWeek: string;
  started: string; // полная отметка времени старта, как пришла из Jira
  hours: number;
  comment: string;
  updated?: string | null;
  syncStatus: 'synced' | 'pending' | 'error' | 'local-only';
  syncError?: string | null;
}

function rowKeyOf(worklogId: string | null | undefined, issueKey: string, started: string): string {
  return worklogId ? `wl:${worklogId}` : `local:${issueKey}:${started}:${Math.random().toString(36).slice(2, 8)}`;
}

function dtoToRow(dto: WorklogDto, projectKey?: string | null, issueSummary?: string | null): WorklogRow {
  const started = dto.started;
  const date = started.slice(0, 10);
  const weekday = new Date(started).getDay();
  return {
    rowKey: rowKeyOf(dto.id, dto.issueKey ?? '', started),
    worklogId: dto.id,
    issueKey: dto.issueKey ?? '',
    issueSummary,
    projectKey: projectKey ?? (dto.issueKey ? dto.issueKey.split('-')[0] : null),
    date,
    weekday,
    isoWeek: getIsoWeek(date),
    started,
    hours: Math.round((dto.timeSpentSeconds / 3600) * 100) / 100,
    comment: dto.comment ?? '',
    updated: dto.updated,
    syncStatus: 'synced',
  };
}

function cachedToRow(row: CachedWorklogRow): WorklogRow {
  const date = row.started.slice(0, 10);
  return {
    rowKey: row.rowKey,
    worklogId: row.worklogId,
    issueKey: row.issueKey,
    issueSummary: row.issueSummary,
    projectKey: row.projectKey,
    date,
    weekday: new Date(row.started).getDay(),
    isoWeek: getIsoWeek(date),
    started: row.started,
    hours: Math.round((row.timeSpentSeconds / 3600) * 100) / 100,
    comment: row.comment ?? '',
    updated: row.updated,
    syncStatus: row.worklogId ? 'synced' : 'local-only',
  };
}

function rowToCached(row: WorklogRow): CachedWorklogRow {
  return {
    rowKey: row.rowKey,
    worklogId: row.worklogId,
    issueKey: row.issueKey,
    issueSummary: row.issueSummary,
    projectKey: row.projectKey,
    started: row.started,
    timeSpentSeconds: Math.round(row.hours * 3600),
    comment: row.comment,
    updated: row.updated,
  };
}

export const useMyWorklogStore = defineStore('myWorklog', {
  state: () => ({
    rows: [] as WorklogRow[],
    loading: false,
    isOnline: navigator.onLine,
    lastSyncedAt: localStorage.getItem('jiratime-worklog-last-sync') || null,
    filters: {
      fromDate: '',
      toDate: '',
      issueKey: '',
      projectKey: '',
      searchText: '',
    },
    pendingConflict: null as { local: WorklogRow; remote: WorklogDto } | null,
    autoSyncTimer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    filteredRows(state): WorklogRow[] {
      const { issueKey, projectKey, searchText, fromDate, toDate } = state.filters;
      return state.rows.filter((r) => {
        if (issueKey && !r.issueKey.toLowerCase().includes(issueKey.toLowerCase())) return false;
        if (projectKey && r.projectKey !== projectKey) return false;
        if (fromDate && r.date < fromDate) return false;
        if (toDate && r.date > toDate) return false;
        if (searchText && !r.comment.toLowerCase().includes(searchText.toLowerCase())) return false;
        return true;
      });
    },
    hasPendingSync(state): boolean {
      return state.rows.some((r) => r.syncStatus === 'pending' || r.syncStatus === 'local-only');
    },
  },
  actions: {
    activeConnectionParams(): JiraConnectionParams | null {
      // Переиспользуем геттер из jiraProfiles-стора — он правильно учитывает
      // isActive-флаг и authType==='server_basic'. Раньше тут было profiles[0],
      // что брало вообще первый профиль (игнорируя активный) и всегда отправляло
      // server_basic-профиль как Bearer PAT → 401/не вижу свои часы.
      const profiles = useJiraProfilesStore();
      return profiles.activeConnectionParams;
    },

    async loadFromCache() {
      const cached = await tauriApi.listCachedWorklogs(this.filters.fromDate || '1970-01-01', this.filters.toDate || '2999-12-31');
      this.rows = cached.map(cachedToRow);
    },

    async fetchFromJira(force = false) {
      const params = this.activeConnectionParams();
      if (!params) return;
      this.loading = true;
      try {
        // Watermark привязан к профилю + версиям схемы. Если раньше «успешный» пустой
        // sync записал 0 и потом фильтр отрезал все записи — новый watermark-v2
        // заставит пересинхронизировать с since=0 при первом запуске после обновления.
        const watermarkKey = `jiratime-worklog-watermark-v2-${params.baseUrl}-${params.email}-${params.instanceType}`;
        const since = force ? 0 : Number(localStorage.getItem(watermarkKey) ?? '0');
        // issue_keys_for_fallback нужен только для старых Jira Server (<7.6) без bulk
        // worklog/updated — бэкенд сам переключится на перебор по этим ключам, если
        // bulk-эндпоинт недоступен. Для Cloud и современного Server он не используется.
        const cachedKeys = new Set(this.rows.map((r) => r.issueKey).filter(Boolean));
        if (this.filters.issueKey) cachedKeys.add(this.filters.issueKey);
        const issueKeysForFallback = Array.from(cachedKeys);
        const dtos = await tauriApi.getWorklogsSince(params, since, issueKeysForFallback);
        for (const dto of dtos) {
          const row = dtoToRow(dto);
          await tauriApi.upsertCachedWorklog(rowToCached(row));
        }
        localStorage.setItem(watermarkKey, String(Date.now()));
        localStorage.setItem('jiratime-worklog-last-sync', new Date().toISOString());
        this.lastSyncedAt = new Date().toISOString();
        await this.loadFromCache();
      } finally {
        this.loading = false;
      }
      await this.drainSyncQueue();
    },

    async editRow(rowKey: string, patch: Partial<Pick<WorklogRow, 'hours' | 'comment' | 'started'>>) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      const previous = { ...row };
      Object.assign(row, patch);
      row.syncStatus = 'pending';
      await tauriApi.upsertCachedWorklog(rowToCached(row));

      const params = this.activeConnectionParams();
      if (!params || !row.worklogId) {
        row.syncStatus = 'local-only';
        return;
      }
      if (!this.isOnline) {
        await this.queueOffline(row, 'update');
        return;
      }
      try {
        await tauriApi.updateWorklog(params, row.issueKey, row.worklogId, {
          startedAt: patch.started ? new Date(patch.started).toISOString() : undefined,
          timeSpentSeconds: patch.hours !== undefined ? Math.round(row.hours * 3600) : undefined,
          comment: patch.comment,
          expectedUpdated: previous.updated,
        });
        const fresh = await tauriApi.getWorklogById(params, row.issueKey, row.worklogId);
        row.updated = fresh.updated;
        row.syncStatus = 'synced';
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      } catch (err) {
        const conflict = parseConflictError(err);
        if (conflict) {
          this.pendingConflict = { local: { ...row }, remote: conflict };
          row.syncStatus = 'error';
          row.syncError = 'Конфликт версий: запись изменена в Jira';
          return;
        }
        // rollback при ошибке валидации/прав (не сетевой)
        Object.assign(row, previous);
        row.syncStatus = 'error';
        row.syncError = String(err);
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
    },

    async deleteRow(rowKey: string) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      this.rows = this.rows.filter((r) => r.rowKey !== rowKey);
      await tauriApi.deleteCachedWorklog(rowKey);

      const params = this.activeConnectionParams();
      if (!params || !row.worklogId) return;
      if (!this.isOnline) {
        await this.queueOffline(row, 'delete');
        return;
      }
      try {
        await tauriApi.deleteWorklog(params, row.issueKey, row.worklogId, row.updated);
      } catch (err) {
        const conflict = parseConflictError(err);
        if (conflict) {
          this.pendingConflict = { local: row, remote: conflict };
          this.rows.push(row);
          await tauriApi.upsertCachedWorklog(rowToCached(row));
          return;
        }
        // rollback: вернуть строку и пометить ошибку
        row.syncStatus = 'error';
        row.syncError = String(err);
        this.rows.push(row);
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
    },

    async duplicateRow(rowKey: string, newDate: string) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      const newStarted = row.started.replace(row.date, newDate);
      const newRow: WorklogRow = {
        ...row,
        rowKey: rowKeyOf(null, row.issueKey, newStarted),
        worklogId: null,
        date: newDate,
        weekday: new Date(newStarted).getDay(),
        isoWeek: getIsoWeek(newDate),
        started: newStarted,
        syncStatus: 'pending',
      };
      this.rows.push(newRow);
      await tauriApi.upsertCachedWorklog(rowToCached(newRow));

      const params = this.activeConnectionParams();
      if (!params) { newRow.syncStatus = 'local-only'; return; }
      if (!this.isOnline) { await this.queueOffline(newRow, 'create'); return; }
      try {
        const id = await tauriApi.addWorklog(params, newRow.issueKey, new Date(newStarted).toISOString(), Math.round(newRow.hours * 3600), newRow.comment);
        newRow.worklogId = id;
        newRow.syncStatus = 'synced';
        await tauriApi.upsertCachedWorklog(rowToCached(newRow));
      } catch (err) {
        newRow.syncStatus = 'error';
        newRow.syncError = String(err);
        await tauriApi.upsertCachedWorklog(rowToCached(newRow));
      }
    },

    async resolveConflict(resolution: 'keep-local' | 'keep-remote') {
      if (!this.pendingConflict) return;
      const { local, remote } = this.pendingConflict;
      const params = this.activeConnectionParams();
      const row = this.rows.find((r) => r.rowKey === local.rowKey);
      if (resolution === 'keep-remote') {
        if (row) {
          Object.assign(row, dtoToRow(remote), { rowKey: local.rowKey });
          await tauriApi.upsertCachedWorklog(rowToCached(row));
        }
      } else if (resolution === 'keep-local' && params && row && row.worklogId) {
        await tauriApi.updateWorklog(params, row.issueKey, row.worklogId, {
          timeSpentSeconds: Math.round(row.hours * 3600),
          comment: row.comment,
          expectedUpdated: remote.updated,
        });
        const fresh = await tauriApi.getWorklogById(params, row.issueKey, row.worklogId);
        row.updated = fresh.updated;
        row.syncStatus = 'synced';
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
      this.pendingConflict = null;
    },

    async queueOffline(row: WorklogRow, operation: 'update' | 'delete' | 'create' | 'duplicate') {
      row.syncStatus = 'pending';
      await tauriApi.enqueueSyncOperation(row.rowKey, operation, JSON.stringify(rowToCached(row)));
    },

    async drainSyncQueue() {
      if (!this.isOnline) return;
      const params = this.activeConnectionParams();
      if (!params) return;
      const queue = await tauriApi.listSyncQueue();
      for (const item of queue) {
        try {
          const payload = JSON.parse(item.payloadJson) as CachedWorklogRow;
          if (item.operation === 'update' && payload.worklogId) {
            await tauriApi.updateWorklog(params, payload.issueKey, payload.worklogId, {
              timeSpentSeconds: payload.timeSpentSeconds,
              comment: payload.comment,
              expectedUpdated: payload.updated,
            });
          } else if (item.operation === 'delete' && payload.worklogId) {
            await tauriApi.deleteWorklog(params, payload.issueKey, payload.worklogId, payload.updated);
          } else if (item.operation === 'create' || item.operation === 'duplicate') {
            const id = await tauriApi.addWorklog(params, payload.issueKey, payload.started, payload.timeSpentSeconds, payload.comment);
            payload.worklogId = id;
            await tauriApi.upsertCachedWorklog(payload);
          }
          await tauriApi.removeSyncQueueItem(item.id);
        } catch (err) {
          await tauriApi.markSyncAttemptFailed(item.id, String(err));
        }
      }
      await this.loadFromCache();
    },

    setupNetworkListeners() {
      window.addEventListener('online', () => { this.isOnline = true; this.drainSyncQueue(); });
      window.addEventListener('offline', () => { this.isOnline = false; });
    },

    startAutoSync() {
      const settings = useSettingsStore();
      this.stopAutoSync();
      if (!settings.autoSyncEnabled) return;
      this.autoSyncTimer = setInterval(() => {
        this.fetchFromJira(false);
      }, Math.max(1, settings.autoSyncIntervalMinutes) * 60_000);
    },

    stopAutoSync() {
      if (this.autoSyncTimer) {
        clearInterval(this.autoSyncTimer);
        this.autoSyncTimer = null;
      }
    },
  },
});
